/**
 * Parser for EU Formex (FMX) XML format.
 *
 * Formex is the XML schema used by the EU Publications Office for the
 * Official Journal.  This parser extracts articles, recitals, definitions,
 * chapter/section hierarchy **and cross-references** from FMX documents,
 * returning the same shape consumed by the rest of the app plus a
 * `crossReferences` map.
 *
 * Cross-references are extracted in three ways:
 *  1. Structural: <REF.DOC.OJ> elements → external OJ references (language-independent)
 *  2. Textual:    Language-specific "Article N" / "Artikel N" etc. patterns in prose
 *  3. Textual:    Recital reference patterns in each language
 */

import { getLangConfig, buildMeansRegex, buildFallbackDefRegex } from "./languages.mjs";
import { buildEurlexSearchUrl } from "./url.mjs";
import {
  ACT_CELEX_MAP,
  MAX_ARTICLE_ACT_BRIDGE,
  bindArticleRefsToExternalRefs,
  bindThereofArticleRefs,
  enforceInternalReferenceIntegrity,
  isArticleOfActBridge as coreIsArticleOfActBridge,
  parseInstrumentIdentifier,
  referenceDedupeKey,
  resolveInstrumentCelex,
  scanArticleEnumerations as scanSharedArticleEnumerations,
  stripInvalidArticleLinks,
} from "../legal-reference-core.mjs";

/**
 * Bump this whenever the parser output changes (new fields, bug fixes, etc.)
 * so that cached parsed results are automatically re-parsed from raw XML.
 */
export const PARSER_VERSION = 19;

// ---------------------------------------------------------------------------
// FMX → HTML conversion helpers
// ---------------------------------------------------------------------------

/** Recursively collect all text from an Element (ignoring tags). */
function allText(el) {
  if (!el) return "";
  const parts = [];
  for (const n of el.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) {
      const text = n.textContent?.trim();
      if (text) parts.push(text);
    }
    else if (n.nodeType === Node.ELEMENT_NODE) {
      // Preserve FMX quote marks as actual characters
      if (n.tagName === "QUOT.START") { parts.push("\u2018"); continue; }
      if (n.tagName === "QUOT.END") { parts.push("\u2019"); continue; }
      const text = allText(n);
      if (text) parts.push(text);
    }
  }
  return parts
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([([])\s+/g, "$1")
    .replace(/\s+([)\]])/g, "$1")
    .trim();
}

function inferHtmlListTag(listType = "") {
  const type = String(listType).toUpperCase();
  if (type === "DASH") return "ul";
  return "ol";
}

function inferListStyleClass(listType = "") {
  const type = String(listType).toUpperCase();
  if (type === "DASH") return "fmx-list-disc";
  if (type === "ALPHA") return "fmx-list-lower-alpha";
  if (type === "ARAB") return "fmx-list-decimal";
  return "";
}

function inferMarkerListMeta(marker = "") {
  const value = String(marker).trim();
  if (/^\d+(?:\.\d+)*\.?$/i.test(value)) {
    return { tag: "ol", className: "fmx-list fmx-list-decimal" };
  }
  if (/^\(?[a-z]\)$/i.test(value)) {
    return { tag: "ol", className: "fmx-list fmx-list-lower-alpha" };
  }
  if (/^\(?[ivxlcdm]+\)$/i.test(value)) {
    return { tag: "ol", className: "fmx-list fmx-list-lower-roman" };
  }
  return null;
}

function renderListItem(itemEl, ctx) {
  const np = Array.from(itemEl.children).find((child) => child.tagName === "NP");
  if (np) return fmxToHtml(np, ctx);

  const bodyHtml = childrenHtml(itemEl, ctx);
  return `<li class="fmx-list-item">${bodyHtml}</li>`;
}

function renderNpListItem(npEl, ctx) {
  const numHtml = fmxToHtml(npEl.querySelector("NO\\.P"), ctx);
  const bodyHtml = childrenHtmlExcept(npEl, "NO.P", ctx);
  const marker = allText(npEl.querySelector("NO\\.P"));
  return `<li class="fmx-list-item" data-marker="${escapeHtml(marker)}"><span class="fmx-list-item-num">${numHtml}</span><div class="fmx-list-item-body">${bodyHtml}</div></li>`;
}

function renderNumberedGroup(npElements, ctx) {
  const firstMarker = allText(npElements[0]?.querySelector("NO\\.P"));
  const meta = inferMarkerListMeta(firstMarker);
  if (!meta) {
    return `<div class="fmx-numbered-group">${npElements.map((npEl) => fmxToHtml(npEl, ctx)).join("")}</div>`;
  }
  return `<${meta.tag} class="${meta.className}">${npElements.map((npEl) => renderNpListItem(npEl, ctx)).join("")}</${meta.tag}>`;
}

/**
 * Convert an FMX XML element tree into displayable HTML.
 *
 * Handles: P, TXT, LIST/ITEM/NP/NO.P, PARAG/NO.PARAG, ALINEA,
 *          NOTE/FOOTNOTE, HT (highlight), QUOT.START/QUOT.END,
 *          REF.DOC.OJ, DATE, and nested structures.
 */
function fmxToHtml(el, ctx = null) {
  if (!el) return "";
  if (el.nodeType === Node.TEXT_NODE) return escapeHtml(el.textContent);

  const tag = el.tagName;

  // Quote markers → actual quote characters
  if (tag === "QUOT.START") return "\u2018";
  if (tag === "QUOT.END") return "\u2019";

  // Highlighting
  if (tag === "HT") {
    const type = el.getAttribute("TYPE");
    if (type === "UC") return `<span class="uppercase">${childrenHtml(el, ctx)}</span>`;
    if (type === "BOLD") return `<strong>${childrenHtml(el, ctx)}</strong>`;
    if (type === "ITALIC") return `<em>${childrenHtml(el, ctx)}</em>`;
    if (type === "SUB") return `<sub>${childrenHtml(el, ctx)}</sub>`;
    if (type === "SUP") return `<sup>${childrenHtml(el, ctx)}</sup>`;
    return childrenHtml(el, ctx);
  }

  // Date
  if (tag === "DATE") return childrenHtml(el, ctx);

  // External OJ reference — render as a styled span with OJ citation text
  if (tag === "REF.DOC.OJ" || tag === "REF.DOC") {
    const coll = el.getAttribute("COLL") || "";
    const no = el.getAttribute("NO.OJ") || "";
    const date = el.getAttribute("DATE.PUB") || "";
    const page = el.getAttribute("PAGE.FIRST") || "";
    // Build EUR-Lex OJ link if we have enough data
    if (coll && no && date) {
      const year = date.slice(0, 4);
      return `<span class="oj-ref" data-oj-coll="${escapeHtml(coll)}" data-oj-no="${escapeHtml(no)}" data-oj-year="${escapeHtml(year)}" data-oj-page="${escapeHtml(page)}">${childrenHtml(el, ctx)}</span>`;
    }
    return `<span class="oj-ref">${childrenHtml(el, ctx)}</span>`;
  }

  // FT — formatted text (e.g. numbers with spaces)
  if (tag === "FT") return childrenHtml(el, ctx);

  // QUOT.S — quoted block
  if (tag === "QUOT.S") return childrenHtml(el, ctx);

  // GR.SEQ — grouped sequence (used in annexes)
  // NP children may appear without a LIST wrapper; group them into tables
  if (tag === "GR.SEQ") {
    let html = "";
    let npBuffer = [];
    for (const c of el.childNodes) {
      if (c.nodeType === Node.ELEMENT_NODE && c.tagName === "NP") {
        npBuffer.push(c);
      } else {
        if (npBuffer.length > 0) {
          html += renderNumberedGroup(npBuffer, ctx);
          npBuffer = [];
        }
        html += fmxToHtml(c, ctx);
      }
    }
    if (npBuffer.length > 0) html += renderNumberedGroup(npBuffer, ctx);
    return `<div class="fmx-gr-seq">${html}</div>`;
  }

  // TITLE within body content — render as heading (use allText to avoid nested <p>)
  if (tag === "TITLE") {
    const ti = el.querySelector("TI");
    const sti = el.querySelector("STI");
    const tiText = ti ? escapeHtml(allText(ti)) : "";
    const stiText = sti ? escapeHtml(allText(sti)) : "";
    return (tiText ? `<p class="oj-ti-section"><strong>${tiText}</strong></p>` : "")
         + (stiText ? `<p class="oj-sti-art">${stiText}</p>` : "");
  }

  // STI — subtitle (within TITLE blocks)
  if (tag === "STI") return `<p class="oj-sti-art">${escapeHtml(allText(el))}</p>`;

  // CONTENTS — annex body content
  if (tag === "CONTENTS") {
    let html = "";
    let npBuffer = [];
    for (const child of el.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE && child.tagName === "NP") {
        npBuffer.push(child);
      } else {
        if (npBuffer.length > 0) {
          html += renderNumberedGroup(npBuffer, ctx);
          npBuffer = [];
        }
        html += fmxToHtml(child, ctx);
      }
    }
    if (npBuffer.length > 0) html += renderNumberedGroup(npBuffer, ctx);
    return html;
  }

  // Footnotes
  if (tag === "NOTE") {
    if (!ctx) {
      return `<aside class="fmx-footnote">${childrenHtml(el, ctx)}</aside>`;
    }

    const footnoteNumber = ctx.footnotes.length + 1;
    const footnoteId = `fmx-footnote-${ctx.idPrefix}-${footnoteNumber}`;
    const refId = `fmx-footnote-ref-${ctx.idPrefix}-${footnoteNumber}`;
    ctx.footnotes.push({
      number: footnoteNumber,
      id: footnoteId,
      refId,
      html: childrenHtml(el, ctx),
    });

    return `<sup class="fmx-footnote-ref"><a href="#${footnoteId}" id="${refId}">${footnoteNumber}</a></sup>`;
  }

  // Paragraph number
  if (tag === "NO.PARAG" || tag === "NO.P") {
    return `<span class="fmx-num">${childrenHtml(el, ctx)}</span>`;
  }

  // Numbered paragraph (e.g. NP = numbered point)
  if (tag === "NP") {
    const numHtml = fmxToHtml(el.querySelector("NO\\.P"), ctx);
    const bodyHtml = childrenHtmlExcept(el, "NO.P", ctx);
    const parentTag = el.parentElement?.tagName || "";
    const marker = allText(el.querySelector("NO\\.P"));

    if (parentTag === "ITEM" || parentTag === "LIST") {
      return `<li class="fmx-list-item" data-marker="${escapeHtml(marker)}"><span class="fmx-list-item-num">${numHtml}</span><div class="fmx-list-item-body">${bodyHtml}</div></li>`;
    }

    return `<div class="fmx-numbered-block"><div class="fmx-numbered-block-num">${numHtml}</div><div class="fmx-numbered-block-body">${bodyHtml}</div></div>`;
  }

  // Lists
  if (tag === "LIST") {
    const listType = (el.getAttribute("TYPE") || "").toUpperCase();
    const items = Array.from(el.children).filter((child) => child.tagName === "ITEM");
    const tagName = inferHtmlListTag(listType);
    const styleClass = inferListStyleClass(listType);
    const inner = items.map((item) => renderListItem(item, ctx)).join("");
    return `<${tagName} class="fmx-list ${styleClass}">${inner}</${tagName}>`;
  }

  // List item
  if (tag === "ITEM") return childrenHtml(el, ctx);

  // Paragraph — render inline like the old XHTML format: "1.   Text here"
  if (tag === "PARAG") {
    const noP = el.querySelector("NO\\.PARAG");
    const num = noP ? allText(noP) : "";
    const body = childrenHtmlExcept(el, "NO.PARAG", ctx);
    if (num) {
      const numPrefix = `${escapeHtml(num)}\u00a0\u00a0\u00a0`;
      // If body starts with <p>, inject number inside the first <p>
      const injected = body.replace(/^(\s*<p[^>]*>)/, `$1${numPrefix}`);
      if (injected !== body) {
        return injected;
      }
      // Plain text body — wrap in a paragraph with the number
      return `<p class="oj-normal">${numPrefix}${body}</p>`;
    }
    return body;
  }

  // ALINEA — unnumbered paragraph block, render children directly
  if (tag === "ALINEA") return childrenHtml(el, ctx);

  // P — plain paragraph
  if (tag === "P") return `<p>${childrenHtml(el, ctx)}</p>`;

  // TXT — inline text wrapper
  if (tag === "TXT") return childrenHtml(el, ctx);

  // TI.ART — handled outside (rendered as h2 heading by viewer), skip
  if (tag === "TI.ART") return "";

  // STI.ART — article subtitle, render as heading (use allText to avoid nested <p>)
  if (tag === "STI.ART") return `<p class="oj-sti-art">${escapeHtml(allText(el))}</p>`;

  // Default: just recurse
  return childrenHtml(el, ctx);
}

