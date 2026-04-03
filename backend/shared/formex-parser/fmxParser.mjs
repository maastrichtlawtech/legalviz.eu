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

/**
 * Bump this whenever the parser output changes (new fields, bug fixes, etc.)
 * so that cached parsed results are automatically re-parsed from raw XML.
 */
export const PARSER_VERSION = 1;

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
const EXTERNAL_LAW_RE =
  /(?:Regulation|Directive|Decision|Verordnung|Verordnung|Richtlinie|Beschluss|R\u00e8glement|Directive|D\u00e9cision|Reglamento|Directiva|Decisi\u00f3n|Regolamento|Direttiva|Decisione|Regulamento|Diretiva|Decis\u00e3o|Verordening|Richtlijn|Besluit|F\u00f6rordning|Direktiv|Beslut|Forordning|Direktiv|Asetus|Direktiivi|P\u00e4\u00e4t\u00f6s|Na\u0159\u00edzen\u00ed|Sm\u011brnice|Rozhodnut\u00ed|Nariadenie|Smernica|Rozhodnutie|Rendelet|Irányelv|Hat\u00e1rozat|Regulamentul|Directiva|Decizia|Regolamento|Naredba|Odluka|Uredba|Direktiva|Regula|Direktīva|Lēmums|Reglamentas|Direktyva|Sprendimas|Regul\u0101ci\u0101|Direktīva|Rendelet|\u039a\u03b1\u03bd\u03bf\u03bd\u03b9\u03c3\u03bc\u03cc\u03c2|\u039f\u03b4\u03b7\u03b3\u03af\u03b1|\u0391\u03c0\u03cc\u03c6\u03b1\u03c3\u03b7|Regolament|Direttiva|De\u010bizjoni|\u0420\u0435\u0433\u043b\u0430\u043c\u0435\u043d\u0442|\u0414\u0438\u0440\u0435\u043a\u0442\u0438\u0432\u0430|\u0420\u0435\u0448\u0435\u043d\u0438\u0435|Uredba|Direktiva|Odluka|Rialachán|Treoir|Cinneadh)\s+(?:\([A-Z]+\)\s+)?(?:No\.?\s+)?(\d{2,4}\/\d+(?:\/[A-Z]+)?)/gi;

function inferExternalActType(raw = "") {
  if (!raw) return null;
  const value = raw.toLowerCase();
  if (/\b(directive|directiva|direttiva|diretiva|richtlijn|direktiv|smernica|směrnice|treoir|οδηγία|директива|direktyva|direktīva|direktiva|irányelv)\b/i.test(value)) {
    return "directive";
  }
  if (/\b(regulation|reglamento|regolamento|regulamento|verordnung|verordening|förordning|forordning|nariadenie|nařízení|rialachán|κανονισμός|регламент|reglamentas|regulamentul|uredba|asetus|rendelet)\b/i.test(value)) {
    return "regulation";
  }
  if (/\b(decision|decisión|decisione|decisão|beschluss|besluit|beslut|rozhodnutie|rozhodnutí|cinneadh|απόφαση|решение|sprendimas|lēmums|odluka|határozat)\b/i.test(value)) {
    return "decision";
  }
  return null;
}

function normalizeExternalYear(yearPart) {
  if (!yearPart) return null;
  if (yearPart.length === 4) return yearPart;
  if (yearPart.length !== 2) return null;
  const year = parseInt(yearPart, 10);
  if (Number.isNaN(year)) return null;
  return String(year >= 50 ? 1900 + year : 2000 + year);
}

function parseExternalLawMeta(raw, target) {
  const actType = inferExternalActType(raw);
  const match = (target || "").match(/^(\d{2,4})\/(\d+)(?:\/([A-Z]+))?$/i);
  if (!match) {
    return { actType, identifier: target || null, year: null, number: null, suffix: null };
  }

  const first = match[1];
  const second = match[2];
  const suffix = match[3] || null;

  let year = null;
  let number = null;

  if (first.length === 4) {
    year = first;
    number = second;
  } else if (second.length === 4) {
    year = second;
    number = first;
  } else if (first.length === 2) {
    year = normalizeExternalYear(first);
    number = second;
  }

  return {
    actType,
    identifier: target || null,
    year,
    number,
    suffix,
  };
}

function getArticleExternalConnectorRe(langCode = "EN") {
  switch (String(langCode || "").toUpperCase()) {
    case "DE":
      return /^\s+der\s+$/i;
    case "FR":
      return /^\s+du\s+$/i;
    case "ES":
      return /^\s+del\s+$/i;
    case "IT":
      return /^\s+del\s+$/i;
    case "PT":
      return /^\s+do\s+$/i;
    case "NL":
      return /^\s+van\s+$/i;
    default:
      return /^\s+of\s+$/i;
  }
}

