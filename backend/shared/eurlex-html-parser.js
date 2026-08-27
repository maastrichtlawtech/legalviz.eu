const { JSDOM } = require("jsdom");
const { createRequire } = require("module");

const { ClientError, LANG_3_TO_2 } = require("./api-utils");
const { referenceDedupeKey, enforceInternalReferenceIntegrity } = require("./legal-reference-core.mjs");
// languages.mjs is pure data + regex builders with no DOM dependency, so it can
// be require(esm)'d at load time — unlike fmxParser.mjs, which needs the
// DOMParser shim installed by loadHelpers() first.
const {
  getLangConfig,
  buildMeansRegex,
  buildFallbackDefRegex,
  buildInlineDefRegex,
  buildColonDefRegex,
} = require("./formex-parser/languages.mjs");

let helperPromise = null;
const requireFromHere = createRequire(__filename);
let escapeHtml;
let maxDefinitionContinuationParagraphs;
const DEFAULT_PLAYWRIGHT_RETRIES = 3;
const DEFAULT_BROWSER_IDLE_MS = 30_000; // close browser after 30s idle to save RAM
let sharedPlaywrightBrowser = null;
let sharedPlaywrightBrowserKey = null;
let sharedPlaywrightPage = null;
let browserIdleTimer = null;

function normalizeText(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripLeadingMarker(text, markerRegex) {
  return normalizeText(String(text || "").replace(markerRegex, ""));
}

function isArticleHeading(text) {
  return /^Article\s+\d+[A-Za-z]*$/i.test(text);
}

function isAnnexHeading(text) {
  return /^ANNEX(?:\s+[IVXLCDM0-9A-Za-z]+)?$/i.test(text);
}

function isLikelyArticleTitle(text) {
  if (!text) return false;
  if (isArticleHeading(text) || isAnnexHeading(text)) return false;
  if (/^\d+\./.test(text)) return false;
  if (/^\([a-z0-9ivxlcdm]+\)/i.test(text)) return false;
  if (/^[-\u2010-\u2015]/.test(text)) return false;
  if (text.length > 180) return false;
  return !/[.:;!?]$/.test(text);
}

function parseDivisionMarker(text) {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  const match = normalized.match(/^(TITLE|CHAPTER|SECTION)\s+([IVXLCDM0-9A-Z]+)(?:\s+(.*))?$/i);
  if (!match) return null;

  return {
    kind: match[1].toLowerCase(),
    number: `${match[1].toUpperCase()} ${match[2]}`,
    title: normalizeText(match[3] || ""),
  };
}

function isLikelyDivisionTitle(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  if (isArticleHeading(normalized) || isAnnexHeading(normalized) || parseDivisionMarker(normalized)) return false;
  if (normalized.length > 220) return false;
  const letters = normalized.replace(/[^A-Za-z]/g, "");
  if (!letters) return false;
  return normalized === normalized.toUpperCase();
}

function paragraphsToHtml(paragraphs, { title = null } = {}) {
  const html = [];
  if (title) {
    html.push(`<p class="oj-sti-art">${escapeHtml(title)}</p>`);
  }
  paragraphs
    .map((paragraph) => normalizeText(paragraph))
    .filter(Boolean)
    .forEach((paragraph) => {
      html.push(`<p>${escapeHtml(paragraph)}</p>`);
    });
  return html.join("");
}

function formatStructuredTitle(text, langConfig) {
  if (!text) return "";
  let short = String(text || "");
  if (langConfig?.titleSplit) {
    short = short.split(langConfig.titleSplit)[0];
  }
  return normalizeText(short)
    .toLowerCase()
    .replace(/(?:^|\s)\S/g, (match) => match.toUpperCase())
    .replace(/\b(Eu|Ec|Eec|Euratom|Ue|We)\b/gi, (match) => match.toUpperCase());
}

// --- Definitions -----------------------------------------------------------
//
// Definitions in legacy HTML come in many more shapes than the Formex ones, and
// the older the act the less it looks like a modern regulation:
//
//   (a) 'personal data' shall mean any information …   95/46/EC  — "shall mean"
//   (c) "established service provider": a service …    2000/31/EC — colon, no verb
//   (a) 'television broadcasting' means the initial …  89/552/EEC — untitled article
//   For the purpose of this Directive 'product' means … 85/374/EEC — prose, no points
//   1. Proprietary medicinal product: Any ready-prepared … 2001/83/EC — unquoted
//
// Two rules keep this from degenerating into false positives. The term is
// normally quote-delimited (see buildInlineDefRegex for why), and an article
// that does not declare itself as the definitions article by title has to
// corroborate itself with two or more entries. The unquoted shape has no
// pattern of its own to rely on, so it carries the extra restrictions in
// unquotedDefinitionEntry() and a corroboration bar of its own.

const definitionMatcherCache = new Map();

function definitionMatchers(langConfig) {
  const lang = langConfig?.code ? langConfig : getLangConfig("EN");
  let matchers = definitionMatcherCache.get(lang.code);
  if (!matchers) {
    matchers = {
      lang,
      means: buildMeansRegex(lang),
      fallback: buildFallbackDefRegex(lang),
      inline: buildInlineDefRegex(lang),
      colon: buildColonDefRegex(lang),
    };
    definitionMatcherCache.set(lang.code, matchers);
  }
  return matchers;
}

// "(a) ", "a) ", "(1) ", "1. " — the point label introducing one definition.
const DEFINITION_POINT_MARKER = /^\(?\s*([a-z]{1,2}|\d{1,3})\s*[).]\s+/i;
// The same label alone in its own paragraph, with the definition following in
// the next one (how tabulated points flatten when the table is stripped).
const DEFINITION_POINT_ONLY = /^\(?\s*([a-z]{1,2}|\d{1,3})\s*\)?\.?$/i;

// "(a)" / "1." / "—" → "a" / "1" / null. Dash-bulleted definition lists carry
// no point label, and a bullet character is not one.
function definitionPointLabel(text) {
  const label = normalizeText(text).replace(/^\(|[).]+$/g, "");
  return /^(?:[a-z]{1,2}|\d{1,3})$/i.test(label) ? label : null;
}

function cleanDefinitionText(text) {
  return normalizeText(text).replace(/[;,]+$/, "").trim();
}

// One point's text ("'term' shall mean …") into { term, definition }, or null.
// A `definition` of "" means the point opened with "'term' means:" and its body
// is in the paragraphs that follow — the caller closes it.
function splitDefinitionEntry(text, matchers, { allowUnquoted = false } = {}) {
  const entryText = normalizeText(text);
  if (!entryText) return null;

  const meansMatch = entryText.match(matchers.means);
  if (meansMatch?.[1]) {
    return {
      term: normalizeText(meansMatch[1]),
      definition: cleanDefinitionText(entryText.slice(meansMatch[0].length)),
    };
  }

  const fallbackMatch = entryText.match(matchers.fallback);
  if (fallbackMatch?.[1]) {
    const definition = cleanDefinitionText(entryText.slice(fallbackMatch[0].length));
    const term = normalizeText(fallbackMatch[1]);
    if (term && definition) return { term, definition };
  }

  return allowUnquoted ? unquotedDefinitionEntry(entryText, matchers) : null;
}

// Maximum words in an unquoted term. Definienda are noun phrases ("proprietary
// medicinal product"); a clause long enough to need more words than this is
// prose that happens to contain a colon.
const MAX_UNQUOTED_TERM_WORDS = 6;

// "consumer: shall mean any natural person …" — no quotation marks anywhere, so
// nothing but the shape of the text says this is a definition. Kept separate
// from the quoted forms because the caller has to hold it to a higher bar.
function unquotedDefinitionEntry(entryText, matchers) {
  const colonMatch = entryText.match(matchers.colon);
  if (!colonMatch?.[1]) return null;
  const term = normalizeText(colonMatch[1]);
  if (!term || term.split(/\s+/).length > MAX_UNQUOTED_TERM_WORDS) return null;
  const definition = cleanDefinitionText(entryText.slice(colonMatch[0].length));
  if (definition.length < 20) return null;
  return { term, definition, unquoted: true };
}

// Sentence-per-definition prose: each quoted term runs to the end of its own
// sentence. Only used when the article has no lettered points at all, since a
// pointed definition routinely spans several sentences.
function extractInlineDefinitions(text, matchers, sourceArticle) {
  const definitions = [];
  for (const sentence of String(text).split(/(?<=\.)\s+(?=[‘“«"'A-Z])/)) {
    matchers.inline.lastIndex = 0;
    const match = matchers.inline.exec(sentence);
    if (!match?.[1]) continue;
    const definition = cleanDefinitionText(sentence.slice(match.index + match[0].length))
      .replace(/\.$/, "");
    if (!definition) continue;
    definitions.push({
      term: normalizeText(match[1]),
      definition,
      sourceArticle,
      sourcePoint: null,
    });
  }
  return definitions;
}

// How many paragraphs an open "'term' means:" may absorb before we assume the
// definition ended and we are just eating the rest of the article.
function parseDefinitionParagraphs(paragraphs, sourceArticle, matchers) {
  const items = [];
  let pendingPoint = null;

  for (const raw of paragraphs) {
    const paragraph = normalizeText(raw);
    if (!paragraph) continue;

    if (pendingPoint) {
      items.push({ sourcePoint: pendingPoint, text: paragraph });
      pendingPoint = null;
      continue;
    }

    // A point label alone in its paragraph, with its text in the next one.
    const pointOnly = paragraph.match(DEFINITION_POINT_ONLY);
    if (pointOnly) {
      pendingPoint = normalizeText(pointOnly[1]);
      continue;
    }

    const marker = paragraph.match(DEFINITION_POINT_MARKER);
    items.push(marker
      ? { sourcePoint: normalizeText(marker[1]), text: paragraph.slice(marker[0].length) }
      : { sourcePoint: null, text: paragraph, unmarked: true });
  }

  const definitions = [];
  let open = null;

  const closeOpen = () => {
    if (!open) return;
    const definition = cleanDefinitionText(open.body.join(" "));
    if (definition) definitions.push({ ...open.entry, definition });
    open = null;
  };

  for (const item of items) {
    // The unquoted shape is only offered numbered/lettered points — in loose
    // prose it would match almost any sentence containing a colon.
    const parsed = splitDefinitionEntry(item.text, matchers, { allowUnquoted: !item.unmarked });

    if (parsed) {
      closeOpen();
      const entry = { ...parsed, sourceArticle, sourcePoint: item.sourcePoint };
      // "'term' means:" — the body is in the paragraphs that follow.
      if (entry.definition) definitions.push(entry);
      else open = { entry, body: [] };
      continue;
    }

    if (open && open.body.length < maxDefinitionContinuationParagraphs) {
      const line = item.sourcePoint ? `(${item.sourcePoint}) ${item.text}` : item.text;
      // Some renderings emit each sub-point twice (tabulated, then flattened).
      if (line !== open.body[open.body.length - 1]) open.body.push(line);
    }
  }
  closeOpen();

  if (!definitions.length) {
    for (const item of items) {
      if (!item.unmarked) continue;
      definitions.push(...extractInlineDefinitions(item.text, matchers, sourceArticle));
    }
  }

  return definitions;
}

// How many unquoted "term: definition" points an untitled article must carry
// before they are believed.
const MIN_UNQUOTED_DEFINITIONS = 3;

// An article titled "Definitions" is self-declaring and a single entry is
// enough. Pre-2000 acts frequently carry no article titles at all, so there
// the only available signal is repetition — one lone match in an untitled
// article is more likely a quotation than a definitions list.
function acceptArticleDefinitions(article, definitions, matchers) {
  // EUR-Lex nests the definition tables inside a layout table in some
  // renderings, and repeats them as flat paragraphs in others, so one point can
  // be reached twice within an article. The copies are not equivalent — the
  // outer one carries any sub-points the inner row cuts off ("'main
  // establishment' means: (a) … (b) …") — so keep the fullest text rather than
  // the first one seen.
  const titled = matchers.lang.definition?.test(article?.article_title || "");

  // An unquoted term rests on nothing but a colon, so a couple of them could
  // easily be ordinary prose. Require either a self-declaring article title or
  // a run of them — a genuine unquoted definitions list is never two items
  // long in practice.
  const unquotedCount = definitions.filter((entry) => entry.unquoted).length;
  const keepUnquoted = titled || unquotedCount >= MIN_UNQUOTED_DEFINITIONS;

  const byPoint = new Map();
  for (const entry of definitions) {
    if (entry.unquoted && !keepUnquoted) continue;
    const key = `${entry.sourcePoint || ""} ${entry.term.toLowerCase()}`;
    const kept = byPoint.get(key);
    if (!kept || entry.definition.length > kept.definition.length) byPoint.set(key, entry);
  }
  const unique = [...byPoint.values()].map(({ unquoted, ...entry }) => entry);

  if (!unique.length) return [];
  if (titled) return unique;
  return unique.length >= 2 ? unique : [];
}

function parseStructuredHtmlDefinitions(article, langConfig, parser) {
  const html = article?.article_html || "";
  const matchers = definitionMatchers(langConfig);
  const titled = matchers.lang.definition?.test(article?.article_title || "");
  // Every candidate needs either a quoted term or a tabulated layout; skipping
  // the rest keeps this off the DOM for most articles during bulk corpus runs.
  if (!titled && !/<table/i.test(html) && !/[‘’“”«»"'`]/.test(html)) {
    return [];
  }

  const doc = parser.parseFromString(html, "text/html");
  const sourceArticle = article.article_number;
  const definitions = [];

  for (const table of doc.querySelectorAll("table")) {
    const cells = table.querySelectorAll("td");
    if (cells.length < 2) continue;
    const parsed = splitDefinitionEntry(normalizeText(cells[1].textContent), matchers);
    if (!parsed) continue;
    definitions.push({
      ...parsed,
      sourceArticle,
      sourcePoint: definitionPointLabel(cells[0].textContent),
    });
  }

  // Untabulated (or tabulated-but-unparsed) articles: fall back to the flat
  // paragraph shape, which is also how the tables flatten in some renderings.
  if (!definitions.length) {
    const paragraphs = Array.from(doc.querySelectorAll("p"))
      .map((paragraph) => normalizeText(paragraph.textContent));
    definitions.push(...parseDefinitionParagraphs(paragraphs, sourceArticle, matchers));
  }

  return acceptArticleDefinitions(article, definitions, matchers);
}

function parseStructuredHtmlToCombined(document, langCode, langConfig, injectCrossRefLinks) {
  const getText = (element) => normalizeText(element?.textContent || "");
  const innerHTML = (element) => (
    element
      ? Array.from(element.childNodes)
        .map((node) => (node.nodeType === 1 ? node.outerHTML : node.textContent))
        .join("")
      : ""
  );

  const articles = [];
  const recitals = [];
  const annexes = [];
  const parser = new global.DOMParser();

  let title = "";
  const titleEl = document.querySelector(".oj-doc-ti, .doc-ti, .title-doc-first");
  const mainTitle = titleEl ? formatStructuredTitle(getText(titleEl), langConfig) : "";
  let shortTitle = "";
  for (const element of document.querySelectorAll(".oj-doc-ti, .doc-ti")) {
    const match = getText(element).match(/\(([^)]+)\)$/);
    if (!match) continue;
    const candidate = normalizeText(match[1]);
    if (
      candidate.length > 3 &&
      candidate.length < 100 &&
      !(langConfig?.eea?.test(candidate))
    ) {
      shortTitle = candidate;
      break;
    }
  }
  title = shortTitle && mainTitle && !mainTitle.includes(shortTitle)
    ? `${shortTitle} — ${mainTitle}`
    : shortTitle || mainTitle;

  let currentChapter = { number: "", title: "" };
  let currentSection = { number: "", title: "" };
  let pendingHeader = null;

  const walker = document.createTreeWalker(document.body || document, global.NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) {
    const element = walker.currentNode;
    if (!element || element.nodeType !== 1) continue;

    if (
      element.tagName === "P" &&
      (element.classList.contains("title-division-1") || element.classList.contains("oj-ti-section-1"))
    ) {
      const text = getText(element);
      if (langConfig?.chapter?.test(text)) {
        currentChapter = { number: text, title: "" };
        currentSection = { number: "", title: "" };
        pendingHeader = "chapter";
      } else if (langConfig?.section?.test(text)) {
        currentSection = { number: text, title: "" };
        pendingHeader = "section";
      } else {
        currentChapter = { number: text, title: "" };
        currentSection = { number: "", title: "" };
        pendingHeader = "chapter";
      }
    }

    if (
      element.tagName === "P" &&
      (element.classList.contains("title-division-2") || element.classList.contains("oj-ti-section-2"))
    ) {
      const text = getText(element);
      if (pendingHeader === "chapter") currentChapter.title = text;
      if (pendingHeader === "section") currentSection.title = text;
      pendingHeader = null;
    }

    if (element.tagName === "DIV" && element.classList.contains("eli-subdivision") && String(element.id || "").startsWith("rct_")) {
      const cells = element.querySelectorAll("table td");
      if (cells.length >= 2) {
        const numberMatch = getText(cells[0]).match(/\(?\s*(\d+)\s*\)?/);
        const recital_number = numberMatch ? numberMatch[1] : getText(cells[0]) || String(recitals.length + 1);
        const recitalHtml = innerHTML(cells[1]);
        recitals.push({
          recital_number,
          recital_text: getText(cells[1]),
          recital_html: injectCrossRefLinks(recitalHtml, langConfig),
        });
      }
      continue;
    }

    if (element.tagName === "P" && element.classList.contains("oj-ti-art")) {
      let container = element.parentElement;
      while (container && !(container.tagName === "DIV" && container.classList.contains("eli-subdivision"))) {
        container = container.parentElement;
      }
      const numberMatch = getText(element).match(langConfig?.article || /Article\s+(\d+[a-z]*)/i);
      const article_number = numberMatch ? numberMatch[1] : getText(element);
      const titleBlock = container ? container.querySelector("div.eli-title p.oj-sti-art") : null;
      const article_title = titleBlock ? getText(titleBlock) : "";
      articles.push({
        article_number,
        article_title,
        division: {
          chapter: { number: currentChapter.number, title: currentChapter.title },
          section: currentSection.number ? { number: currentSection.number, title: currentSection.title } : null,
        },
        article_html: injectCrossRefLinks(innerHTML(container || element.parentElement), langConfig),
      });
      continue;
    }

    if (element.tagName === "DIV" && element.classList.contains("eli-subdivision")) {
      const numParagraph = element.querySelector("p.title-article-norm");
      if (numParagraph) {
        const numberMatch = getText(numParagraph).match(langConfig?.article || /Article\s+(\d+[a-z]*)/i);
        const article_number = numberMatch ? numberMatch[1] : getText(numParagraph);
        const titleParagraph = element.querySelector("p.stitle-article-norm");
        const article_title = titleParagraph ? getText(titleParagraph) : "";
        articles.push({
          article_number,
          article_title,
          division: {
            chapter: { number: currentChapter.number, title: currentChapter.title },
            section: currentSection.number ? { number: currentSection.number, title: currentSection.title } : null,
          },
          article_html: injectCrossRefLinks(innerHTML(element), langConfig),
        });
      }
    }

    if (element.tagName === "P") {
      const text = getText(element);
      const looksLikeAnnex =
        (langConfig?.annex?.test(text)) ||
        element.classList.contains("oj-ti-annex") ||
        element.classList.contains("oj-ti-annex-1") ||
        element.classList.contains("title-annex-norm");

      if (looksLikeAnnex) {
        let annexTitle = text;
        let subtitle = element.parentElement?.querySelector("div.eli-title p, p.oj-ti-annex-2, p.stitle-annex-norm");
        if (!subtitle) {
          const next = element.nextElementSibling;
          if (next && next.tagName === "P" && (next.classList.contains("oj-doc-ti") || next.classList.contains("oj-normal"))) {
            subtitle = next;
          }
        }
        if (subtitle) annexTitle = `${text} — ${getText(subtitle)}`;

        let container = element.parentElement;
        while (container && !(container.tagName === "DIV" && container.classList.contains("eli-subdivision"))) {
          container = container.parentElement;
        }
        const root = container || element.parentElement || element;
        const annexMatch = text.match(langConfig?.annexCapture || /^ANNEX\s*([IVXLC]+|\d+)?/i);
        const annex_id = annexMatch ? normalizeText(annexMatch[1] || "") || annexTitle : annexTitle;
        annexes.push({
          annex_id,
          annex_title: annexTitle,
          annex_html: injectCrossRefLinks(innerHTML(root), langConfig),
        });
      }
    }
  }

  // Scanned across every article rather than only the one titled
  // "Definitions": older acts carry no article titles at all, so the title
  // lookup found nothing and silently returned no definitions for them.
  const definitions = articles.flatMap(
    (article) => parseStructuredHtmlDefinitions(article, langConfig, parser),
  );

  recitals.sort((left, right) => {
    const leftNum = Number.parseInt(String(left.recital_number).replace(/\D+/g, ""), 10) || 0;
    const rightNum = Number.parseInt(String(right.recital_number).replace(/\D+/g, ""), 10) || 0;
    return leftNum - rightNum;
  });

  return {
    title,
    articles,
    recitals,
    annexes,
    definitions,
    langCode,
    crossReferences: {},
  };
}

function parseDefinitions(article, langConfig) {
  const paragraphs = article?.bodyParagraphs || [];
  if (!paragraphs.length) return [];
  const matchers = definitionMatchers(langConfig);
  const definitions = parseDefinitionParagraphs(paragraphs, article.article_number, matchers);
  return acceptArticleDefinitions(article, definitions, matchers);
}

function buildRecital(recitalNumber, text, html) {
  const recitalText = normalizeText(text);
  return {
    recital_number: String(recitalNumber),
    recital_text: recitalText,
    recital_html: html || `<p>${escapeHtml(recitalText)}</p>`,
  };
}

function parseRecitals(paragraphs, articleStartIndex) {
  const recitals = [];
  let current = null;

  for (let index = 0; index < articleStartIndex; index += 1) {
    const paragraph = paragraphs[index];
    // Recitals always precede the enacting formula; stop before it so the
    // "HAS ADOPTED …" line is never folded into the last recital (relevant when
    // the caller scans the whole preamble rather than a "Whereas:"-delimited block).
    if (ENACTING_FORMULA.test(normalizeText(paragraph))) break;
    const match = paragraph.match(/^\((\d+)\)\s*(.*)$/);
    if (match) {
      // Skip "(N) OJ No L …" footnote-citation lines — they carry a numbered
      // marker like a recital but are Official-Journal references, not recitals.
      // Treating them as recitals both fabricates junk and suppresses the
      // unnumbered-"Whereas" fallback for acts whose real recitals aren't numbered.
      if (/^OJ\b/i.test(match[2])) continue;
      if (current) recitals.push(current);
      current = {
        recital_number: match[1],
        chunks: [normalizeText(match[2])],
      };
      continue;
    }

    if (!current) continue;
    if (!paragraph) continue;
    current.chunks.push(normalizeText(paragraph));
  }

  if (current) recitals.push(current);

  return recitals.map((recital) => {
    const recitalText = normalizeText(recital.chunks.join(" "));
    return {
      recital_number: recital.recital_number,
      recital_text: recitalText,
      recital_html: `<p>${escapeHtml(recitalText)}</p>`,
    };
  });
}

// Pre-1990s EEC/ECSC acts don't number their recitals: the preamble is a run of
// paragraphs each beginning "Whereas …", sitting between the "Having regard to …"
// citations and the "HAS ADOPTED THIS DIRECTIVE:" enacting formula. parseRecitals
// (which needs "(N)" markers) finds nothing here, so this fallback treats every
// "Whereas …" paragraph as one recital, folding wrapped continuation lines (and
// mid-paragraph "; whereas …") into the current one. It stops at the enacting
// formula / first article so the "HAS ADOPTED…" line is never swallowed.
const ENACTING_FORMULA = /^(?:HAS|HAVE)\s+(?:ADOPTED|DECIDED|LAID\s+DOWN|DRAWN\s+UP)\b/i;

function parseWhereasRecitals(paragraphs, endIndex) {
  const recitals = [];
  let current = null;

  for (let index = 0; index < endIndex; index += 1) {
    const paragraph = normalizeText(paragraphs[index]);
    if (!paragraph) continue;
    if (ENACTING_FORMULA.test(paragraph) || isArticleHeading(paragraph)) break;

    if (/^whereas\b/i.test(paragraph)) {
      if (current) recitals.push(current);
      current = { chunks: [stripLeadingMarker(paragraph, /^whereas[\s,:;]*/i)] };
    } else if (current) {
      current.chunks.push(paragraph);
    }
  }
  if (current) recitals.push(current);

  return recitals.map((recital, order) =>
    buildRecital(order + 1, recital.chunks.join(" ")));
}

// Old single-provision acts (amending regs, ECSC/Euratom decisions) often carry
// no numbered "Article N" heading — the operative text follows the enacting
// formula directly, sometimes under a "SOLE ARTICLE" / "ARTICLE UNIQUE" label.
// parseArticles finds nothing in that case, so we salvage the body as Article 1.
const SOLE_ARTICLE_HEADING =
  /^(?:SOLE\s+ARTICLE|SINGLE\s+ARTICLE|ARTICLE\s+UNIQUE|ARTICLE\s+PREMIER)$/i;
const CLOSING_FORMULA =
  /^(?:THIS\s+(?:REGULATION|DIRECTIVE|DECISION)\s+SHALL\s+BE\s+BINDING|THIS\s+(?:REGULATION|DIRECTIVE|DECISION)\s+(?:IS|SHALL\s+BE)\s+ADDRESSED|DONE\s+AT\b|FOR\s+THE\s+(?:COMMISSION|COUNCIL|HIGH\s+AUTHORITY)\b)/i;

function parseSoleArticleBody(paragraphs, startIndex) {
  const body = [];
  for (let index = startIndex; index < paragraphs.length; index += 1) {
    const paragraph = normalizeText(paragraphs[index]);
    if (!paragraph) continue;
    if (isAnnexHeading(paragraph) || CLOSING_FORMULA.test(paragraph)) break;
    // Drop a leading "SOLE ARTICLE" label but keep the operative text after it.
    if (body.length === 0 && SOLE_ARTICLE_HEADING.test(paragraph)) continue;
    body.push(paragraph);
  }
  return body;
}

function hasUnnumberedDecisionBody(paragraphs) {
  const hasDecisionHeading = paragraphs.some((paragraph) =>
    /^(?:(?:COUNCIL|COMMISSION|HIGH AUTHORITY)\s+(?:DECISION|RECOMMENDATION)\b|DECISION OF THE EUROPEAN PARLIAMENT\b)/i.test(normalizeText(paragraph)),
  );
  const hasOperativeBody = paragraphs.some((paragraph) =>
    /^\d+\s*\./.test(normalizeText(paragraph))
    || /\b(?:HAS|HAVE)\s+DECIDED(?:\s+AS\s+FOLLOWS)?\s*:/i.test(normalizeText(paragraph)),
  );
  return hasDecisionHeading && hasOperativeBody;
}

function parseArticles(paragraphs) {
  const articles = [];
  let currentArticle = null;
  let currentChapter = { number: "", title: "" };
  let currentSection = { number: "", title: "" };

  const finalizeArticle = () => {
    if (!currentArticle) return;
    articles.push({
      ...currentArticle,
      bodyParagraphs: currentArticle.bodyParagraphs.filter(Boolean),
    });
    currentArticle = null;
  };

  for (let index = 0; index < paragraphs.length; index += 1) {
    const paragraph = normalizeText(paragraphs[index]);
    if (!paragraph) continue;

    const divisionMarker = parseDivisionMarker(paragraph);
    if (divisionMarker) {
      let nextTitle = divisionMarker.title;
      if (!nextTitle && isLikelyDivisionTitle(paragraphs[index + 1])) {
        nextTitle = normalizeText(paragraphs[index + 1]);
        index += 1;
      }

      if (divisionMarker.kind === "section") {
        currentSection = {
          number: divisionMarker.number,
          title: nextTitle,
        };
      } else {
        currentChapter = {
          number: divisionMarker.number,
          title: nextTitle,
        };
        currentSection = { number: "", title: "" };
      }
      continue;
    }

    if (isArticleHeading(paragraph)) {
      finalizeArticle();
      const articleNumberMatch = paragraph.match(/^Article\s+(\d+[A-Za-z]*)$/i);
      currentArticle = {
        article_number: articleNumberMatch ? articleNumberMatch[1] : String(articles.length + 1),
        article_title: "",
        titleCandidatePending: true,
        division: {
          chapter: { ...currentChapter },
          section: currentSection.number ? { ...currentSection } : null,
        },
        bodyParagraphs: [],
      };
      continue;
    }

    if (!currentArticle) continue;

    if (currentArticle.titleCandidatePending
        && isLikelyArticleTitle(paragraph) && !isLikelyDivisionTitle(paragraph)) {
      currentArticle.article_title = paragraph;
      currentArticle.titleCandidatePending = false;
      continue;
    }

    currentArticle.titleCandidatePending = false;
    currentArticle.bodyParagraphs.push(paragraph);
  }

  finalizeArticle();
  return articles;
}

// The plaintext/<TXT_TE> branch previously discarded annexes (annexes: []), so
// annex content (schedules, forms, product lists) leaked into the last article's
// body. Split the run of paragraphs after the articles by each "ANNEX"/"ANNEX I"
// heading into a distinct annex, mirroring the { annex_id, annex_title,
// annex_html } shape the structured branches emit. `startIndex` is the first
// annex heading; everything before it is articles.
function parseTxtTeAnnexes(paragraphs, startIndex, langConfig, injectFn) {
  const annexCapture = langConfig?.annexCapture || /^ANNEX\s*([IVXLCDM]+|\d+)?/i;
  const collected = [];
  let current = null;

  for (let index = startIndex; index < paragraphs.length; index += 1) {
    const paragraph = normalizeText(paragraphs[index]);
    if (!paragraph) continue;

    if (isAnnexHeading(paragraph)) {
      if (current) collected.push(current);
      const match = paragraph.match(annexCapture);
      current = {
        heading: paragraph,
        annex_id: (match && normalizeText(match[1] || "")) || paragraph,
        subtitle: "",
        body: [],
      };
      continue;
    }
    if (!current) continue;

    // A short, non-sentence line immediately under the heading is the annex
    // subtitle; everything else is body content.
    if (!current.subtitle && current.body.length === 0
        && isLikelyArticleTitle(paragraph) && !isLikelyDivisionTitle(paragraph)) {
      current.subtitle = paragraph;
      continue;
    }
    current.body.push(paragraph);
  }
  if (current) collected.push(current);

  return collected.map((annex) => ({
    annex_id: annex.annex_id,
    annex_title: annex.subtitle ? `${annex.heading} — ${annex.subtitle}` : annex.heading,
    annex_html: injectFn(paragraphsToHtml(annex.body), langConfig),
  }));
}

function parseLegacyXhtmlToCombined(document, langCode, langConfig, injectCrossRefLinks) {
  const metaTitle = document.querySelector('meta[name="WT.z_docTitle"]')?.getAttribute("content")
    || document.querySelector('meta[name="DC.description"]')?.getAttribute("content");

  const titleParagraphs = Array.from(document.querySelectorAll("p.doc-ti"))
    .map((element) => normalizeText(element.textContent))
    .filter(Boolean);
  const fallbackTitle = titleParagraphs.slice(0, 3).join(" ");
  const title = normalizeText(metaTitle || fallbackTitle);

  const blocks = Array.from(document.querySelectorAll("p, table"))
    .map((element) => ({
      tagName: element.tagName,
      classes: new Set(Array.from(element.classList || [])),
      text: normalizeText(element.textContent),
      html: element.outerHTML,
    }))
    .filter((block) => block.text);

  const recitals = [];
  const articles = [];
  const annexes = [];
  let currentChapter = { number: "", title: "" };
  let currentSection = { number: "", title: "" };
  let currentArticle = null;
  let currentAnnex = null;
  let recitalCounter = 1;

  const finalizeArticle = () => {
    if (!currentArticle) return;
    const articleHtmlParts = [];
    if (currentArticle.article_title) {
      articleHtmlParts.push(`<p class="oj-sti-art">${escapeHtml(currentArticle.article_title)}</p>`);
    }
    articleHtmlParts.push(...currentArticle.bodyHtmlBlocks);
    articles.push({
      article_number: currentArticle.article_number,
      article_title: currentArticle.article_title,
      division: currentArticle.division,
      article_html: injectCrossRefLinks(articleHtmlParts.join(""), langConfig),
      bodyParagraphs: currentArticle.bodyParagraphs.filter(Boolean),
    });
    currentArticle = null;
  };

  const finalizeAnnex = () => {
    if (!currentAnnex) return;
    annexes.push({
      annex_id: currentAnnex.annex_id,
      annex_title: currentAnnex.annex_title,
      annex_html: injectCrossRefLinks(currentAnnex.htmlBlocks.join(""), langConfig),
    });
    currentAnnex = null;
  };

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const text = block.text;
    if (!text) continue;

    const isArticleStart = block.classes.has("ti-art") || isArticleHeading(text);
    if (isArticleStart) {
      finalizeAnnex();
      finalizeArticle();

      const articleNumberMatch = text.match(/Article\s+(\d+[A-Za-z]*)/i);
      currentArticle = {
        article_number: articleNumberMatch ? articleNumberMatch[1] : String(articles.length + 1),
        article_title: "",
        division: {
          chapter: { ...currentChapter },
          section: currentSection.number ? { ...currentSection } : null,
        },
        bodyParagraphs: [],
        bodyHtmlBlocks: [],
      };
      continue;
    }

    const isAnnexStart = block.classes.has("doc-ti") && isAnnexHeading(text);
    if (isAnnexStart) {
      finalizeArticle();
      finalizeAnnex();

      let annexTitle = text;
      const nextBlock = blocks[index + 1];
      if (
        nextBlock &&
        nextBlock.tagName === "P" &&
        nextBlock.classes.has("doc-ti") &&
        !isAnnexHeading(nextBlock.text) &&
        !isArticleHeading(nextBlock.text)
      ) {
        annexTitle = `${text} — ${nextBlock.text}`;
        index += 1;
      }

      const annexMatch = text.match(/^ANNEX\s*([IVXLC]+|\d+)?/i);
      currentAnnex = {
        annex_id: normalizeText(annexMatch?.[1] || "") || annexTitle,
        annex_title: annexTitle,
        htmlBlocks: [],
      };
      continue;
    }

    const divisionMarker = parseDivisionMarker(text);
    if (divisionMarker) {
      let nextTitle = divisionMarker.title;
      const nextBlock = blocks[index + 1];
      if (
        !nextTitle &&
        nextBlock &&
        nextBlock.tagName === "P" &&
        isLikelyDivisionTitle(nextBlock.text)
      ) {
        nextTitle = nextBlock.text;
        index += 1;
      }

      if (divisionMarker.kind === "section") {
        currentSection = { number: divisionMarker.number, title: nextTitle };
      } else {
        currentChapter = { number: divisionMarker.number, title: nextTitle };
        currentSection = { number: "", title: "" };
      }
      continue;
    }

    if (currentAnnex) {
      currentAnnex.htmlBlocks.push(block.html);
      continue;
    }

    if (currentArticle) {
      if (
        !currentArticle.article_title &&
        block.tagName === "P" &&
        !block.classes.has("doc-ti") &&
        isLikelyArticleTitle(text) &&
        !isLikelyDivisionTitle(text)
      ) {
        currentArticle.article_title = text;
        continue;
      }

      currentArticle.bodyParagraphs.push(text);
      currentArticle.bodyHtmlBlocks.push(block.html);
      continue;
    }

    if (block.tagName !== "P") continue;
    if (block.classes.has("doc-ti")) continue;
    if (/^Whereas:?$/i.test(text)) continue;
    if (isLikelyDivisionTitle(text) || parseDivisionMarker(text)) continue;

    const recitalMatch = text.match(/^\((\d+)\)\s*(.*)$/);
    if (recitalMatch) {
      recitals.push(buildRecital(recitalMatch[1], recitalMatch[2], `<p>${escapeHtml(normalizeText(recitalMatch[2]))}</p>`));
      recitalCounter = Number.parseInt(recitalMatch[1], 10) + 1;
      continue;
    }

    if (block.classes.has("normal") || block.classes.has("note")) {
      recitals.push(buildRecital(recitalCounter, text, block.html));
      recitalCounter += 1;
    }
  }

  finalizeArticle();
  finalizeAnnex();

  const definitions = articles.flatMap((article) => parseDefinitions(article, langConfig));

  return {
    title,
    articles: articles.map(({ bodyParagraphs, ...article }) => article),
    recitals,
    annexes,
    definitions,
    langCode,
    crossReferences: {},
  };
}

// Commission / preparatory documents (proposals, communications) are published
// in EUR-Lex using the LegisWrite "manifestation" markup rather than the OJ
// `oj-*` classes. Articles are `<p class="Titrearticle">`, recitals are
// `<p class="li ManualConsidrant">`, divisions are `<p class="SectionTitle">`,
// and annexes start with `<p class="Annexetitre">`.
function parseLegisWriteToCombined(document, langCode, langConfig, injectCrossRefLinks) {
  const getText = (element) => normalizeText(element?.textContent);
  const hasClass = (element, name) => element.classList && element.classList.contains(name);

  const titleParts = ["Statut", "Typedudocument", "Titreobjet"]
    .map((cls) => getText(document.querySelector(`p.${cls}`)))
    .filter(Boolean);
  const title = normalizeText(titleParts.join(" "));

  const recitals = [];
  for (const element of document.querySelectorAll("p.li.ManualConsidrant")) {
    const numText = getText(element.querySelector(".num"));
    const numberMatch = numText.match(/(\d+)/);
    const recital_number = numberMatch ? numberMatch[1] : String(recitals.length + 1);
    const text = stripLeadingMarker(getText(element), /^\(\d+\)\s*/);
    recitals.push(buildRecital(recital_number, text, `<p>${escapeHtml(text)}</p>`));
  }

  const articles = [];
  const annexes = [];
  let currentChapter = { number: "", title: "" };
  let currentSection = { number: "", title: "" };
  let pendingDivision = null;
  let currentArticle = null;
  let currentAnnex = null;
  let inEnactingTerms = false;

  const finalizeArticle = () => {
    if (!currentArticle) return;
    const html = paragraphsToHtml(currentArticle.bodyParagraphs, { title: currentArticle.article_title });
    articles.push({
      article_number: currentArticle.article_number,
      article_title: currentArticle.article_title,
      division: currentArticle.division,
      article_html: injectCrossRefLinks(html, langConfig),
      bodyParagraphs: currentArticle.bodyParagraphs.filter(Boolean),
    });
    currentArticle = null;
  };

  const finalizeAnnex = () => {
    if (!currentAnnex) return;
    annexes.push({
      annex_id: currentAnnex.annex_id,
      annex_title: currentAnnex.annex_title,
      annex_html: injectCrossRefLinks(paragraphsToHtml(currentAnnex.bodyParagraphs), langConfig),
    });
    currentAnnex = null;
  };

  for (const element of document.body.querySelectorAll("p")) {
    const text = getText(element);
    if (!text) continue;

    if (hasClass(element, "Formuledadoption")) {
      inEnactingTerms = true;
      continue;
    }

    if (hasClass(element, "Annexetitre")) {
      finalizeArticle();
      finalizeAnnex();
      inEnactingTerms = true;
      pendingDivision = null;
      const annexMatch = text.match(/^ANNEX\s*([IVXLCDM]+|\d+)?/i);
      currentAnnex = {
        annex_id: normalizeText(annexMatch?.[1] || "") || text,
        annex_title: text,
        bodyParagraphs: [],
      };
      continue;
    }

    if (hasClass(element, "Titrearticle")) {
      finalizeAnnex();
      finalizeArticle();
      inEnactingTerms = true;
      pendingDivision = null;
      const numberMatch = text.match(/^Article\s+(\d+[A-Za-z]*)\s*(.*)$/i);
      currentArticle = {
        article_number: numberMatch ? numberMatch[1] : String(articles.length + 1),
        article_title: numberMatch ? normalizeText(numberMatch[2]) : "",
        division: {
          chapter: { ...currentChapter },
          section: currentSection.number ? { ...currentSection } : null,
        },
        bodyParagraphs: [],
      };
      continue;
    }

    if (hasClass(element, "SectionTitle")) {
      if (!inEnactingTerms) continue;
      const divisionMarker = parseDivisionMarker(text);
      if (divisionMarker) {
        finalizeArticle();
        if (divisionMarker.kind === "section") {
          currentSection = { number: divisionMarker.number, title: divisionMarker.title };
          pendingDivision = currentSection;
        } else {
          currentChapter = { number: divisionMarker.number, title: divisionMarker.title };
          currentSection = { number: "", title: "" };
          pendingDivision = currentChapter;
        }
      } else if (pendingDivision && !pendingDivision.title) {
        pendingDivision.title = text;
        pendingDivision = null;
      }
      continue;
    }

    if (currentAnnex) {
      currentAnnex.bodyParagraphs.push(text);
      continue;
    }

    if (currentArticle) {
      currentArticle.bodyParagraphs.push(text);
    }
  }

  finalizeArticle();
  finalizeAnnex();

  const definitions = articles.flatMap((article) => parseDefinitions(article, langConfig));

  recitals.sort((left, right) => {
    const leftNum = Number.parseInt(String(left.recital_number).replace(/\D+/g, ""), 10) || 0;
    const rightNum = Number.parseInt(String(right.recital_number).replace(/\D+/g, ""), 10) || 0;
    return leftNum - rightNum;
  });

  return {
    title,
    articles: articles.map(({ bodyParagraphs, ...article }) => article),
    recitals,
    annexes,
    definitions,
    langCode,
    crossReferences: {},
  };
}

function htmlToPlainText(html) {
  return normalizeText(String(html || "").replace(/<[^>]+>/g, " "));
}

// Parse a trailing footnote-citation line into an OJ reference, e.g.
// "OJ No L 281, 23.11.1995, p. 31" → { ojColl: "L", ojNo: "281", ojYear: "1995", … }.
// Pre-1968 acts cite "OJ No 30, 20.4.1962, p. 964" with no series letter; those
// can't be turned into a resolvable OJ URL, so they're skipped (return null).
function parseOjCitation(text) {
  const idMatch = String(text || "").match(/OJ\s+No\.?\s*([A-Z])\s*(\d+)/i);
  if (!idMatch) return null;
  const yearMatch = text.match(/\b(?:19|20)\d{2}\b/);
  const pageMatch = text.match(/p\.?\s*(\d+)/i);
  return {
    type: "oj_ref",
    ojColl: idMatch[1].toUpperCase(),
    ojNo: idMatch[2],
    ojYear: yearMatch ? yearMatch[0] : "",
    ojPage: pageMatch ? pageMatch[1] : "",
  };
}

// Old EUR-Lex HTML flattens footnotes to plain "(N) OJ No L …" lines at the end
// of the body. parseRecitals skips them so they don't masquerade as recitals;
// here we collect them as a number→OJ-reference map so their citation data can be
// reattached to whichever article/recital carries the matching "(N)" marker.
function parseOjFootnotes(paragraphs) {
  const map = new Map();
  for (const paragraph of paragraphs) {
    const text = normalizeText(paragraph);
    const match = text.match(/^\((\d+)\)\s+(OJ\b.*)$/i);
    if (!match) continue;
    const ojRef = parseOjCitation(match[2]);
    if (ojRef) map.set(match[1], { ...ojRef, raw: match[2] });
  }
  return map;
}

// Attach OJ footnote references to a ref list by matching "(N)" markers present
// in the item's own text against the document-level footnote map.
function appendFootnoteRefs(refs, text, footnotesByNumber) {
  if (!footnotesByNumber || footnotesByNumber.size === 0) return refs;
  const out = refs.slice();
  const seen = new Set();
  const markerRe = /\((\d+)\)/g;
  let match;
  while ((match = markerRe.exec(text)) !== null) {
    const number = match[1];
    if (seen.has(number)) continue;
    seen.add(number);
    const footnote = footnotesByNumber.get(number);
    if (footnote) out.push({ ...footnote });
  }
  return out;
}

// Build the crossReferences map (articleNumber / recital_N / annex_ID → [refs])
// for HTML-parsed laws, mirroring the shape the FMX parser produces. Reuses the
// shared extractCrossRefsFromText so the article/external/treaty patterns stay in
// one place; folds in OJ footnote citations when a footnote map is supplied.
function buildHtmlCrossReferences({
  articles = [],
  recitals = [],
  annexes = [],
  extractCrossRefsFromText,
  langConfig,
  footnotesByNumber = null,
}) {
  const crossReferences = {};
  if (typeof extractCrossRefsFromText !== "function" || !langConfig) return crossReferences;

  const attach = (key, text, selfArticle = null) => {
    if (!text) return;
    const baseRefs = extractCrossRefsFromText(text, langConfig) || [];
    const withFootnotes = appendFootnoteRefs(baseRefs, text, footnotesByNumber);
    const seen = new Set();
    const unique = withFootnotes.filter((ref) => {
      if (ref.type === "article" && selfArticle != null && ref.target === selfArticle) return false;
      const dedupeKey = referenceDedupeKey(ref);
      if (seen.has(dedupeKey)) return false;
      seen.add(dedupeKey);
      return true;
    });
    if (unique.length) crossReferences[key] = unique;
  };

  for (const article of articles) {
    attach(article.article_number, htmlToPlainText(article.article_html), article.article_number);
  }
  for (const recital of recitals) {
    attach(`recital_${recital.recital_number}`, recital.recital_text || htmlToPlainText(recital.recital_html));
  }
  for (const annex of annexes) {
    attach(`annex_${annex.annex_id}`, htmlToPlainText(annex.annex_html));
  }
  return crossReferences;
}

async function loadHelpers() {
  if (!helperPromise) {
    helperPromise = (async () => {
      if (typeof global.DOMParser === "undefined") {
        const shimDom = new JSDOM("", { url: "https://eur-lex.europa.eu/" });
        global.DOMParser = shimDom.window.DOMParser;
        global.Node = shimDom.window.Node;
        global.NodeFilter = shimDom.window.NodeFilter;
      }

      const parserMod = await import("./formex-parser/fmxParser.mjs");

      return {
        injectCrossRefLinks: parserMod.injectCrossRefLinks,
        extractCrossRefsFromText: parserMod.extractCrossRefsFromText,
        repairCorroboratedTruncatedInstrumentIdentifiers: parserMod.repairCorroboratedTruncatedInstrumentIdentifiers,
        escapeHtml: parserMod.escapeHtml,
        maxDefinitionContinuationParagraphs: parserMod.MAX_DEFINITION_CONTINUATION_PARAGRAPHS,
        // This parser reads a different document format, but its cross-references come
        // from the Formex parser's grammar above — so PARSER_VERSION versions this
        // output too, and is taken from there rather than declared a second time.
        PARSER_VERSION: parserMod.PARSER_VERSION,
      };
    })();
  }

  return helperPromise;
}

async function parseEurlexHtmlToCombined(htmlText, lang = "ENG") {
  const dom = new JSDOM(htmlText, { url: "https://eur-lex.europa.eu/" });
  const document = dom.window.document;
  const langCode = normalizeText(document.documentElement.getAttribute("lang") || LANG_3_TO_2[lang] || "EN").toUpperCase();
  const {
    injectCrossRefLinks,
    extractCrossRefsFromText,
    repairCorroboratedTruncatedInstrumentIdentifiers,
    PARSER_VERSION,
    escapeHtml: parserEscapeHtml,
    maxDefinitionContinuationParagraphs: parserMaxDefinitionContinuationParagraphs,
  } = await loadHelpers();
  escapeHtml = parserEscapeHtml;
  maxDefinitionContinuationParagraphs = parserMaxDefinitionContinuationParagraphs;
  const langConfig = getLangConfig(langCode);

  // Populate the crossReferences map (empty as built by each branch) so the
  // CrossReferences panel works for HTML laws, not just FMX ones.
  const withCrossReferences = (parsed) => {
    parsed.definitions = (parsed.definitions || []).map((entry) => ({
      ...entry,
      references: extractCrossRefsFromText(entry.definition || "", langConfig),
    }));
    parsed.crossReferences = buildHtmlCrossReferences({
      articles: parsed.articles,
      recitals: parsed.recitals,
      annexes: parsed.annexes,
      extractCrossRefsFromText,
      langConfig,
    });
    const checked = enforceInternalReferenceIntegrity(parsed);
    repairCorroboratedTruncatedInstrumentIdentifiers([
      ...Object.values(checked.crossReferences).flat(),
      ...checked.definitions.flatMap((entry) => entry.references || []),
    ]);
    checked.parserVersion = PARSER_VERSION;
    return checked;
  };

  const hasStructuredLayout = Boolean(
    document.querySelector(".eli-subdivision, .oj-ti-art, .title-article-norm, .oj-ti-annex, .title-annex-norm")
  );
  if (hasStructuredLayout) {
    const parsedStructured = parseStructuredHtmlToCombined(document, langCode, langConfig, injectCrossRefLinks);
    if (parsedStructured.articles.length || parsedStructured.recitals.length || parsedStructured.annexes.length) {
      return withCrossReferences(parsedStructured);
    }
  }

  const hasLegacyXhtmlLayout = Boolean(
    document.querySelector("p.ti-art") && document.querySelector("p.normal, p.doc-ti")
  );
  if (hasLegacyXhtmlLayout) {
    const parsedLegacyXhtml = parseLegacyXhtmlToCombined(document, langCode, langConfig, injectCrossRefLinks);
    if (parsedLegacyXhtml.articles.length || parsedLegacyXhtml.recitals.length || parsedLegacyXhtml.annexes.length) {
      return withCrossReferences(parsedLegacyXhtml);
    }
  }

  const hasLegisWriteLayout = Boolean(
    document.querySelector("p.Titrearticle, p.li.ManualConsidrant")
  );
  if (hasLegisWriteLayout) {
    const parsedLegisWrite = parseLegisWriteToCombined(document, langCode, langConfig, injectCrossRefLinks);
    if (parsedLegisWrite.articles.length || parsedLegisWrite.recitals.length || parsedLegisWrite.annexes.length) {
      return withCrossReferences(parsedLegisWrite);
    }
  }

  let paragraphs = [];

  const fragmentMatch = String(htmlText || "").match(/<TXT_TE>([\s\S]*?)<\/TXT_TE>/i);
  if (fragmentMatch) {
    const fragment = JSDOM.fragment(fragmentMatch[1]);
    paragraphs = Array.from(fragment.querySelectorAll("p"))
      .map((paragraph) => normalizeText(paragraph.textContent))
      .filter(Boolean);
  }

  // Fallback: some legacy pages have an empty <TXT_TE/> or none at all —
  // collect all <p> text from the full document body instead.
  if (paragraphs.length === 0) {
    paragraphs = Array.from(document.body.querySelectorAll("p"))
      .map((paragraph) => normalizeText(paragraph.textContent))
      .filter(Boolean);
  }

  if (paragraphs.length === 0) {
    throw new ClientError("EUR-Lex HTML body is empty", 404, "law_not_found");
  }

  const metaTitle = document.querySelector('meta[name="WT.z_docTitle"]')?.getAttribute("content")
    || document.querySelector('meta[name="DC.description"]')?.getAttribute("content")
    || paragraphs.slice(0, 3).join(" ");
  const title = normalizeText(metaTitle);

  const whereasIndex = paragraphs.findIndex((paragraph) => /^Whereas:?$/i.test(paragraph));
  const articleStartIndex = paragraphs.findIndex((paragraph) => isArticleHeading(paragraph));
  const preambleEnd = articleStartIndex >= 0 ? articleStartIndex : paragraphs.length;
  // With a standalone "Whereas:" heading, recitals are the block after it. Older
  // 1990s acts instead number their recitals "(N) Whereas …" with no such heading
  // and a "Having regard to …" citation block above — so scan the whole preamble;
  // parseRecitals only latches onto "(N)"-marked paragraphs and stops at the
  // enacting formula, ignoring the title/citation lines before the first recital.
  const recitalParagraphs = whereasIndex >= 0 && preambleEnd > whereasIndex
    ? paragraphs.slice(whereasIndex + 1, preambleEnd)
    : paragraphs.slice(0, preambleEnd);
  let recitals = parseRecitals(recitalParagraphs, recitalParagraphs.length);
  // Fall back to old-style unnumbered "Whereas …" recitals (pre-1990s acts),
  // which have no "(N)" markers for parseRecitals to latch onto.
  if (recitals.length === 0) {
    recitals = parseWhereasRecitals(paragraphs, preambleEnd);
  }

  // Annexes follow the articles. Cut the article body at the first "ANNEX"
  // heading so annex content isn't swallowed into the last article, and parse
  // the remainder as annexes.
  const annexStartIndex = paragraphs.findIndex((paragraph) => isAnnexHeading(normalizeText(paragraph)));
  const articleSliceEnd = annexStartIndex > articleStartIndex ? annexStartIndex : paragraphs.length;
  let rawArticles = parseArticles(
    paragraphs.slice(articleStartIndex >= 0 ? articleStartIndex : paragraphs.length, articleSliceEnd),
  );
  // Single-provision acts have no "Article N" heading — recover the operative
  // text after the enacting formula as a lone Article 1 so it isn't dropped.
  if (rawArticles.length === 0) {
    const enactingIndex = paragraphs.findIndex((paragraph) =>
      ENACTING_FORMULA.test(normalizeText(paragraph)));
    if (enactingIndex >= 0) {
      const body = parseSoleArticleBody(paragraphs, enactingIndex + 1);
      if (body.length) {
        rawArticles = [{
          article_number: "1",
          article_title: "",
          division: { chapter: { number: "", title: "" }, section: null },
          bodyParagraphs: body,
        }];
      }
    }
  }
  // A small set of old EUR-Lex decisions has no Article heading or enacting
  // formula: its operative measures are simply numbered "1.", "2.", etc.
  // Keep the source as a labelled unnumbered section rather than dropping it
  // or fabricating Article 1.
  if (rawArticles.length === 0 && recitals.length === 0 && hasUnnumberedDecisionBody(paragraphs)) {
    rawArticles = [{
      article_number: "text",
      article_title: "",
      display_label: "Decision text",
      is_unnumbered: true,
      division: { chapter: { number: "", title: "" }, section: null },
      bodyParagraphs: paragraphs.filter((paragraph) => normalizeText(paragraph) !== "****"),
    }];
  }

  const articles = rawArticles
    .map((article) => {
      const html = paragraphsToHtml(article.bodyParagraphs, { title: article.article_title });
      return {
        article_number: article.article_number,
        article_title: article.article_title,
        display_label: article.display_label,
        is_unnumbered: article.is_unnumbered,
        division: article.division || {
          chapter: { number: "", title: "" },
          section: null,
        },
        article_html: injectCrossRefLinks(html, langConfig),
        bodyParagraphs: article.bodyParagraphs,
      };
    });

  const definitions = articles.flatMap((article) => parseDefinitions(article, langConfig));

  const annexes = annexStartIndex >= 0
    ? parseTxtTeAnnexes(paragraphs, annexStartIndex, langConfig, injectCrossRefLinks)
    : [];

  // The plaintext branch builds recital_html as a raw <p> — inject cross-ref
  // links so preamble citations (article + external-law + treaty) become
  // navigable, matching what articles/annexes already get.
  recitals = recitals.map((recital) => ({
    ...recital,
    recital_html: injectCrossRefLinks(recital.recital_html, langConfig),
  }));

  const strippedArticles = articles.map(({ bodyParagraphs, ...article }) => article);
  const footnotesByNumber = parseOjFootnotes(paragraphs);
  const crossReferences = buildHtmlCrossReferences({
    articles: strippedArticles,
    recitals,
    annexes,
    extractCrossRefsFromText,
    langConfig,
    footnotesByNumber,
  });

  const parsed = enforceInternalReferenceIntegrity({
    title,
    articles: strippedArticles,
    recitals,
    annexes,
    definitions,
    langCode,
    crossReferences,
    // Stamped here as well as in withCrossReferences: this oldest-era branch builds
    // its own crossReferences (it alone passes footnotesByNumber) instead of going
    // through that helper, so a stamp there would miss every pre-2004 OJ act.
    parserVersion: PARSER_VERSION,
  });
  parsed.definitions = parsed.definitions.map((entry) => ({
    ...entry,
    references: extractCrossRefsFromText(entry.definition || "", langConfig),
  }));
  repairCorroboratedTruncatedInstrumentIdentifiers([
    ...Object.values(parsed.crossReferences).flat(),
    ...parsed.definitions.flatMap((entry) => entry.references || []),
  ]);
  return parsed;
}

async function loadPlaywrightModule(modulePath = null) {
  const candidates = [
    modulePath,
    process.env.LEGALVIZ_PLAYWRIGHT_MODULE_PATH,
    "playwright",
    "playwright-core",
  ].filter(Boolean);

  let lastError = null;
  for (const candidate of candidates) {
    try {
      return requireFromHere(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  const error = new Error(
    `Playwright module is not available. Tried: ${candidates.join(", ")}`
  );
  error.cause = lastError;
  throw error;
}

function isRetriablePlaywrightError(error) {
  const message = String(error?.message || error || "");
  return /Target page, context or browser has been closed/i.test(message)
    || /Browser has been closed/i.test(message)
    || /Page crashed/i.test(message)
    || /Target closed/i.test(message);
}

function resetBrowserIdleTimer() {
  if (browserIdleTimer) clearTimeout(browserIdleTimer);
  browserIdleTimer = setTimeout(() => {
    closeSharedPlaywrightBrowser();
  }, DEFAULT_BROWSER_IDLE_MS);
}

async function closeSharedPlaywrightBrowser() {
  if (browserIdleTimer) {
    clearTimeout(browserIdleTimer);
    browserIdleTimer = null;
  }
  sharedPlaywrightPage = null;
  if (!sharedPlaywrightBrowser) return;
  try {
    await sharedPlaywrightBrowser.close();
  } catch {}
  sharedPlaywrightBrowser = null;
  sharedPlaywrightBrowserKey = null;
  console.log("[Playwright] Browser closed");
}

async function getSharedPlaywrightBrowser(playwright, { playwrightBrowsersPath = null, headless = true } = {}) {
  const key = JSON.stringify({
    browserType: "chromium",
    playwrightBrowsersPath: playwrightBrowsersPath || "",
    headless: Boolean(headless),
  });

  if (sharedPlaywrightBrowser && sharedPlaywrightBrowserKey === key && sharedPlaywrightBrowser.isConnected()) {
    resetBrowserIdleTimer();
    return sharedPlaywrightBrowser;
  }

  await closeSharedPlaywrightBrowser();
  console.log("[Playwright] Launching browser...");
  sharedPlaywrightBrowser = await playwright.chromium.launch({ headless });
  sharedPlaywrightBrowserKey = key;
  resetBrowserIdleTimer();
  return sharedPlaywrightBrowser;
}

async function getSharedPlaywrightPage(playwright, options = {}) {
  const browser = await getSharedPlaywrightBrowser(playwright, options);
  if (sharedPlaywrightPage && !sharedPlaywrightPage.isClosed()) {
    return sharedPlaywrightPage;
  }
  sharedPlaywrightPage = await browser.newPage();
  return sharedPlaywrightPage;
}

async function fetchEurlexHtmlWithPlaywright({
  url,
  timeoutMs,
  playwrightModulePath = null,
  playwrightBrowsersPath = null,
  maxRetries = DEFAULT_PLAYWRIGHT_RETRIES,
  headless = true,
  closeBrowserAfterFetch = false,
}) {
  const playwright = await loadPlaywrightModule(playwrightModulePath);
  const previousBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (playwrightBrowsersPath) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath;
  }

  try {
    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      try {
        const page = await getSharedPlaywrightPage(playwright, { playwrightBrowsersPath, headless });
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        await page.waitForTimeout(1_000);
        const html = await page.content();
        if (closeBrowserAfterFetch) {
          await closeSharedPlaywrightBrowser();
        }
        return html;
      } catch (error) {
        if (isRetriablePlaywrightError(error)) {
          await closeSharedPlaywrightBrowser();
        }
        if (!isRetriablePlaywrightError(error) || attempt >= maxRetries) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, attempt * 1_000)));
      }
    }
  } finally {
    if (playwrightBrowsersPath) {
      if (previousBrowsersPath == null) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      else process.env.PLAYWRIGHT_BROWSERS_PATH = previousBrowsersPath;
    }
  }
}

async function fetchEurlexHtmlLaw({
  celex,
  lang = "ENG",
  eurlexBase,
  timeoutMs = 30_000,
  usePlaywright = false,
  usePlaywrightOnChallenge = false,
  closeBrowserAfterFetch = true,
  playwrightModulePath = null,
  playwrightBrowsersPath = null,
  playwrightHeadless = true,
  fetchImpl = fetch,
  fetchWithPlaywrightImpl = fetchEurlexHtmlWithPlaywright,
}) {
  const requestedLang = String(lang || "ENG").toUpperCase();
  const servedLang = "ENG";
  const languageCode = "EN";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${eurlexBase}/legal-content/${languageCode}/TXT/HTML/?uri=CELEX:${encodeURIComponent(celex)}`;
    let htmlText = null;
    let response = null;

    if (!usePlaywright) {
      response = await fetchImpl(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          Accept: "text/html,application/xhtml+xml",
        },
      });
    }

    if (usePlaywright) {
      htmlText = await fetchWithPlaywrightImpl({
        url,
        timeoutMs,
        playwrightModulePath,
        playwrightBrowsersPath,
        headless: playwrightHeadless,
        closeBrowserAfterFetch,
      });
    } else if (response.status === 202 && String(response.headers.get("x-amzn-waf-action") || "").toLowerCase() === "challenge") {
      if (usePlaywrightOnChallenge) {
        htmlText = await fetchWithPlaywrightImpl({
          url,
          timeoutMs,
          playwrightModulePath,
          playwrightBrowsersPath,
          headless: playwrightHeadless,
          closeBrowserAfterFetch,
        });
      } else {
        throw new ClientError(
          `EUR-Lex HTML access is currently being challenged for ${celex}`,
          503,
          "eurlex_html_challenged",
          {
            celex,
            requestedLang,
            servedLang,
            upstreamStatus: response.status,
          }
        );
      }
    } else {
      if (response.status === 404) {
        throw new ClientError(`No EUR-Lex HTML law found for ${celex}`, 404, "law_not_found");
      }
      if (!response.ok) {
        throw new ClientError(`EUR-Lex HTML fetch failed with HTTP ${response.status}`, response.status, "eurlex_html_unavailable");
      }
      htmlText = await response.text();
    }
    return {
      celex,
      lang: servedLang,
      requestedLang,
      servedLang,
      source: "eurlex-html",
      rawHtml: htmlText,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAndParseEurlexHtmlLaw({
  celex,
  lang = "ENG",
  eurlexBase,
  timeoutMs = 30_000,
  includeRawHtml = false,
  usePlaywright = false,
  usePlaywrightOnChallenge = false,
  closeBrowserAfterFetch = true,
  playwrightModulePath = null,
  playwrightBrowsersPath = null,
  playwrightHeadless = true,
  fetchImpl = fetch,
  fetchWithPlaywrightImpl = fetchEurlexHtmlWithPlaywright,
}) {
  const fetched = await fetchEurlexHtmlLaw({
    celex,
    lang,
    eurlexBase,
    timeoutMs,
    usePlaywright,
    usePlaywrightOnChallenge,
    closeBrowserAfterFetch,
    playwrightModulePath,
    playwrightBrowsersPath,
    playwrightHeadless,
    fetchImpl,
    fetchWithPlaywrightImpl,
  });
  const parsed = await parseEurlexHtmlToCombined(fetched.rawHtml, fetched.servedLang);
  const base = includeRawHtml ? fetched : (() => {
    const { rawHtml, ...withoutRawHtml } = fetched;
    return withoutRawHtml;
  })();
  return {
    ...base,
    format: "combined-v1",
    ...parsed,
  };
}

module.exports = {
  closeSharedPlaywrightBrowser,
  fetchEurlexHtmlLaw,
  fetchEurlexHtmlWithPlaywright,
  fetchAndParseEurlexHtmlLaw,
  getSharedPlaywrightBrowser,
  getSharedPlaywrightPage,
  isRetriablePlaywrightError,
  loadPlaywrightModule,
  parseEurlexHtmlToCombined,
};