function childrenHtml(el, ctx = null) {
  let out = "";
  for (const c of el.childNodes) out += fmxToHtml(c, ctx);
  return out;
}

function childrenHtmlExcept(el, skipTag, ctx = null) {
  let out = "";
  for (const c of el.childNodes) {
    if (c.nodeType === Node.ELEMENT_NODE && c.tagName === skipTag) continue;
    out += fmxToHtml(c, ctx);
  }
  return out;
}

function renderWithFootnotes(el, idPrefix) {
  const ctx = { idPrefix, footnotes: [] };
  const html = fmxToHtml(el, ctx);
  return appendFootnotes(html, ctx);
}

function renderChildrenWithFootnotes(el, idPrefix, shouldSkip = () => false) {
  const ctx = { idPrefix, footnotes: [] };
  let html = "";
  for (const child of el.childNodes) {
    if (shouldSkip(child)) continue;
    html += fmxToHtml(child, ctx);
  }
  return appendFootnotes(html, ctx);
}

function appendFootnotes(html, ctx) {
  if (ctx.footnotes.length === 0) return html;

  const footnotesHtml = ctx.footnotes.map((footnote) =>
    `<li id="${footnote.id}">${footnote.html} <a href="#${footnote.refId}" class="fmx-footnote-backref" aria-label="Back to reference">↩</a></li>`
  ).join("");

  return `${html}<section class="fmx-footnotes"><ol>${footnotesHtml}</ol></section>`;
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Cross-reference extraction
// ---------------------------------------------------------------------------

/**
 * Build a regex that matches article references in prose for a given language.
 * E.g. "Article 6(1)(a)" in EN, "Artikel 6 Absatz 1" in DE.
 *
 * Returns a RegExp with groups: (full, artNum, paragraph?, point?, rangeTo?)
 */
function buildArticleRefRe(lang) {
  // Extract the article word part from the lang.article regex source
  // lang.article = /Word\s+(\d+[a-z]*)/i  — we want the "Word" part
  const src = lang.article.source;
  // The article word is everything before \s+(\d
  const wordPart = src.split(/\\s\+\(\\d/)[0];
  // Build reference pattern: ArticleWord[s?] NUM (PARA)? (POINT)?  [to|and NUM]?
  // For some languages (like HU), the number comes BEFORE the word: "6. cikk"
  // We detect this by checking if lang.article captures group 1 at the start
  const isNumFirst = /^\(\?:/.test(src) || /^\(\\d/.test(src) || src.startsWith("(\\d");

  if (isNumFirst) {
    // Hungarian-style: "N. cikk"  or "N cikk"
    return new RegExp(
      `(${src}(?:\\(\\d+\\))?(?:\\([a-z]\\))?)`,
      "gi"
    );
  }

  // Standard: ArticleWord N(para)(point) [to/and N]
  return new RegExp(
    `(${wordPart}s?\\s+(\\d+[a-z]?\\b)(?:\\((\\d+)\\))?(?:\\(([a-z])\\))?(?:\\s+(?:to|and)\\s+(\\d+[a-z]?\\b))?)`,
    "gi"
  );
}

/**
 * Build a regex that matches recital references in prose for a given language.
 */
function buildRecitalRefRe(lang) {
  const recitalWord = lang.recital ? lang.recital.source : "[Rr]ecitals?";
  return new RegExp(
    `${recitalWord}\\s+(?:\\()?(\\d+)(?:\\))?(?:\\s+(?:to|and)\\s+(?:\\()?(\\d+)(?:\\))?)?`,
    "g"
  );
}

/**
 * Cross-law reference patterns (language-independent — these abbreviations appear
 * consistently in EU legislation regardless of the document language).
 * Catches e.g. "Regulation (EU) 2016/679", "Directive 95/46/EC", "Decision 2013/755/EU"
 */
const EXTERNAL_LAW_RE_PATTERN =
  /(?:(?:Framework|Implementing|Delegated)\s+)?(?:Rozporządzeni[ea]|Dyrektyw[ay]|Decyzj[ai]|Regulation|Directive|Decision|Recommendation|Verordnung|Richtlinie|Beschluss|R\u00e8glement|D\u00e9cision|Reglamento|Directiva|Decisi\u00f3n|Regolamento|Direttiva|Decisione|Regulamento|Diretiva|Decis\u00e3o|Verordening|Richtlijn|Besluit|F\u00f6rordning|Direktiv|Beslut|Forordning|Asetus|Direktiivi|P\u00e4\u00e4t\u00f6s|Na\u0159\u00edzen\u00ed|Sm\u011brnice|Rozhodnut\u00ed|Nariadenie|Smernica|Rozhodnutie|Rendelet|Irányelv|Hat\u00e1rozat|Regulamentul|Decizia|Naredba|Odluka|Uredba|Regula|Direktīva|Lēmums|Reglamentas|Direktyva|Sprendimas|Regul\u0101ci\u0101|\u039a\u03b1\u03bd\u03bf\u03bd\u03b9\u03c3\u03bc\u03cc\u03c2|\u039f\u03b4\u03b7\u03b3\u03af\u03b1|\u0391\u03c0\u03cc\u03c6\u03b1\u03c3\u03b7|Regolament|De\u010bizjoni|\u0420\u0435\u0433\u043b\u0430\u043c\u0435\u043d\u0442|\u0414\u0438\u0440\u0435\u043a\u0442\u0438\u0432\u0430|\u0420\u0435\u0448\u0435\u043d\u0438\u0435|Rialachán|Treoir|Cinneadh)s?\s+(?:\(\s*[A-Z]+\s*\)\s+)?(?:N(?:o)?\.?\s+)?(\d{2,4}\/\d+(?:\/[A-Z]+)?)/gi;

// The publications include low-numbered acts such as Regulation (EC) No
// 1/2003. Keep the multilingual vocabulary above intact while allowing that
// valid one-digit identifier form.
const EXTERNAL_LAW_RE = new RegExp(
  EXTERNAL_LAW_RE_PATTERN.source.replace("\\d{2,4}", "\\d{1,4}"),
  "gi",
);

const CONTEXTUAL_ACT_RE = /\b(this|that(?:\s+same)?|said|same|latter)\s+(Regulation|Directive|Decision)\b/gi;

const NATIONAL_LAW_RE =
  /\b((?:Italian\s+)?(?:Legislative\s+Decree|Decree-Law|Royal\s+Decree|Law)\s+(?:No\.?\s*)?[\d/]+(?:\s+of\s+\d{1,2}\s+[A-Za-z]+\s+\d{4})?)/gi;

/**
 * EU treaty references. These have no year/number so they can't resolve to a
 * CELEX act page — they surface as external links to an EUR-Lex search. Kept
 * deliberately narrow (named treaties + the TFEU/TEU acronyms) so a bare word
 * like "Treaty" or "Charter" doesn't over-link. Language-independent enough to
 * catch the common English forms that dominate cross-references.
 */
const TREATY_RE =
  /\b(?:TFEU|TEU|Charter(?: of Fundamental Rights of the European Union)?|Treaty on the Functioning of the European Union|Treaty on European Union|Treaty establishing the European (?:Economic )?Community|Treaty establishing the European Atomic Energy Community|E(?:E)?C Treaty|Euratom Treaty)\b/gi;

const PROTOCOL_RE = /\bProtocol\s+No\.?\s*(21|22)\b/gi;

function findTreatyRefs(text) {
  const refs = [];
  TREATY_RE.lastIndex = 0;
  let m;
  while ((m = TREATY_RE.exec(text)) !== null) {
    const treatyKey = /\bCharter\b/i.test(m[0])
      ? "Charter"
      : /\bTFEU\b|Functioning/i.test(m[0])
      ? "TFEU"
      : /\bTEU\b|Treaty on European Union/i.test(m[0])
      ? "TEU"
      : /\bEuratom\b|Atomic Energy/i.test(m[0])
      ? "Euratom Treaty"
      : /\bEEC Treaty\b|European Economic Community/i.test(m[0])
      ? "EEC Treaty"
      : /\bEC Treaty\b|European Community/i.test(m[0])
      ? "EC Treaty"
      : null;
    refs.push({
      type: "external",
      target: m[0],
      raw: m[0],
      start: m.index,
      end: m.index + m[0].length,
      actType: null,
      actCelex: treatyKey ? ACT_CELEX_MAP[treatyKey] : null,
      identifier: m[0],
      year: null,
      number: null,
      suffix: null,
      treaty: true,
      allowBareArticleBinding: true,
    });
  }

  // Historical footnotes sometimes say only "Articles 81 and 82 of the
  // Treaty". Keep the bare label contextual: it is emitted only when the
  // article binder proves the explicit "of the Treaty" relationship.
  const contextualTreatyRe = /\bthe Treaty\b/gi;
  while ((m = contextualTreatyRe.exec(text)) !== null) {
    refs.push({
      type: "external",
      target: m[0],
      raw: m[0],
      start: m.index,
      end: m.index + m[0].length,
      actType: null,
      actCelex: null,
      identifier: m[0],
      year: null,
      number: null,
      suffix: null,
      treaty: true,
      contextual: true,
    });
  }
  return refs;
}

function findProtocolRefs(text) {
  const refs = [];
  PROTOCOL_RE.lastIndex = 0;
  let m;
  while ((m = PROTOCOL_RE.exec(text)) !== null) {
    refs.push({
      type: "external",
      target: `Protocol No ${m[1]}`,
      raw: m[0],
      start: m.index,
      end: m.index + m[0].length,
      actType: null,
      actCelex: null,
      identifier: `Protocol No ${m[1]}`,
      year: null,
      number: null,
      suffix: null,
      protocol: true,
    });
  }
  return refs;
}

function inferExternalActType(raw = "") {
  if (!raw) return null;
  const value = raw.toLowerCase();
  if (/\bframework\s+decision\b/i.test(value)) {
    return "framework decision";
  }
  if (/\brecommendations?\b/i.test(value)) {
    return "recommendation";
  }
  if (/\b(directives?|directiva|direttiva|diretiva|richtlinie|richtlijn|direktiv|direktiiv\w*|dyrektyw[ay]|smernica|směrnice|treoir|direktyva|direktīv\w*|direktiva|irányelv)\b/i.test(value)
    || /οδηγία|директива/i.test(value)) {
    return "directive";
  }
  if (/\b(regulations?|règlement|reglamento|regolamento|regulamento|verordnung|verordening|förordning|forordning|rozporządzeni[ea]|nariadenie|nařízení|rialachán|κανονισμός|регламент|reglamentas|regulamentul|uredba|asetus|rendelet)\b/i.test(value)) {
    return "regulation";
  }
  if (/\b(decisions?|décision|decisión|decisiones|decisione|decisão|decyzj[ai]|beschluss|besluit|beslut|rozhodnutie|rozhodnutí|cinneadh|решение|sprendimas|lēmums|odluka|határozat|päätös)\b/i.test(value)
    || /απόφαση/i.test(value)) {
    return "decision";
  }
  return null;
}

function normalizeFlattenedFootnoteIdentifier(identifier = "", followingText = "", citation = "") {
  // Formex prose can flatten a footnote marker directly onto a four-digit year:
  // "Regulation (EC) No 1864/2004" + note 2 becomes "1864/20042". A five-
  // digit tail beginning with a plausible 19xx/20xx year has no valid EU
  // identifier interpretation, so remove only that final marker.
  const match = String(identifier).match(/^(\d{1,4})\/((?:19|20)\d{2})\d$/);
  if (match) return `${match[1]}/${match[2]}`;

  // Some old EUR-Lex HTML breaks a two-digit year across adjacent fragments:
  // "No 2894/7" followed immediately by "9 ,". A one-digit EU year is not
  // valid here, and the punctuation makes this a bounded continuation rather
  // than a separate numbered provision.
  const splitYear = String(identifier).match(/^(\d{1,4})\/(\d)$/);
  const continuation = String(followingText).match(/^\s*(?:\/\/\s*)?(\d)(?=\s*(?:[,.;)]|\(\d+\)))/);
  if (splitYear && continuation) return `${splitYear[1]}/${splitYear[2]}${continuation[1]}`;

  // Old Regulation/Decision text can flatten a footnote marker onto a
  // two-digit year: "No 729/702 ... 21 April 1970".  The date immediately
  // following the citation makes the repair bounded: delete one digit only
  // when exactly one result matches that year.  Keep directives out of this
  // branch because their normal order is year/number and is handled below.
  const numberFirstFootnote = String(identifier).match(/^(\d{3,4})\/(\d{3})(\/[^/\s]+)?$/);
  const citedYear = String(followingText).slice(0, 180).match(/\b(?:19|20)(\d{2})\b/);
  if (numberFirstFootnote && citedYear && inferExternalActType(citation) !== "directive") {
    const candidates = [...new Set([...numberFirstFootnote[2]].map((_, index) => (
      `${numberFirstFootnote[2].slice(0, index)}${numberFirstFootnote[2].slice(index + 1)}`
    )))].filter((year) => year === citedYear[1]);
    if (candidates.length === 1) return `${numberFirstFootnote[1]}/${candidates[0]}${numberFirstFootnote[3] || ""}`;
  }

  // A few early directives have a footnote digit flattened into their
  // year-first two-digit identifier ("667/654/EEC" for "67/654/EEC"). The
  // immediately following Official Journal publication year supplies strict
  // corroboration: only remove a digit when exactly one possible two-digit
  // year agrees with that date.
  const yearFirstFootnote = String(identifier).match(/^(\d{3})\/(\d{3,4})(\/[^/\s]+)?$/);
  const ojYear = String(followingText).slice(0, 180).match(/\b(?:19|20)(\d{2})\b/);
  if (yearFirstFootnote && ojYear) {
    const candidates = [...new Set([...yearFirstFootnote[1]].map((_, index) => (
      `${yearFirstFootnote[1].slice(0, index)}${yearFirstFootnote[1].slice(index + 1)}`
    )))].filter((year) => year === ojYear[1]);
    if (candidates.length === 1) return `${candidates[0]}/${yearFirstFootnote[2]}${yearFirstFootnote[3] || ""}`;
  }
  return identifier;
}

function isClearlyNationalInstrumentContext(text, index) {
  const context = text.slice(Math.max(0, index - 120), index + 220);
  return /\b(?:regional|national|federal|state|provincial|municipal)\s+(?:government|law|decision)\b|\b(?:law|decision)\s+of\s+(?:the\s+)?(?:region|state|province)\b/i.test(context);
}

function isClearlyCaseLawContext(text, index) {
  const context = text.slice(Math.max(0, index - 160), index + 160);
  return /\b(?:judg(?:ment)?|decision)\s+of\s+the\s+(?:Court|General Court)\b|\b(?:in|Case|Joined Cases)\s+(?:the\s+)?case\b/i.test(context);
}

function hasInstitutionalIssuerContext(text, index) {
  const preceding = text.slice(Math.max(0, index - 400), index);
  const sentenceStart = Math.max(preceding.lastIndexOf("."), preceding.lastIndexOf(";"), preceding.lastIndexOf(":")) + 1;
  const sentence = preceding.slice(sentenceStart);
  // The match itself starts at "Regulation", so the issuer is immediately
  // before `index` for the full citation. Later same-sentence short forms can
  // inherit the already-stated issuer without widening the context past a
  // sentence boundary.
  return /\b(?:Council|Commission)\s*$/i.test(preceding)
    || /\b(?:Council|Commission)\s+Regulation\b/i.test(sentence);
}

function parseExternalLawMeta(raw, target, { ecscAuthority = false, institutionalIssuer = false } = {}) {
  const actType = inferExternalActType(raw);
  const hasNo = /\bN(?:o)?\.?\s/i.test(raw);
  const allowHistoricalNoLabel = /\(\s*(?:EEC|EC|CEE)\s*\)/i.test(raw);
  // A three-digit tail on a number-first historical instrument is commonly a
  // footnote digit flattened into its two-digit year. Do not let the generic
  // resolver silently reinterpret it as a different year; a later document
  // corroboration pass may repair it when there is exact local evidence.
  const malformedHistoricalYear = /^\d{3,4}\/\d{3}$/.test(String(target || ""))
    && !/^(?:19|20)\d{2}\//.test(String(target || ""));
  const resolverInput = {
    actType,
    identifier: target,
    hasNo,
    allowHistoricalNoLabel,
    ecscAuthority,
    institutionalIssuer,
  };
  const actCelex = malformedHistoricalYear ? null : resolveInstrumentCelex(resolverInput);
  const parsed = malformedHistoricalYear
    ? { year: null, number: null, suffix: null }
    : parseInstrumentIdentifier(resolverInput);
  const { year, number, suffix } = parsed;

  return {
    actType,
    actCelex,
    identifier: target || null,
    year,
    number,
    suffix,
  };
}

/**
 * A legal act commonly gives the full institutional form once, then repeats a
 * short form such as "Regulation 1408/71". The number/year order is genuinely
 * ambiguous for old instruments, so never guess it in isolation. Within one
 * parsed document, though, an exact same-type/same-identifier match is safe
 * when every resolved occurrence names the same CELEX act.
 */
export function repairCorroboratedTruncatedInstrumentIdentifiers(refs) {
  for (const ref of refs) {
    if (
      ref.type !== "external"
      || !ref.actType
      || ref.actCelex
      || ref.externalInstitutional
      || ref.externalNational
      || ref.externalCaseLaw
    ) continue;

    const candidates = [...new Map(refs
      .filter((candidate) => (
        candidate.type === "external"
        && candidate.actType === ref.actType
        && candidate.target === ref.target
        && candidate.actCelex
        && !candidate.externalInstitutional
        && !candidate.externalNational
        && !candidate.externalCaseLaw
      ))
      .map((candidate) => [candidate.actCelex, candidate])).values()];

    if (candidates.length !== 1) continue;
    const candidate = candidates[0];
    Object.assign(ref, {
      actCelex: candidate.actCelex,
      identifier: candidate.identifier,
      year: candidate.year,
      number: candidate.number,
      suffix: candidate.suffix,
    });
  }

  // A dropped digit can leave an otherwise valid identifier ("1493/199" for
  // "1493/1999"). As with every other repair here, require one uniquely
  // corroborated same-type citation in the same document; never infer it from
  // the damaged token in isolation.
  const isOmissionVariant = (shortValue, longValue) => {
    if (shortValue.length > longValue.length || longValue.length - shortValue.length > 2) return false;
    let shortIndex = 0;
    for (const char of longValue) if (char === shortValue[shortIndex]) shortIndex += 1;
    return shortIndex === shortValue.length;
  };
  for (const ref of refs) {
    if (ref.type !== "external" || ref.actCelex || !ref.actType || !/^\d{1,4}\/\d{1,4}(?:\/[A-Z]+)?$/i.test(ref.target || "")) continue;
    const candidates = [...new Map(refs.filter((candidate) => {
      if (candidate.type !== "external" || candidate.actType !== ref.actType || !candidate.actCelex) return false;
      const shortParts = String(ref.target).split("/");
      const longParts = String(candidate.target || "").split("/");
      return shortParts.length === longParts.length
        && shortParts.every((part, index) => isOmissionVariant(part, longParts[index]))
        && shortParts.some((part, index) => part !== longParts[index]);
    }).map((candidate) => [candidate.actCelex, candidate])).values()];
    if (candidates.length !== 1) continue;
    const candidate = candidates[0];
    Object.assign(ref, {
      target: candidate.target,
      actCelex: candidate.actCelex,
      identifier: candidate.identifier,
      year: candidate.year,
      number: candidate.number,
      suffix: candidate.suffix,
    });
  }

  // A superscript footnote may be flattened into a two-digit historical year
  // at an arbitrary position ("4136/896" instead of "4136/86"). It would be
  // unsafe to decide which digit is the footnote from that token alone. Repair
  // only when deleting one digit yields a uniquely corroborated, resolved
  // same-type citation elsewhere in this document.
  for (const ref of refs) {
    if (ref.type !== "external" || ref.actCelex || !ref.actType) continue;
    const match = String(ref.target || "").match(/^(\d{3,4})\/(\d{3})$/);
    if (!match) continue;
    const [number, yearWithFootnote] = match.slice(1);
    const possibleTargets = new Set([...yearWithFootnote].map((_, index) => (
      `${number}/${yearWithFootnote.slice(0, index)}${yearWithFootnote.slice(index + 1)}`
    )));
    const candidates = [...new Map(refs
      .filter((candidate) => (
        candidate.type === "external"
        && candidate.actType === ref.actType
        && possibleTargets.has(candidate.target)
        && candidate.actCelex
      ))
      .map((candidate) => [candidate.actCelex, candidate])).values()];
    if (candidates.length !== 1) continue;
    const candidate = candidates[0];
    Object.assign(ref, {
      target: candidate.target,
      actCelex: candidate.actCelex,
      identifier: candidate.identifier,
      year: candidate.year,
      number: candidate.number,
      suffix: candidate.suffix,
    });
  }
  return refs;
}

// Canonical dedup key for a cross-reference. Crucially includes articleNumber so
// distinct "Article 6 of Reg X" / "Article 9 of Reg X" edges are not collapsed
// into one (the act identifier alone is not unique), plus OJ coordinates so
// separate OJ citations stay distinct.
export function crossRefDedupeKey(ref) {
  return referenceDedupeKey(ref);
}

// The possessive word that links an article to the act it belongs to
// ("Article 6 **of** Regulation …"). Language-specific; defaults to English.
function getArticleExternalConnectorWord(langCode = "EN") {
  switch (String(langCode || "").toUpperCase()) {
    case "DE": return "der|des";
    case "FR": return "du|de\\s+la|de\\s+l[’']";
    case "ES": return "del|de\\s+la";
    case "IT": return "del|della";
    case "PT": return "do|da";
    case "NL": return "van";
    case "SV": return "i";
    case "DA": return "i";
    case "RO": return "din";
    default: return "of(?:\\s+the)?";
  }
}

const BARE_ARTICLE_ACT_LANGS = new Set([
  "PL", "CS", "SK", "FI", "BG", "HR", "SL", "ET", "LV", "LT", "EL", "MT", "GA",
]);

// The shared scanner owns list/range mechanics; this adapter supplies the
// language-specific article morphology and conjunctions used in legislation.
// Keeping grammar here avoids teaching the runtime-neutral core about Formex
// language configs while still giving every word-first EU language a useful
// coordinated-reference path.
const ARTICLE_GRAMMAR = {
  EN: { article: "Articles?", list: "and|or", range: "to" },
  PL: { article: "Artyku[łl](?:y|ów)?", list: "i|lub|albo|oraz", range: "do" },
  DE: { article: "Artikel", list: "und|oder", range: "bis" },
  FR: { article: "Articles?", list: "et|ou", range: "à|au" },
  ES: { article: "Art[ií]culos?", list: "y|o", range: "a" },
  IT: { article: "Articol[oi]", list: "e|o", range: "a" },
  PT: { article: "Artigos?", list: "e|ou", range: "a" },
  NL: { article: "Artikelen?", list: "en|of", range: "tot" },
  SV: { article: "Artik(?:el|lar)", list: "och|eller", range: "till" },
  DA: { article: "Artik(?:el|ler)", list: "og|eller", range: "til" },
  FI: { article: "Artiklat?", list: "ja|tai", range: "–|-|artiklaan" },
  CS: { article: "Člán(?:ek|ky|ků)", list: "a|nebo", range: "až" },
  SK: { article: "Člán(?:ok|ky|kov)", list: "a|alebo", range: "až" },
  RO: { article: "Articol(?:ul|ele)?", list: "și|sau", range: "până\\s+la" },
  BG: { article: "Член(?:ове)?", list: "и|или", range: "до" },
  HR: { article: "Član(?:ak|ci|aka)?", list: "i|ili", range: "do" },
  SL: { article: "Člen(?:i|ov)?", list: "in|ali", range: "do" },
  ET: { article: "Artik(?:kel|lid)", list: "ja|või", range: "kuni" },
  LV: { article: "Panti?", list: "un|vai", range: "līdz" },
  LT: { article: "Straipsn(?:is|iai|ių)", list: "ir|ar", range: "iki" },
  EL: { article: "Άρθρ(?:ο|α|ων)", list: "και|ή", range: "έως" },
  MT: { article: "Artikol[ui]", list: "u|jew", range: "sa" },
  GA: { article: "Airteag(?:al|ail)", list: "agus|nó", range: "go" },
};

function getArticleGrammar(lang) {
  const configured = ARTICLE_GRAMMAR[String(lang.code || "EN").toUpperCase()];
  if (configured) return configured;
  return {
    article: `${lang.article.source.split(/\\s\+\(\\d/)[0]}s?`,
    list: "and|or",
    range: "to",
  };
}

// True when the text between an article reference and a following external act is
// an "article(s) … of <act>" bridge rather than unrelated prose. It must end in
// the possessive word and contain only reference-list filler (commas, "and"/"or"/
// "to", "point (x)"/"paragraph" phrases, repeated article words, digits). This is
// what lets "Article 6(4) and Article 9(2), point (g), of Regulation (EU) 2016/679"
// bind both articles to the act, instead of only the one directly before "of".
// An "…of <act>" bridge is short by nature ("Article 6(4) and Article 9(2),
// point (g), of "). Capping the gap keeps the merge from doing expensive string
// work on far-apart article/act pairs (which made it O(n²) on long article text).
function isArticleOfActBridge(gap, langCode) {
  return coreIsArticleOfActBridge(
    gap,
    getArticleExternalConnectorWord(langCode),
  );
}

// Scan a run of coordinated article references starting at each "Article(s)" word:
// "Articles 15, 16 and 17", "Articles 12 to 22" (range → expanded), and
// "Article 6(4) and Article 9(2), point (g)" (repeated word + trailing point).
// Returns [{ start, end, items:[{articleNumber, paragraph, point}] }].
function scanArticleEnumerations(text, lang) {
  const src = lang.article.source;
  const isNumFirst = /^\(\?:/.test(src) || /^\(\\d/.test(src) || src.startsWith("(\\d");
  if (isNumFirst) return null; // num-first languages (e.g. HU) use the simple path
  const grammar = getArticleGrammar(lang);
  return scanSharedArticleEnumerations(text, {
    articleWordSource: grammar.article,
    listWordSource: grammar.list,
    rangeWordSource: grammar.range,
  });
}

function mergeArticleRefsWithExternalContext(text, articleRefs, externalRefs, langCode) {
  return bindArticleRefsToExternalRefs(text, articleRefs, externalRefs, {
    connectorWord: getArticleExternalConnectorWord(langCode),
    allowBare: BARE_ARTICLE_ACT_LANGS.has(String(langCode || "").toUpperCase()),
  });
}

function hydrateContextualActAntecedents(text, externalRefs) {
  return externalRefs.map((ref) => {
    if (!ref.contextual || !ref.actType || ref.actCelex) return ref;
    let antecedent = null;
    for (const candidate of externalRefs) {
      if (candidate.contextual || !candidate.actCelex || candidate.actType !== ref.actType) continue;
      if (candidate.end > ref.start || ref.start - candidate.end > 400) continue;
      const gap = text.slice(candidate.end, ref.start);
      if (/[.!?]/.test(gap) || (antecedent && candidate.end <= antecedent.end)) continue;
      antecedent = candidate;
    }
    if (!antecedent) return ref;
    return {
      ...ref,
      target: antecedent.target,
      actCelex: antecedent.actCelex,
      identifier: antecedent.identifier,
      year: antecedent.year,
      number: antecedent.number,
      suffix: antecedent.suffix,
      antecedentRaw: antecedent.raw,
    };
  });
}

/**
 * Definitions often enumerate several approaches as "referred to in Article …"
 * and name their shared Regulation only after the final member. Bind only the
 * repeated formula within the same sentence; arbitrary intervening prose stays
 * outside this narrow backward-propagation rule.
 */
function bindReferredToArticleSeries(text, articleRefs, externalRefs) {
  const boundArticleIndices = new Set();
  const boundRefs = [];

  for (const act of externalRefs) {
    if (act.contextual || !act.actCelex) continue;
    const sentenceStart = Math.max(
      text.lastIndexOf(".", act.start - 1),
      text.lastIndexOf(";", act.start - 1),
    ) + 1;
    const candidates = [];
    for (let index = 0; index < articleRefs.length; index++) {
      const ref = articleRefs[index];
      if (boundArticleIndices.has(index) || ref.start < sentenceStart || ref.end > act.start) continue;
      if (act.start - ref.start > 1200) continue;
      const lead = text.slice(Math.max(sentenceStart, ref.start - 80), ref.start);
      if (!/\breferred\s+to\s+in\s*$/i.test(lead)) continue;
      candidates.push({ index, ref });
    }
    if (candidates.length < 2) continue;
    for (const { index, ref } of candidates) {
      boundArticleIndices.add(index);
      boundRefs.push({
        ...act,
        start: ref.start,
        raw: text.slice(ref.start, act.end),
        articleNumber: ref.target,
        paragraph: ref.paragraph,
        point: ref.point,
        seriesContext: true,
      });
    }
  }

  return {
    articleRefs: articleRefs.filter((_, index) => !boundArticleIndices.has(index)),
    externalRefs: [...externalRefs, ...boundRefs],
  };
}

/**
 * Extract cross-references from a text string, using language-specific patterns.
 * Returns an array of { type, target, paragraph, point, raw } objects.
 *
 * @param {string} text  Plain text to scan
 * @param {object} lang  Language config from getLangConfig()
 */
export function extractCrossRefsFromText(text, lang) {
  const refs = [];
  const seen = new Set();
  const articleRefs = [];
  const recitalRefs = [];
  const externalRefs = [];

  function addRef(ref) {
    const key = crossRefDedupeKey(ref);
    if (!seen.has(key)) {
      seen.add(key);
      refs.push(ref);
    }
  }

  let m;

  // Article references: parse coordinated enumerations ("Articles 15, 16 and 17",
  // "Articles 12 to 22", "Article 6(4) and Article 9(2), point (g)") into
  // individual items so each can bind to its act and survive deduplication.
  const enumerations = scanArticleEnumerations(text, lang);
  if (enumerations) {
    for (const enumeration of enumerations) {
      for (const item of enumeration.items) {
        articleRefs.push({
          type: "article",
          target: item.articleNumber,
          paragraph: item.paragraph,
          point: item.point,
          raw: text.slice(enumeration.start, enumeration.end),
          start: enumeration.start,
          end: enumeration.end,
        });
      }
    }
  } else {
    // Num-first languages (e.g. Hungarian "6. cikk") keep the simple scan.
    const artRe = buildArticleRefRe(lang);
    artRe.lastIndex = 0;
    while ((m = artRe.exec(text)) !== null) {
      const artMatch = lang.article.exec(m[0]);
      if (!artMatch) continue;
      articleRefs.push({
        type: "article",
        target: artMatch[1],
        paragraph: null,
        point: null,
        raw: m[0],
        start: m.index,
        end: m.index + m[0].length,
      });
    }
  }

  // Recital references (language-specific)
  const recRe = buildRecitalRefRe(lang);
  recRe.lastIndex = 0;
  while ((m = recRe.exec(text)) !== null) {
    const from = parseInt(m[1], 10);
    const to = m[2] ? parseInt(m[2], 10) : from;
    for (let i = from; i <= to; i++) {
      recitalRefs.push({ type: "recital", target: String(i), raw: m[0] });
    }
  }

  // External law references (mostly language-independent abbreviations)
  EXTERNAL_LAW_RE.lastIndex = 0;
  while ((m = EXTERNAL_LAW_RE.exec(text)) !== null) {
    const institutionalContext = text.slice(Math.max(0, m.index - 120), m.index + 220);
    const ecscAuthority = /\bHigh Authority\b/i.test(text.slice(Math.max(0, m.index - 80), m.index + 80));
    const institutionalIssuer = hasInstitutionalIssuerContext(text, m.index);
    const target = normalizeFlattenedFootnoteIdentifier(m[1], text.slice(m.index + m[0].length), m[0]);
    externalRefs.push({
      type: "external",
      target,
      raw: m[0],
      start: m.index,
      end: m.index + m[0].length,
      // Decisions and recommendations of a Joint/Association Committee are
      // instruments of an external agreement body, not CELEX sector-3 acts.
      // Preserve them as explicit external citations rather than guessing a
      // Commission/Council decision from the number alone.
      externalInstitutional: /\bof\s+the\s+(?:Joint|Association)\s+(?:Committee|Council)\b|\b(?:[A-Z][A-Za-z]*(?:[-–][A-Za-z]+)*\s+)?(?:Joint\s+Committee|Association\s+Council)\b/i.test(institutionalContext),
      // A reference expressly tied to a regional/state government is a
      // national instrument, not an unresolved EU act.
      externalNational: isClearlyNationalInstrumentContext(text, m.index),
      externalCaseLaw: isClearlyCaseLawContext(text, m.index),
      ecscAuthority,
      ...parseExternalLawMeta(m[0], target, { ecscAuthority, institutionalIssuer }),
    });
  }

  NATIONAL_LAW_RE.lastIndex = 0;
  while ((m = NATIONAL_LAW_RE.exec(text)) !== null) {
    externalRefs.push({
      type: "external",
      target: m[1],
      raw: m[1],
      start: m.index,
      end: m.index + m[0].length,
      actType: null,
      actCelex: null,
      identifier: m[1],
      nationalLaw: true,
    });
  }

  CONTEXTUAL_ACT_RE.lastIndex = 0;
  while ((m = CONTEXTUAL_ACT_RE.exec(text)) !== null) {
    // In legislation, "this Regulation/Directive" means the current act and
    // its article references must stay as internal anchors. "That …" points
    // back to another act and remains a contextual external reference.
    if (m[1].toLowerCase() === "this") continue;
    externalRefs.push({
      type: "external",
      target: m[0],
      raw: m[0],
      start: m.index,
      end: m.index + m[0].length,
      actType: m[2].toLowerCase(),
      actCelex: null,
      contextual: true,
    });
  }

  // Treaty references (TFEU/TEU and named treaties) — no year/number, so they
  // resolve to an EUR-Lex search rather than an internal act page.
  for (const ref of findTreatyRefs(text)) externalRefs.push(ref);
  for (const ref of findProtocolRefs(text)) externalRefs.push(ref);

  const hydratedExternalRefs = hydrateContextualActAntecedents(text, externalRefs);
  const seriesRefs = bindReferredToArticleSeries(text, articleRefs, hydratedExternalRefs);
  const thereofRefs = bindThereofArticleRefs(text, seriesRefs.articleRefs, seriesRefs.externalRefs);
  const mergedRefs = mergeArticleRefsWithExternalContext(
    text,
    thereofRefs.articleRefs,
    seriesRefs.externalRefs,
    lang.code,
  );
  repairCorroboratedTruncatedInstrumentIdentifiers([
    ...mergedRefs.externalRefs,
    ...thereofRefs.externalRefs,
  ]);

  for (const ref of mergedRefs.articleRefs) addRef(ref);
  for (const ref of recitalRefs) addRef(ref);
  for (const ref of mergedRefs.externalRefs) {
    if (!ref.contextual || ref.articleNumber) addRef(ref);
  }
  for (const ref of thereofRefs.externalRefs) addRef(ref);

  return refs;
}

/**
 * An amendment article establishes one target act in its heading and then uses
 * bare article numbers throughout the replacement text. Those numbers belong
 * to the amended act, not to the short amending instrument itself.
 */
function bindRefsToAmendmentScope(refs, articleTitle, lang) {
  if (!/^Amendments?\s+(?:to|of)\b/i.test(String(articleTitle || "").trim())) return refs;
  const scopes = extractCrossRefsFromText(articleTitle, lang)
    .filter((ref) => ref.type === "external" && !ref.articleNumber && ref.actCelex);
  const byAct = new Map(scopes.map((ref) => [ref.actCelex, ref]));
  if (byAct.size !== 1) return refs;
  const scope = [...byAct.values()][0];

  return refs.map((ref) => ref.type !== "article" ? ref : {
    ...scope,
    raw: ref.raw,
    start: ref.start,
    end: ref.end,
    articleNumber: ref.target,
    paragraph: ref.paragraph,
    point: ref.point,
    amendmentScope: true,
  });
}

/**
 * Extract structured REF.DOC.OJ cross-references directly from XML elements.
 * These are language-independent — they use XML attributes, not text patterns.
 *
 * @param {Element} el  Any XML element to search within
 * @returns {Array}  Array of { type: "oj_ref", ojColl, ojNo, ojYear, ojPage, raw }
 */
function extractOjRefsFromElement(el) {
  const refs = [];
  const seen = new Set();
  for (const refEl of el.querySelectorAll("REF\\.DOC\\.OJ")) {
    const coll = refEl.getAttribute("COLL") || "";
    const no = refEl.getAttribute("NO.OJ") || "";
    const date = refEl.getAttribute("DATE.PUB") || "";
    const page = refEl.getAttribute("PAGE.FIRST") || "";
    const raw = allText(refEl);
    if (!coll || !no) continue;
    const year = date.slice(0, 4);
    const key = `oj:${coll}:${no}:${year}:${page}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push({ type: "oj_ref", ojColl: coll, ojNo: no, ojYear: year, ojPage: page, raw });
    }
  }
  return refs;
}

/**
 * Inject clickable cross-reference links into HTML.
 * Uses the language-specific article word to match references in the text.
 *
 * @param {string} html  HTML string to process
 * @param {object} lang  Language config from getLangConfig()
 */
export function injectCrossRefLinks(html, lang) {
  if (!html) return html;

  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstElementChild;
  if (!root) return html;

  const src = lang.article.source;
  const isNumFirst = src.startsWith("(\\d");

  let articleInjectRe;
  if (isNumFirst) {
    articleInjectRe = new RegExp(`(${src})`, "gi");
  } else {
    const wordPart = getArticleGrammar(lang).article;
    articleInjectRe = new RegExp(
      `\\b(${wordPart}\\s+\\d+[a-z]?\\b(?:\\(\\d+\\))?(?:\\([a-z]\\))?)`,
      "gi"
    );
  }

  const textWalker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (textWalker.nextNode()) {
    const node = textWalker.currentNode;
    const parent = node.parentElement;
    if (!parent) continue;
    if (parent.closest("a, .defined-term, .oj-ref")) continue;
    if (!node.textContent?.trim()) continue;
    textNodes.push(node);
  }

  for (const node of textNodes) {
    const text = node.textContent;
    if (!text) continue;

    const externalRefs = [];

    EXTERNAL_LAW_RE.lastIndex = 0;
    let match;
    while ((match = EXTERNAL_LAW_RE.exec(text)) !== null) {
      const target = normalizeFlattenedFootnoteIdentifier(match[1], text.slice(match.index + match[0].length), match[0]);
      const ecscAuthority = /\bHigh Authority\b/i.test(text.slice(Math.max(0, match.index - 80), match.index + 80));
      const institutionalIssuer = hasInstitutionalIssuerContext(text, match.index);
      const meta = parseExternalLawMeta(match[0], target, { ecscAuthority, institutionalIssuer });
      externalRefs.push({
        start: match.index,
        end: match.index + match[0].length,
        kind: "external",
        target,
        label: match[0],
        ...meta,
      });
    }

    for (const treatyRef of findTreatyRefs(text)) {
      externalRefs.push({
        start: treatyRef.start,
        end: treatyRef.end,
        kind: "external",
        target: treatyRef.target,
        label: treatyRef.raw,
        actType: null,
        year: null,
        number: null,
        suffix: null,
      });
    }

    for (const protocolRef of findProtocolRefs(text)) {
      externalRefs.push({
        start: protocolRef.start,
        end: protocolRef.end,
        kind: "external",
        target: protocolRef.target,
        label: protocolRef.raw,
        actType: null,
        year: null,
        number: null,
        suffix: null,
      });
    }

    const refs = [];

    // Article references. Word-first languages use the enumeration scanner so
    // every member of a list/range ("Articles 15, 16 and 17", "Articles 12 to 22")
    // gets its own link; the enumeration binds as a whole to a following act, so
    // each member links to that act's article rather than an internal anchor.
    const enumerations = isNumFirst ? null : scanArticleEnumerations(text, lang);
    if (enumerations) {
      for (const enumeration of enumerations) {
        let boundAct = null;
        for (const ext of externalRefs) {
          if (ext.start < enumeration.end || ext.start - enumeration.end > MAX_ARTICLE_ACT_BRIDGE) continue;
          if (!isArticleOfActBridge(text.slice(enumeration.end, ext.start), lang.code)) continue;
          if (!boundAct || ext.start < boundAct.start) boundAct = ext;
        }
        let isFirst = true;
        for (const item of enumeration.items) {
          if (item.tokenStart == null) continue; // range-fill item: no text to wrap
          const start = isFirst ? enumeration.start : item.tokenStart;
          isFirst = false;
          const label = text.slice(start, item.tokenEnd);
          if (boundAct) {
            refs.push({
              kind: "external", start, end: item.tokenEnd, label,
              searchText: boundAct.label, target: boundAct.target,
              articleNumber: item.articleNumber, paragraph: item.paragraph, point: item.point,
              actType: boundAct.actType, year: boundAct.year, number: boundAct.number, suffix: boundAct.suffix,
            });
          } else {
            refs.push({
              kind: "article", start, end: item.tokenEnd, label,
              articleNumber: item.articleNumber, paragraph: item.paragraph, point: item.point,
            });
          }
        }
      }
    } else {
      // Num-first languages (e.g. Hungarian "6. cikk") keep single-token
      // detection plus the phrase-absorbing merge.
      const articleRefs = [];
      articleInjectRe.lastIndex = 0;
      while ((match = articleInjectRe.exec(text)) !== null) {
        const articleMatch = lang.article.exec(match[0]);
        lang.article.lastIndex = 0;
        if (!articleMatch) continue;
        const paraMatch = match[0].match(/\((\d+)\)/);
        const pointMatch = match[0].match(/\(([a-z])\)/i);
        articleRefs.push({
          start: match.index,
          end: match.index + match[0].length,
          target: articleMatch[1],
          paragraph: paraMatch ? paraMatch[1] : null,
          point: pointMatch ? pointMatch[1] : null,
        });
      }
      const merged = mergeArticleRefsWithExternalContext(text, articleRefs, externalRefs, lang.code);
      for (const ref of merged.articleRefs) {
        refs.push({
          kind: "article", start: ref.start, end: ref.end,
          articleNumber: ref.target, paragraph: ref.paragraph, point: ref.point,
          label: text.slice(ref.start, ref.end),
        });
      }
      externalRefs.length = 0;
      externalRefs.push(...merged.externalRefs);
    }

    // The external act names themselves (a bound article links to the act too, but
    // the act name stays independently clickable).
    for (const ext of externalRefs) {
      const label = ext.raw || ext.label || text.slice(ext.start, ext.end);
      refs.push({
        kind: "external", start: ext.start, end: ext.end, label, searchText: label,
        target: ext.target, articleNumber: ext.articleNumber || null,
        paragraph: ext.paragraph || null, point: ext.point || null,
        actType: ext.actType, year: ext.year, number: ext.number, suffix: ext.suffix,
      });
    }

    refs.sort((a, b) => a.start - b.start || b.end - a.end);

    const filtered = [];
    let cursor = -1;
    for (const ref of refs) {
      if (ref.start < cursor) continue;
      filtered.push(ref);
      cursor = ref.end;
    }

    if (filtered.length === 0) continue;

    const frag = doc.createDocumentFragment();
    let lastIndex = 0;

    for (const ref of filtered) {
      if (ref.start > lastIndex) {
        frag.appendChild(doc.createTextNode(text.slice(lastIndex, ref.start)));
      }

      const link = doc.createElement("a");
      link.className = ref.kind === "article" ? "cross-ref" : "external-ref";
      link.textContent = ref.label;

      if (ref.kind === "article") {
        link.setAttribute("data-ref-article", ref.articleNumber);
        link.setAttribute("href", `#article-${ref.articleNumber}`);
        link.setAttribute("title", `Go to Article ${ref.articleNumber}`);
      } else {
        const searchText = ref.searchText || ref.label;
        link.setAttribute("href", buildEurlexSearchUrl(searchText, lang.code));
        link.setAttribute("target", "_blank");
        link.setAttribute("rel", "noopener noreferrer");
        link.setAttribute("title", `Open ${ref.target} on EUR-Lex`);
        link.setAttribute("data-ref-raw", searchText);
        if (ref.articleNumber) link.setAttribute("data-ref-article", ref.articleNumber);
        if (ref.paragraph) link.setAttribute("data-ref-paragraph", ref.paragraph);
        if (ref.point) link.setAttribute("data-ref-point", ref.point);
        if (ref.actType) link.setAttribute("data-ref-act-type", ref.actType);
        if (ref.year) link.setAttribute("data-ref-year", ref.year);
        if (ref.number) link.setAttribute("data-ref-number", ref.number);
        if (ref.suffix) link.setAttribute("data-ref-suffix", ref.suffix);
      }

      frag.appendChild(link);
      lastIndex = ref.end;
    }

    if (lastIndex < text.length) {
      frag.appendChild(doc.createTextNode(text.slice(lastIndex)));
    }

    node.parentNode.replaceChild(frag, node);
  }

  return root.innerHTML;
}

// ---------------------------------------------------------------------------
// Main FMX parser
// ---------------------------------------------------------------------------

/**
 * Detect whether text looks like Formex XML.
 * Supports single ACT documents and combined (ACT + ANNEX) documents.
 */
export function isFmxDocument(text) {
  if (text.includes("<COMBINED.FMX")) return true;
  return text.includes("<ACT") && text.includes("formex") && text.includes("<ENACTING.TERMS");
}

/**
 * Parse a Formex (FMX) XML document into the app's combined data structure,
 * with additional cross-reference data.
 *
 * @param {string} xmlText  Raw XML string
 * @returns {{ title, articles, recitals, annexes, definitions, langCode, crossReferences }}
 */
export function parseFmxToCombined(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "text/xml");

  // Check for parse errors
  const parseError = doc.querySelector("parsererror");
  if (parseError) {
    throw new Error("FMX XML parse error: " + parseError.textContent.slice(0, 200));
  }

  const docRoot = doc.documentElement; // <ACT> or <COMBINED.FMX>

  // Collection wrappers sometimes hold one legacy GENERAL document, but may
  // also hold several ACT documents. Unwrap only the single-document form:
  // selecting the first child of a multi-document collection would silently
  // discard its later recitals and articles.
  const isCollection = docRoot.tagName === "COMBINED.FMX" || docRoot.tagName === "FMX.COLLECTION";
  const legalRoots = isCollection
    ? Array.from(docRoot.children).filter((child) => child.tagName === "ACT" || child.tagName === "GENERAL")
    : [];
  const root = legalRoots.length === 1 ? legalRoots[0] : docRoot;

  // --- Language ---
  const lgDoc = root.querySelector("BIB\\.INSTANCE > LG\\.DOC");
  const langCode = lgDoc ? lgDoc.textContent.trim().toUpperCase() : "EN";
  const lang = getLangConfig(langCode);
  const meansRegex = buildMeansRegex(lang);
  const fallbackDefRegex = buildFallbackDefRegex(lang);

  // --- Title ---
  // FMX <TI> contains multiple <P> elements; join them with spaces
  const titleEl = root.querySelector("TITLE > TI");
  let titleParts = [];
  if (titleEl) {
    for (const p of titleEl.querySelectorAll("P")) {
      const t = allText(p).trim();
      if (t) titleParts.push(t);
    }
  }
  const titleText = titleParts.join(" ");

  // Extract a genuine short title from parentheses (e.g. "General Data
  // Protection Regulation"). Drafting qualifiers such as "recast" are part
  // of the official title, but are not names of the act.
  let shortTitle = "";
  for (const part of titleParts) {
    const m = part.match(/\(([^)]{5,80})\)/);
    const candidate = m?.[1]?.trim() || "";
    const isDraftingQualifier = /^(?:recast|codification|codified version)$/i.test(candidate);
    if (candidate && !lang.eea.test(candidate) && !isDraftingQualifier) {
      shortTitle = candidate;
      break;
    }
  }

  // Format main title: split at language-specific parliament institution mention
  // or fall back to the date-based split
  let mainTitle = titleText;
  if (lang.parliamentSplit) {
    const splitResult = titleText.split(lang.parliamentSplit);
    if (splitResult.length > 1) mainTitle = splitResult[0].trim();
  }
  if (mainTitle === titleText && lang.titleSplit) {
    mainTitle = titleText.split(lang.titleSplit)[0].trim();
  }
  mainTitle = mainTitle.toLowerCase()
    .replace(/(?:^|\s)\S/g, a => a.toUpperCase())
    .replace(/\b(Eu|Ec|Eec|Euratom)\b/gi, m => m.toUpperCase())
    .replace(/[.;:]$/, "");

  const title = shortTitle && mainTitle && !mainTitle.includes(shortTitle)
    ? `${shortTitle} — ${mainTitle}`
    : shortTitle || mainTitle;

  // --- Recitals ---
  const recitals = [];
  for (const consid of root.querySelectorAll("GR\\.CONSID > CONSID")) {
    const noP = consid.querySelector("NP > NO\\.P");
    const num = noP ? allText(noP).replace(/[()]/g, "").trim() : String(recitals.length + 1);
    const txtEl = consid.querySelector("NP > TXT") || consid.querySelector("NP");
    const recitalText = txtEl ? allText(txtEl) : "";
    const recitalHtmlRaw = txtEl ? renderWithFootnotes(txtEl, `recital-${num}`) : "";
    recitals.push({
      recital_number: num,
      recital_text: recitalText,
      recital_html: injectCrossRefLinks(recitalHtmlRaw, lang),
    });
  }

  // --- Articles with chapter/section tracking ---
  const articles = [];
  const crossReferences = {};  // articleNumber → [refs]

  // The legal basis in a preamble is often the sole fully-qualified occurrence
  // of an instrument subsequently cited in a recital using a short form. Keep
  // those source citations visible in the graph and make them available to the
  // final document-wide corroboration pass below.
  const visaSeen = new Set();
  const visaRefs = Array.from(root.querySelectorAll("PREAMBLE > GR\\.VISA > VISA, PREAMBLE > VISA"))
    .flatMap((visa) => extractCrossRefsFromText(allText(visa), lang))
    .filter((ref) => {
      const key = crossRefDedupeKey(ref);
      if (visaSeen.has(key)) return false;
      visaSeen.add(key);
      return true;
    });
  if (visaRefs.length) crossReferences.preamble = visaRefs;

  function classifyDivisionRole(tiText, depth) {
    if (lang.chapter.test(tiText)) return "chapter";
    if (lang.section.test(tiText)) return depth === 0 ? "chapter" : "section";

    // Prefer the structural FMX hierarchy over translated heading text so TOC
    // extraction keeps working across languages and heading variants.
    return depth === 0 ? "chapter" : "section";
  }

  function walkDivisions(divisionEl, chapter, section, depth = 0) {
    const titleEl = Array.from(divisionEl.children).find((child) => child.tagName === "TITLE");
    let currentChapter = { ...chapter };
    let currentSection = { ...section };

    if (titleEl) {
      const ti = titleEl.querySelector("TI");
      const sti = titleEl.querySelector("STI");
      const tiText = ti ? allText(ti) : "";
      const stiText = sti ? allText(sti) : "";
      const role = classifyDivisionRole(tiText, depth);

      if (role === "chapter") {
        currentChapter = { number: tiText, title: stiText };
        currentSection = { number: "", title: "" };
      } else {
        currentSection = { number: tiText, title: stiText };
      }
    }

    for (const child of divisionEl.children) {
      if (child.tagName === "TITLE") continue;

      if (child.tagName === "ARTICLE") {
        const idAttr = child.getAttribute("IDENTIFIER") || "";
        const tiArt = child.querySelector("TI\\.ART");
        const stiArt = child.querySelector("STI\\.ART");

        const artLabel = tiArt ? allText(tiArt) : "";
        const m = artLabel.match(lang.article);
        const article_number = m ? m[1] : idAttr.replace(/^0+/, "") || String(articles.length + 1);
        const article_title = stiArt ? allText(stiArt) : "";

        // Build HTML from article body (skip TI.ART, keep STI.ART as subtitle)
        let bodyHtml = renderChildrenWithFootnotes(
          child,
          `article-${article_number}`,
          (node) => node.nodeType === Node.ELEMENT_NODE && node.tagName === "TI.ART"
        );
        bodyHtml = injectCrossRefLinks(bodyHtml, lang);

        articles.push({
          article_number,
          article_title,
          division: {
            chapter: { number: currentChapter.number, title: currentChapter.title },
            section: currentSection.number ? { number: currentSection.number, title: currentSection.title } : null,
          },
          article_html: bodyHtml,
        });

        // Extract cross-references from the article's full text (language-aware)
        const fullText = Array.from(child.children)
          .filter((element) => element.tagName !== "TI.ART")
          .map((element) => allText(element))
          .filter(Boolean)
          .join(" ");
        const textRefs = bindRefsToAmendmentScope(
          extractCrossRefsFromText(fullText, lang),
          article_title,
          lang,
        );
        // Also extract structural OJ references from the XML
        const ojRefs = extractOjRefsFromElement(child);
        const allRefs = [...textRefs, ...ojRefs];

        // Deduplicate and exclude self-references
        const seenKeys = new Set();
        const uniqueRefs = allRefs.filter(r => {
          if (r.type === "article" && r.target === article_number) return false;
          const key = crossRefDedupeKey(r);
          if (seenKeys.has(key)) return false;
          seenKeys.add(key);
          return true;
        });
        if (uniqueRefs.length > 0) {
          crossReferences[article_number] = uniqueRefs;
        }
      }

      // Nested divisions (sections within chapters)
      if (child.tagName === "DIVISION") {
        walkDivisions(child, currentChapter, currentSection, depth + 1);
      }
    }
  }

  // Modern Formex wraps the operative body in <ENACTING.TERMS>. Older/large v2
  // acts (schema 02.00, <GENERAL> root — e.g. Directive 2004/18/EC) have no
  // ENACTING.TERMS and instead nest the body divisions under a top-level
  // <CONTENTS>. Fall back to that so their articles aren't dropped; exclude any
  // <CONTENTS> that belongs to an <ANNEX> (annexes carry their own).
  const enactingTerms = root.querySelector("ENACTING\\.TERMS")
    || Array.from(root.querySelectorAll("CONTENTS")).find((el) => !el.closest("ANNEX"));
  if (enactingTerms) {
    // The container sits one level above the first real DIVISION, so start one
    // level higher to make the first nested DIVISION a chapter.
    walkDivisions(enactingTerms, { number: "", title: "" }, { number: "", title: "" }, -1);
  }

  // Some older Commission decisions, especially merger and competition
  // decisions, contain their complete published text in PROLOG or in a direct
  // CONTENTS element without ARTICLE children. Do not manufacture an
  // "Article 1": retain it as an explicitly unnumbered section so it remains
  // readable, searchable, and eligible for external-citation extraction.
  if (articles.length === 0) {
    // Some old Cellar payloads concatenate identical GENERAL documents. Keep
    // the normal collection-wide parsing above, but use one representative
    // legal root for the unnumbered fallback so the same decision is not
    // rendered and indexed several times.
    const unnumberedRoot = legalRoots[0] || root;
    const unnumberedBody = Array.from(unnumberedRoot.children).find((child) => child.tagName === "PROLOG")
      || Array.from(unnumberedRoot.children).find((child) => child.tagName === "CONTENTS" && !child.closest("ANNEX"))
      || Array.from(unnumberedRoot.querySelectorAll("ENACTING\\.TERMS")).find((element) => allText(element))
      // Older competition-decision summaries place every substantive section
      // under PREAMBLE/GR.CONSID and leave ENACTING.TERMS empty. Selecting the
      // preamble itself avoids relying on a compound selector for dotted FMX
      // element names.
      || unnumberedRoot.querySelector("PREAMBLE");
    const unnumberedText = unnumberedBody ? allText(unnumberedBody) : "";
    if (unnumberedText) {
      const article_number = "text";
      const article_html = injectCrossRefLinks(renderWithFootnotes(unnumberedBody, "unnumbered-text"), lang);
      articles.push({
        article_number,
        article_title: "",
        display_label: "Decision text",
        is_unnumbered: true,
        division: {
          chapter: { number: "", title: "" },
          section: null,
        },
        article_html,
      });

      const seenKeys = new Set();
      const refs = [
        ...extractCrossRefsFromText(unnumberedText, lang),
        ...extractOjRefsFromElement(unnumberedBody),
      ].filter((ref) => {
        const key = crossRefDedupeKey(ref);
        if (seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
      });
      if (refs.length) crossReferences[article_number] = refs;
    }
  }

  // --- Definitions ---
  const definitions = [];
  // Find the definitions article by matching its title against the language-specific pattern
  const defArticle = articles.find(a => a.article_title && lang.definition.test(a.article_title));
  if (defArticle) {
    // Try multiple IDENTIFIER formats (3-digit padding is standard, but try others too)
    const artNum = defArticle.article_number;
    const candidates = [
      artNum.padStart(3, "0"),
      artNum.padStart(4, "0"),
      artNum,
    ];
    let artEl = null;
    for (const id of candidates) {
      artEl = root.querySelector(`ARTICLE[IDENTIFIER="${id}"]`);
      if (artEl) break;
    }

    if (artEl) {
      for (const item of artEl.querySelectorAll("ITEM")) {
        // The TXT might be inside NP > TXT or directly under ITEM
        const txtEl = item.querySelector("TXT") || item.querySelector("NP");
        if (!txtEl) continue;
        const text = allText(txtEl);
        if (!text) continue;
        const sourcePoint = allText(item.querySelector("NO\\.P") || item.querySelector("NP > NO")) || null;
        const makeDefinition = (term, definition) => ({
          term,
          definition,
          sourceArticle: artNum,
          sourcePoint,
          references: [
            ...extractCrossRefsFromText(definition, lang),
            ...extractOjRefsFromElement(txtEl),
          ],
        });

        if (lang.definitionFormat === "verb_first") {
          // Verb-first languages (GA, IT, ES, PT): meansVerb 'term' definition
          const termMatch = text.match(meansRegex);
          if (termMatch) {
            const term = termMatch[1].trim();
            const definition = text.slice(termMatch[0].length).trim();
            definitions.push(makeDefinition(term, definition));
          }
        } else {
          // Term-first languages: 'term' meansVerb definition
          // Try the configured meansVerb first; fall back to the quoted-term
          // pattern for languages where the verb only appears in the article
          // intro (DE, FR, CS, SK, HU, FI, ET, LV, LT, EL, NL, DA, SV …).
          let termMatch = text.match(meansRegex);
          if (termMatch) {
            const term = termMatch[1].trim();
            const definition = text.replace(termMatch[0], "").trim();
            definitions.push(makeDefinition(term, definition));
          } else {
            const fbMatch = text.match(fallbackDefRegex);
            if (fbMatch) {
              const term = fbMatch[1].trim();
              const definition = text.slice(fbMatch[0].length).trim();
              if (term && definition) definitions.push(makeDefinition(term, definition));
            }
          }
        }
      }
    }
  }

  // --- Sort recitals ---
  recitals.sort((a, b) => (parseInt(a.recital_number) || 0) - (parseInt(b.recital_number) || 0));

  // --- Also extract cross-references from recitals ---
  for (const r of recitals) {
    const textRefs = extractCrossRefsFromText(r.recital_text, lang);
    const allRefs = textRefs;
    const seenKeys = new Set();
    const uniqueRefs = allRefs.filter(ref => {
      const key = crossRefDedupeKey(ref);
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });
    if (uniqueRefs.length > 0) {
      const key = `recital_${r.recital_number}`;
      crossReferences[key] = uniqueRefs;
    }
  }

  // --- Annexes ---
  const annexes = [];
  const validArticleNumbers = new Set(articles.map((article) => article.article_number));
  // In combined documents, ANNEX elements are siblings of ACT
  const annexContainer = docRoot.tagName === "COMBINED.FMX" ? docRoot : root;
  for (const annexEl of annexContainer.querySelectorAll("ANNEX")) {
    const annexTi = annexEl.querySelector("TITLE > TI");
    const annexSti = annexEl.querySelector("TITLE > STI");
    const tiText = annexTi ? allText(annexTi) : "";
    const stiText = annexSti ? allText(annexSti) : "";

    // Extract annex ID (e.g. "I", "II", "III") from title using language-specific pattern
    const idMatch = tiText.match(lang.annexCapture);
    const annex_id = idMatch ? (idMatch[1] || "").trim() : tiText;

    const annex_title = stiText ? `${tiText} — ${stiText}` : tiText;

    // Build HTML from annex contents
    const contents = annexEl.querySelector("CONTENTS");
    let annex_html = "";
    if (contents) {
      annex_html = injectCrossRefLinks(renderWithFootnotes(contents, `annex-${annex_id || "body"}`), lang);
    }

    const annexText = allText(annexEl);
    // An annex's bare Article N can only be an internal link when N exists in
    // the current act. Replacement annexes and flattened correlation tables
    // often quote articles of predecessor acts without preserving enough column
    // context to identify the correct act; plain text is safer than a broken or
    // guessed link. Explicitly qualified external references remain untouched.
    annex_html = stripInvalidArticleLinks(annex_html, validArticleNumbers);
    annexes.push({ annex_id, annex_title, annex_html });

    const textRefs = extractCrossRefsFromText(annexText, lang);
    const ojRefs = extractOjRefsFromElement(annexEl);
    const seenKeys = new Set();
    const uniqueRefs = [...textRefs, ...ojRefs].filter((ref) => {
      if (ref.type === "article" && !validArticleNumbers.has(ref.target)) return false;
      const key = crossRefDedupeKey(ref);
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });

    if (uniqueRefs.length > 0) {
      crossReferences[`annex_${annex_id}`] = uniqueRefs;
    }
  }

  // Final integrity guard: no internal edge or anchor may target an article
  // absent from the fully parsed act. This catches malformed source tokens such
  // as "Article 1472)" (a flattened "Article 147(2)") and any attribution form
  // we intentionally did not guess. The citation remains visible as plain text.
  // Shared with the EUR-Lex HTML parser so both source formats enforce the same
  // invariant (and defensively covers article.paragraphs[].html).
  enforceInternalReferenceIntegrity({ articles, recitals, annexes, crossReferences });
  repairCorroboratedTruncatedInstrumentIdentifiers([
    ...Object.values(crossReferences).flat(),
    ...definitions.flatMap((entry) => entry.references || []),
  ]);

  return { title, articles, recitals, annexes, definitions, langCode, crossReferences, parserVersion: PARSER_VERSION };
}