function mergeArticleRefsWithExternalContext(text, articleRefs, externalRefs, langCode) {
  const connectorRe = getArticleExternalConnectorRe(langCode);
  const mergedExternalIndices = new Set();
  const mergedArticles = new Set();
  const contextualExternalRefs = [];

  for (let i = 0; i < articleRefs.length; i++) {
    const articleRef = articleRefs[i];
    const externalIndex = externalRefs.findIndex((externalRef, idx) => (
      !mergedExternalIndices.has(idx)
      && externalRef.start >= articleRef.end
      && connectorRe.test(text.slice(articleRef.end, externalRef.start))
    ));

    if (externalIndex === -1) continue;

    const externalRef = externalRefs[externalIndex];
    mergedArticles.add(i);
    mergedExternalIndices.add(externalIndex);
    contextualExternalRefs.push({
      ...externalRef,
      start: articleRef.start,
      raw: text.slice(articleRef.start, externalRef.end),
      articleNumber: articleRef.target,
      paragraph: articleRef.paragraph,
      point: articleRef.point,
    });
  }

  return {
    articleRefs: articleRefs.filter((_, index) => !mergedArticles.has(index)),
    externalRefs: [
      ...externalRefs.filter((_, index) => !mergedExternalIndices.has(index)),
      ...contextualExternalRefs,
    ],
  };
}

/**
 * Extract cross-references from a text string, using language-specific patterns.
 * Returns an array of { type, target, paragraph, point, raw } objects.
 *
 * @param {string} text  Plain text to scan
 * @param {object} lang  Language config from getLangConfig()
 */
