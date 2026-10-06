// Operative-only fallback for oversized EUR-Lex HTML renditions, the HTML
// counterpart of stripCompleteUppercaseAnnexes for FMX. The acts that hit the
// HTML ceiling are Council decisions concluding trade and association
// agreements (e.g. 32009D0850, 15.8 MiB): the decision and the agreement's
// articles fit in well under 1 MiB, and the rest is tariff schedules, rules of
// origin and protocols. HTML has no annex element to remove one by one, so the
// document is cut at the first annex and everything after it is dropped —
// including any protocol articles that follow, which a full parse would keep.
//
// Annex starts recognised, in document order, whichever comes first:
//   <div id="anx_…">                     ELI annex container (structured "oj-" layout)
//   <p class="oj-ti-annex…|title-annex-norm|Annexetitre">  annex heading classes
//   <p class="oj-doc-ti|doc-ti">ANNEX …  heading-only renditions such as
//                                        32006D0580, which carry no anx_ ids
// Cutting mid-document leaves elements unclosed; the HTML parser (jsdom) closes
// them at end of input, as it does for any truncated page.

const START_TAG_RE = /<(div|p)\b([^>]*)>/gi;
const ANNEX_HEADING_CLASS_RE = /(?:^|\s)(?:oj-ti-annex(?:-\d+)?|title-annex-norm|Annexetitre)(?:\s|$)/;
const DOC_TITLE_CLASS_RE = /(?:^|\s)(?:oj-doc-ti|doc-ti)(?:\s|$)/;
// "ANNEX", "ANNEX I", "ANNEX 1", "Annex II(a)" — but not "ANNEXES" or
// "LIST OF ANNEXES AND PROTOCOLS".
const ANNEX_TEXT_RE = /^annex(?![a-z])/i;
const ARTICLE_HEADING_RE = /<p\b[^>]*\bclass="[^"]*(?:\boj-ti-art\b|\btitle-article-norm\b|\bti-art\b|\bTitrearticle\b)[^"]*"/i;
// Bounded look-ahead for a heading's text; annex headings are a few words.
const HEADING_TEXT_WINDOW = 400;

function attribute(attrs, name) {
  const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return match ? (match[1] ?? match[2]) : "";
}

function headingText(html, from) {
  const window = html.slice(from, from + HEADING_TEXT_WINDOW);
  const end = window.search(/<\/p\s*>/i);
  return (end >= 0 ? window.slice(0, end) : window)
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;|&#160;|&#xa0;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findFirstAnnexOffset(html) {
  START_TAG_RE.lastIndex = 0;
  let match;
  while ((match = START_TAG_RE.exec(html)) !== null) {
    const tag = match[1].toLowerCase();
    const attrs = match[2];
    if (tag === "div") {
      if (/^anx_/i.test(attribute(attrs, "id"))) return match.index;
      continue;
    }
    const className = attribute(attrs, "class");
    if (ANNEX_HEADING_CLASS_RE.test(className)) return match.index;
    if (DOC_TITLE_CLASS_RE.test(className) && ANNEX_TEXT_RE.test(headingText(html, START_TAG_RE.lastIndex))) {
      return match.index;
    }
  }
  return -1;
}

// Returns the HTML up to the first annex. `annexOffset` is -1 when no annex
// start was found (operativeHtml is then the whole input); `hasArticle` says
// whether the kept part still contains an article heading. A caller should only
// trust the fallback when both hold and the result fits its size ceiling.
function cutHtmlAtFirstAnnex(html) {
  const source = String(html);
  const annexOffset = findFirstAnnexOffset(source);
  const operativeHtml = annexOffset >= 0 ? source.slice(0, annexOffset) : source;
  return { operativeHtml, annexOffset, hasArticle: ARTICLE_HEADING_RE.test(operativeHtml) };
}

// Shared guard for the corpus builders: returns the operative-only HTML when
// the fallback is safe, otherwise throws the usual `oversized` failure.
function operativeHtmlWithinLimit(html, maxHtmlBytes) {
  const cut = cutHtmlAtFirstAnnex(html);
  if (cut.annexOffset < 0 || !cut.hasArticle || Buffer.byteLength(cut.operativeHtml, "utf8") > maxHtmlBytes) {
    throw Object.assign(
      new Error(`Decompressed HTML exceeds ${maxHtmlBytes} bytes and has no safe operative-only fallback`),
      { oversized: true },
    );
  }
  return cut.operativeHtml;
}

module.exports = { cutHtmlAtFirstAnnex, operativeHtmlWithinLimit };