function extractCrossRefsFromText(text, lang) {
  const refs = [];
  const seen = new Set();
  const articleRefs = [];
  const recitalRefs = [];
  const externalRefs = [];

  function addRef(ref) {
    const key = `${ref.type}:${ref.target}:${ref.paragraph || ""}:${ref.point || ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push(ref);
    }
  }

  // Article references (language-specific word)
  const artRe = buildArticleRefRe(lang);
  artRe.lastIndex = 0;
  let m;
  while ((m = artRe.exec(text)) !== null) {
    // Group indices depend on whether num-first or word-first
    // For word-first (standard): groups are (full, artNum, para, point, rangeTo)
    // We just use the article regex to find the number
    const artMatch = lang.article.exec(m[0]);
    if (!artMatch) continue;
    const artNum = artMatch[1];
    // Try to find paragraph and point from the original match
    const paraMatch = m[0].match(/\((\d+)\)/);
    const pointMatch = m[0].match(/\(([a-z])\)/i);
    const rangeMatch = m[0].match(/\s+(?:to|and)\s+(\d+[a-z]?\b)/i);
    if (rangeMatch) {
      const from = parseInt(artNum, 10);
      const to = parseInt(rangeMatch[1], 10);
      if (!isNaN(from) && !isNaN(to) && to >= from && to - from <= 50) {
        for (let i = from; i <= to; i++) {
          articleRefs.push({
            type: "article",
            target: String(i),
            paragraph: null,
            point: null,
            raw: m[0],
            start: m.index,
            end: m.index + m[0].length,
          });
        }
      } else {
        articleRefs.push({
          type: "article",
          target: artNum,
          paragraph: null,
          point: null,
          raw: m[0],
          start: m.index,
          end: m.index + m[0].length,
        });
      }
    } else {
      articleRefs.push({
        type: "article",
        target: artNum,
        paragraph: paraMatch ? paraMatch[1] : null,
        point: pointMatch ? pointMatch[1] : null,
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
    externalRefs.push({
      type: "external",
      target: m[1],
      raw: m[0],
      start: m.index,
      end: m.index + m[0].length,
      ...parseExternalLawMeta(m[0], m[1]),
    });
  }

  const mergedRefs = mergeArticleRefsWithExternalContext(text, articleRefs, externalRefs, lang.code);

  for (const ref of mergedRefs.articleRefs) addRef(ref);
  for (const ref of recitalRefs) addRef(ref);
  for (const ref of mergedRefs.externalRefs) addRef(ref);

  return refs;
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
    const wordPart = src.split(/\\s\+\(\\d/)[0];
    articleInjectRe = new RegExp(
      `\\b(${wordPart}s?\\s+\\d+[a-z]?\\b(?:\\(\\d+\\))?(?:\\([a-z]\\))?)`,
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

    const articleRefs = [];
    const externalRefs = [];

    articleInjectRe.lastIndex = 0;
    let match;
    while ((match = articleInjectRe.exec(text)) !== null) {
      const articleMatch = lang.article.exec(match[0]);
      lang.article.lastIndex = 0;
      if (!articleMatch) continue;
      const paraMatch = match[0].match(/\((\d+)\)/);
      const pointMatch = match[0].match(/\(([a-z])\)/i);
      articleRefs.push({
        start: match.index,
        end: match.index + match[0].length,
        kind: "article",
        articleNumber: articleMatch[1],
        paragraph: paraMatch ? paraMatch[1] : null,
        point: pointMatch ? pointMatch[1] : null,
        label: match[0],
      });
    }

    EXTERNAL_LAW_RE.lastIndex = 0;
    while ((match = EXTERNAL_LAW_RE.exec(text)) !== null) {
      const meta = parseExternalLawMeta(match[0], match[1]);
      externalRefs.push({
        start: match.index,
        end: match.index + match[0].length,
        kind: "external",
        target: match[1],
        label: match[0],
        ...meta,
      });
    }

    const mergedRefs = mergeArticleRefsWithExternalContext(
      text,
      articleRefs.map((ref) => ({
        start: ref.start,
        end: ref.end,
        target: ref.articleNumber,
        paragraph: ref.paragraph,
        point: ref.point,
      })),
      externalRefs,
      lang.code
    );

    const refs = [
      ...mergedRefs.articleRefs.map((ref) => ({
        kind: "article",
        start: ref.start,
        end: ref.end,
        articleNumber: ref.target,
        paragraph: ref.paragraph,
        point: ref.point,
        label: text.slice(ref.start, ref.end),
      })),
      ...mergedRefs.externalRefs.map((ref) => ({
        ...ref,
        kind: "external",
        label: ref.raw || text.slice(ref.start, ref.end),
      })),
    ];

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
        link.setAttribute("href", buildEurlexSearchUrl(ref.label, lang.code));
        link.setAttribute("target", "_blank");
        link.setAttribute("rel", "noopener noreferrer");
        link.setAttribute("title", `Open ${ref.target} on EUR-Lex`);
        link.setAttribute("data-ref-raw", ref.label);
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

  // For combined documents, the ACT is a child element
  const root = docRoot.tagName === "COMBINED.FMX"
    ? docRoot.querySelector("ACT") || docRoot
    : docRoot;

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

  // Extract short title from parentheses (e.g. "General Data Protection Regulation")
  let shortTitle = "";
  for (const part of titleParts) {
    const m = part.match(/\(([^)]{5,80})\)/);
    if (m && !lang.eea.test(m[1])) {
      shortTitle = m[1];
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
    .replace(/\b(Eu|Ec|Eec|Euratom)\b/gi, m => m.toUpperCase());

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
        const fullText = allText(child);
        const textRefs = extractCrossRefsFromText(fullText, lang);
        // Also extract structural OJ references from the XML
        const ojRefs = extractOjRefsFromElement(child);
        const allRefs = [...textRefs, ...ojRefs];

        // Deduplicate and exclude self-references
        const seenKeys = new Set();
        const uniqueRefs = allRefs.filter(r => {
          if (r.type === "article" && r.target === article_number) return false;
          const key = `${r.type}:${r.target}:${r.paragraph || ""}:${r.point || ""}`;
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

  const enactingTerms = root.querySelector("ENACTING\\.TERMS");
  if (enactingTerms) {
    // ENACTING.TERMS is the container above the first real DIVISION, so start
    // one level higher to make the first nested DIVISION a chapter.
    walkDivisions(enactingTerms, { number: "", title: "" }, { number: "", title: "" }, -1);
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

        if (lang.definitionFormat === "verb_first") {
          // Verb-first languages (GA, IT, ES, PT): meansVerb 'term' definition
          const termMatch = text.match(meansRegex);
          if (termMatch) {
            const term = termMatch[1].trim();
            const definition = text.slice(termMatch[0].length).trim();
            definitions.push({ term, definition });
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
            definitions.push({ term, definition });
          } else {
            const fbMatch = text.match(fallbackDefRegex);
            if (fbMatch) {
              const term = fbMatch[1].trim();
              const definition = text.slice(fbMatch[0].length).trim();
              if (term && definition) definitions.push({ term, definition });
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
      const key = `${ref.type}:${ref.target}:${ref.paragraph || ""}:${ref.point || ""}`;
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

    annexes.push({ annex_id, annex_title, annex_html });

    const annexText = allText(annexEl);
    const textRefs = extractCrossRefsFromText(annexText, lang);
    const ojRefs = extractOjRefsFromElement(annexEl);
    const seenKeys = new Set();
    const uniqueRefs = [...textRefs, ...ojRefs].filter((ref) => {
      const key = `${ref.type}:${ref.target}:${ref.paragraph || ""}:${ref.point || ""}:${ref.ojColl || ""}:${ref.ojYear || ""}:${ref.ojNo || ""}`;
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });

    if (uniqueRefs.length > 0) {
      crossReferences[`annex_${annex_id}`] = uniqueRefs;
    }
  }

  return { title, articles, recitals, annexes, definitions, langCode, crossReferences, parserVersion: PARSER_VERSION };
}
