/**
 * Runtime-neutral legal-reference primitives shared by the browser Formex
 * parser and the Node case-law parser. Keep this module dependency-free: Vite
 * imports it into the browser bundle while CommonJS backend code requires it.
 */

const MAX_ARTICLE_ACT_BRIDGE = 200;
const MAX_THEREOF_ANTECEDENT_DISTANCE = 500;
const MAX_RANGE_SIZE = 50;

const ACT_CELEX_MAP = {
  GDPR: '32016R0679',
  '2016/679': '32016R0679',
  '95/46': '31995L0046',
  '2002/58': '32002L0058',
  '2016/680': '32016L0680',
  '2022/2065': '32022R2065',
  '2022/1925': '32022R1925',
  '2024/1689': '32024R1689',
  Charter: '12012P',
  TFEU: '12012E',
  TEU: '12012M',
  'EC Treaty': '12002E',
  'EEC Treaty': '11957E',
  'ECSC Treaty': '11951K',
  'Euratom Treaty': '11957A',
};

const ACT_TYPE_CODE = {
  regulation: 'R',
  directive: 'L',
  decision: 'D',
  'framework decision': 'F',
  recommendation: 'H',
};

function normalizeYear(raw) {
  const value = Number(raw);
  if (!Number.isInteger(value)) return null;
  if (String(raw).length === 4 && value >= 1900 && value <= 2099) return value;
  if (String(raw).length === 2) return value >= 50 ? 1900 + value : 2000 + value;
  return null;
}

/**
 * Normalize the two numeric components of an EU instrument identifier.
 * A plausible four-digit year is unambiguous. Otherwise, the historical
 * "No number/year" form is number-first, while directives and decisions such
 * as 95/46 remain year-first.
 */
function parseInstrumentIdentifier({ actType, identifier, hasNo = false, allowHistoricalNoLabel = false, ecscAuthority = false, institutionalIssuer = false } = {}) {
  const match = String(identifier || '').match(/^(\d{1,4})\/(\d{1,4})(?:\/([A-Z]+))?$/i);
  if (!match) return { year: null, number: null, suffix: null };

  const first = match[1];
  const second = match[2];
  const suffix = match[3] || null;
  const type = String(actType || '').toLowerCase();
  let yearPart = null;
  let numberPart = null;

  // A two-digit first part and three/four-digit second part is the old
  // unambiguous year/number decision form (Decision No 65/271 or
  // 80/1186/EEC), even though it retains a "No" label.
  if (first.length === 2 && (second.length === 3 || (type === 'decision' && second.length === 4))) {
    yearPart = first;
    numberPart = second;
  // In regulations and decisions, an unlabelled historical 19xx/20xx pair
  // is likewise number/year (Regulation 1924/2006), not an act from 1924.
  } else if ((type === 'regulation' || type === 'decision')
    && (/^19\d{2}$/.test(first) || institutionalIssuer)
    && /^(?:19|20)\d{2}$/.test(second)) {
    yearPart = second;
    numberPart = first;
  // Modern decisions such as Decision No 2005/802/EC retain a "No" label
  // while using year/number order. The explicit institutional suffix keeps
  // this separate from old No number/year decisions.
  } else if (type === 'decision' && /^(?:19|20)\d{2}$/.test(first)
    && /^(?:EC|EU|EURATOM)$/i.test(suffix || '')) {
    yearPart = first;
    numberPart = second;
  // Regulations and decisions otherwise labelled "No" use number/year order.
  // The number can itself look like a four-digit year (No 1924/2006 or
  // 2027/97), so this must precede the superficial year checks below.
  } else if (hasNo && (type === 'regulation' || type === 'decision')
    && !(Number(first) >= 2010 && first.length === 4 && second.length >= 3
      && !/^(?:19|20)\d{2}$/.test(second))) {
    yearPart = second;
    numberPart = first;
  } else if (/^(?:19|20)\d{2}$/.test(first)) {
    yearPart = first;
    numberPart = second;
  } else if (/^(?:19|20)\d{2}$/.test(second)) {
    yearPart = second;
    numberPart = first;
  // Conversely, early directives and regulations use the old number/year
  // display without an explicit "No" (for example, Directive 228/67 and
  // Regulation (EEC) 193/75).  A post-1950 two-digit tail is a sufficiently
  // narrow historical signal; damaged strings such as "199/44" stay safely
  // unresolved rather than being mislinked.
  } else if ((type === 'directive'
    || (type === 'regulation' && (allowHistoricalNoLabel || first.length <= 3 || institutionalIssuer || suffix === 'EEC' || suffix === 'EC'))
    || (type === 'decision' && suffix === 'ECSC')
    || (type === 'recommendation' && (ecscAuthority || suffix === 'ECSC')))
    && first.length >= 1 && second.length === 2 && Number(second) >= 50) {
    yearPart = second;
    numberPart = first;
  } else if (type === 'directive' || type === 'framework decision' || type === 'recommendation') {
    yearPart = first;
    numberPart = second;
  } else if (hasNo) {
    yearPart = second;
    numberPart = first;
  } else if (type === 'decision') {
    yearPart = first;
    numberPart = second;
  }

  const year = normalizeYear(yearPart);
  const number = numberPart == null ? null : Number(numberPart);
  return {
    year: year ? String(year) : null,
    number: number != null && Number.isInteger(number) ? String(number) : null,
    suffix,
  };
}

function resolveInstrumentCelex({ actType, identifier, hasNo = false, allowHistoricalNoLabel = false, ecscAuthority = false, institutionalIssuer = false } = {}) {
  const mapped = ACT_CELEX_MAP[identifier];
  if (mapped) return mapped;

  const code = ACT_TYPE_CODE[String(actType || '').toLowerCase()];
  if (!code) return null;

  const { year, number, suffix } = parseInstrumentIdentifier({ actType, identifier, hasNo, allowHistoricalNoLabel, ecscAuthority, institutionalIssuer });
  if (!year || !number) return null;
  const type = String(actType || '').toLowerCase();
  const descriptor = (suffix === 'ECSC' && (type === 'decision' || type === 'recommendation'))
    || (ecscAuthority && type === 'recommendation') ? 'S' : code;
  return `3${year}${descriptor}${number.padStart(4, '0')}`;
}

function referenceDedupeKey(ref) {
  return [
    ref.type || '',
    ref.target || '',
    ref.act || '',
    ref.actType || '',
    ref.actCelex || '',
    ref.contextual ? 'contextual' : '',
    ref.articleNumber || ref.article || '',
    ref.paragraph || '',
    ref.point || '',
    ref.ojColl || '',
    ref.ojYear || '',
    ref.ojNo || '',
    ref.ojPage || '',
  ].join(':');
}

function dedupeReferences(refs) {
  const seen = new Set();
  return (refs || []).filter((ref) => {
    const key = referenceDedupeKey(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Scan word-first article enumerations. `articleWordSource` is a regex source
 * for the language-specific article word, without the following number.
 */
function scanArticleEnumerations(text, {
  articleWordSource = 'Articles?',
  listWordSource = 'and|or',
  rangeWordSource = 'to',
  pointWordSource = 'points?',
  maxRangeSize = MAX_RANGE_SIZE,
} = {}) {
  const headRe = new RegExp(`(?:${articleWordSource})\\s+(?=\\d)`, 'gi');
  const itemRe = /(\d+[a-z]?)((?:\s*\(\s*[a-z0-9]+\s*\))*)/iy;
  const namedPointRe = new RegExp(`\\s*,?\\s*(?:${pointWordSource})\\s+\\(?([a-z0-9]+)\\)?`, 'iy');
  const qualifierRe = /\s*,?\s*(?:\[?\s*(first|second|third|fourth|last|final)\s*\]?\s+)?(paragraph|subparagraph|indent|sentence)(?:\s+(\d+[a-z]?)(?:\s*\(\s*([a-z0-9]+)\s*\))?)?(?:\s*,?\s*points?\s+\(?([a-z0-9]+)\)?)?/iy;
  const separatorWords = `${listWordSource}|${rangeWordSource}`;
  const separatorRe = new RegExp(`(\\s*,\\s*(?:${separatorWords})\\s+|\\s*,\\s*|\\s+(?:${separatorWords})\\s+)`, 'iy');
  const rangeSeparatorRe = new RegExp(`^\\s*(?:${rangeWordSource})\\s*$`, 'i');
  const repeatedArticleRe = new RegExp(`\\s*(?:${articleWordSource})\\s+`, 'iy');
  const abbreviatedGroupRe = /\s*\(\s*([a-z0-9]+)\s*\)/iy;
  const digitRe = /\d/y;
  const results = [];
  let head;

  function appendAbbreviated(items, value, isRange, tokenStart, tokenEnd) {
    const previous = items[items.length - 1];
    const isPoint = /^[a-z]/i.test(value);
    if (isRange && isPoint && /^[a-z]$/i.test(previous.point || '') && /^[a-z]$/i.test(value)) {
      const from = previous.point.toLowerCase().charCodeAt(0);
      const to = value.toLowerCase().charCodeAt(0);
      if (to > from && to - from <= maxRangeSize) {
        for (let code = from + 1; code < to; code++) {
          items.push({
            articleNumber: previous.articleNumber, paragraph: previous.paragraph,
            point: String.fromCharCode(code), tokenStart: null, tokenEnd: null,
          });
        }
      }
    } else if (isRange && !isPoint && /^\d+$/.test(previous.paragraph || '') && /^\d+$/.test(value)) {
      const from = Number(previous.paragraph);
      const to = Number(value);
      if (to > from && to - from <= maxRangeSize) {
        for (let paragraphValue = from + 1; paragraphValue < to; paragraphValue++) {
          items.push({
            articleNumber: previous.articleNumber, paragraph: String(paragraphValue),
            point: null, tokenStart: null, tokenEnd: null,
          });
        }
      }
    }
    items.push({
      articleNumber: previous.articleNumber,
      paragraph: isPoint ? previous.paragraph : value,
      point: isPoint ? value.toLowerCase() : null,
      tokenStart,
      tokenEnd,
    });
  }

  while ((head = headRe.exec(text)) !== null) {
    let position = head.index + head[0].length;
    const items = [];
    let pendingRange = false;
    let safety = 0;

    while (safety++ < 500) {
      itemRe.lastIndex = position;
      const match = itemRe.exec(text);
      if (!match) break;
      const tokenStart = position;
      const articleNumber = match[1];
      const groups = [...match[2].matchAll(/\(\s*([a-z0-9]+)\s*\)/gi)].map((group) => group[1]);
      let paragraph = /^\d+[a-z]?$/i.test(groups[0] || '') ? groups.shift() : null;
      let point = groups.length
        ? `${groups[0].toLowerCase()}${groups.slice(1).map((group) => `(${group.toLowerCase()})`).join('')}`
        : null;
      position = itemRe.lastIndex;
      const tokenEnd = position;

      namedPointRe.lastIndex = position;
      const namedPoint = namedPointRe.exec(text);
      if (namedPoint) {
        point = point || namedPoint[1].toLowerCase();
        position = namedPointRe.lastIndex;
      }

      qualifierRe.lastIndex = position;
      const qualifier = qualifierRe.exec(text);
      if (qualifier) {
        const ordinalParagraph = {
          first: '1', second: '2', third: '3', fourth: '4', last: 'last', final: 'last',
        }[qualifier[1]?.toLowerCase()];
        if (qualifier[2].toLowerCase() === 'paragraph') {
          paragraph = paragraph || qualifier[3] || ordinalParagraph || null;
        }
        point = point || qualifier[4]?.toLowerCase() || qualifier[5]?.toLowerCase() || null;
        position = qualifierRe.lastIndex;
      }

      if (pendingRange && items.length) {
        const from = Number(items[items.length - 1].articleNumber);
        const to = Number(articleNumber);
        if (Number.isInteger(from) && Number.isInteger(to) && to > from && to - from <= maxRangeSize) {
          for (let value = from + 1; value < to; value++) {
            items.push({
              articleNumber: String(value), paragraph: null, point: null,
              tokenStart: null, tokenEnd: null,
            });
          }
        }
      }
      items.push({
        articleNumber,
        paragraph,
        point: point?.toLowerCase() || null,
        tokenStart,
        tokenEnd,
      });
      pendingRange = false;

      separatorRe.lastIndex = position;
      const separator = separatorRe.exec(text);
      if (!separator) break;
      let next = separatorRe.lastIndex;

      abbreviatedGroupRe.lastIndex = next;
      const abbreviated = abbreviatedGroupRe.exec(text);
      if (abbreviated && items.length) {
        const value = abbreviated[1];
        const isRange = rangeSeparatorRe.test(separator[1]);
        appendAbbreviated(items, value, isRange, next, abbreviatedGroupRe.lastIndex);
        position = abbreviatedGroupRe.lastIndex;

        // Consume any further abbreviated members before transitioning back to
        // a full article token: "Article 6(2), (3) and (4)".
        let followingSeparator;
        let following;
        while (true) {
          separatorRe.lastIndex = position;
          followingSeparator = separatorRe.exec(text);
          if (!followingSeparator) break;
          following = separatorRe.lastIndex;
          abbreviatedGroupRe.lastIndex = following;
          const nextAbbreviated = abbreviatedGroupRe.exec(text);
          if (!nextAbbreviated) break;
          appendAbbreviated(
            items,
            nextAbbreviated[1],
            rangeSeparatorRe.test(followingSeparator[1]),
            following,
            abbreviatedGroupRe.lastIndex,
          );
          position = abbreviatedGroupRe.lastIndex;
        }
        if (!followingSeparator) break;
        repeatedArticleRe.lastIndex = following;
        if (repeatedArticleRe.exec(text)) following = repeatedArticleRe.lastIndex;
        digitRe.lastIndex = following;
        if (!digitRe.exec(text)) break;
        pendingRange = rangeSeparatorRe.test(followingSeparator[1]);
        position = following;
        continue;
      }

      repeatedArticleRe.lastIndex = next;
      if (repeatedArticleRe.exec(text)) next = repeatedArticleRe.lastIndex;
      digitRe.lastIndex = next;
      if (!digitRe.exec(text)) break;
      pendingRange = rangeSeparatorRe.test(separator[1]);
      position = next;
    }

    if (items.length) {
      results.push({ start: head.index, end: position, raw: text.slice(head.index, position), items });
      headRe.lastIndex = position;
    }
  }
  return results;
}

function isArticleOfActBridge(gap, connectorWord = 'of') {
  if (!gap || gap.length > MAX_ARTICLE_ACT_BRIDGE || !/\S/.test(gap)) return false;
  const trimmed = gap.trim();
  // The external-act matcher normally starts at the act noun, so the bridge
  // includes any definite article: "Article 6 of the Regulation".  Legal lists
  // also commonly insert the closed parenthetical "as the case may be" before
  // the final "of"; accepting that phrase is still considerably narrower than
  // allowing arbitrary prose between an article and an act.
  if (!new RegExp(`(?:^|\\W)(?:${connectorWord})(?:\\s+the)?$`, 'i').test(trimmed)) return false;
  const body = trimmed
    .replace(new RegExp(`(?:${connectorWord})(?:\\s+the)?$`, 'i'), ' ')
    .replace(/\bas\s+the\s+case\s+may\s+be\b/gi, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(new RegExp(`\\b(?:${connectorWord}|and|or|to|point|points|paragraph|paragraphs|subparagraph|subparagraphs|indent|indents|thereof|Articles?|Artikels?|Art[ií]culos?|Articolo|Articoli|Artigos?|Artikelen?)\\b`, 'gi'), ' ')
    .replace(/\b\d+[a-z]?\b/gi, ' ')
    .replace(/[\s,;.–-]+/g, ' ')
    .trim();
  return body.length === 0;
}

function isBareArticleListBridge(gap, connectorWord = 'of') {
  if (!gap || gap.length > MAX_ARTICLE_ACT_BRIDGE || !/\S/.test(gap)) return false;
  const body = gap
    .replace(/\([^)]*\)/g, ' ')
    .replace(new RegExp(`\\b(?:${connectorWord}|and|or|point|points|paragraph|paragraphs|Articles?)\\b`, 'gi'), ' ')
    .replace(/\b\d+[a-z]?\b/gi, ' ')
    .replace(/[\s,;.–—-]+/g, ' ')
    .trim();
  return body.length === 0;
}

function bindArticleRefsToExternalRefs(text, articleRefs, externalRefs, {
  connectorWord = 'of',
  allowBare = false,
} = {}) {
  const boundExternalIndices = new Set();
  const boundArticleIndices = new Set();
  const contextualExternalRefs = [];

  for (let articleIndex = 0; articleIndex < articleRefs.length; articleIndex++) {
    const articleRef = articleRefs[articleIndex];
    let bestIndex = -1;
    let bestStart = Infinity;
    for (let externalIndex = 0; externalIndex < externalRefs.length; externalIndex++) {
      const externalRef = externalRefs[externalIndex];
      if (externalRef.start < articleRef.end || externalRef.start >= bestStart) continue;
      if (externalRef.start - articleRef.end > MAX_ARTICLE_ACT_BRIDGE) continue;
      const gap = text.slice(articleRef.end, externalRef.start);
      const canBindBare = (allowBare || externalRef.allowBareArticleBinding)
        && (/^[\s,;:–—-]*$/.test(gap) || isBareArticleListBridge(gap, connectorWord));
      if (!canBindBare && !isArticleOfActBridge(gap, connectorWord)) continue;
      bestIndex = externalIndex;
      bestStart = externalRef.start;
    }
    if (bestIndex === -1) continue;

    const externalRef = externalRefs[bestIndex];
    boundArticleIndices.add(articleIndex);
    boundExternalIndices.add(bestIndex);
    contextualExternalRefs.push({
      ...externalRef,
      start: articleRef.start,
      raw: text.slice(articleRef.start, externalRef.end),
      articleNumber: articleRef.target || articleRef.articleNumber || articleRef.article,
      paragraph: articleRef.paragraph,
      point: articleRef.point,
    });
  }

  return {
    articleRefs: articleRefs.filter((_, index) => !boundArticleIndices.has(index)),
    externalRefs: [
      ...externalRefs.filter((_, index) => !boundExternalIndices.has(index)),
      ...contextualExternalRefs,
    ],
  };
}

/**
 * Bind "Article N thereof" to the nearest explicit external instrument earlier
 * in the same sentence. Unlike the forward "of Regulation …" binder, the
 * original act mention is retained because it is a separate, useful edge.
 */
function bindThereofArticleRefs(text, articleRefs, externalRefs, {
  maxDistance = MAX_THEREOF_ANTECEDENT_DISTANCE,
} = {}) {
  const boundArticleIndices = new Set();
  const boundRefs = [];

  for (let articleIndex = 0; articleIndex < articleRefs.length; articleIndex++) {
    const articleRef = articleRefs[articleIndex];
    const tail = text.slice(articleRef.end);
    const thereofMatch = tail.match(/^\s+thereof\b/i);
    if (!thereofMatch) continue;

    let antecedent = null;
    for (const externalRef of externalRefs) {
      if (externalRef.end > articleRef.start || (externalRef.contextual && !externalRef.treaty)) continue;
      const distance = articleRef.start - externalRef.end;
      if (distance > maxDistance || (antecedent && externalRef.end <= antecedent.end)) continue;
      const gap = text.slice(externalRef.end, articleRef.start);
      // Inline footnotes are flattened into prose and commonly end "). and …".
      // Treat a full stop as a boundary only when the following sentence starts
      // with an uppercase letter; question/exclamation marks remain absolute.
      const boundaryProbe = `${gap}${text[articleRef.start] || ''}`;
      if (/[!?](?:["')\]]*)\s|\.(?:["')\]]*)\s+(?=[A-Z])/.test(boundaryProbe)) continue;
      antecedent = externalRef;
    }
    if (!antecedent) continue;

    const end = articleRef.end + thereofMatch[0].length;
    boundArticleIndices.add(articleIndex);
    boundRefs.push({
      ...antecedent,
      start: articleRef.start,
      end,
      raw: text.slice(articleRef.start, end),
      articleNumber: articleRef.target || articleRef.articleNumber || articleRef.article,
      paragraph: articleRef.paragraph,
      point: articleRef.point,
    });
  }

  return {
    articleRefs: articleRefs.filter((_, index) => !boundArticleIndices.has(index)),
    externalRefs: boundRefs,
  };
}

function hydrateContextualRefs(refs, targetCelex) {
  const targetTypeCode = String(targetCelex || '').toUpperCase().match(/^3\d{4}([RLDF])/i)?.[1] || null;
  return (refs || []).map((ref) => {
    if (!ref?.contextual || ref.actCelex) return ref;
    const expectedTypeCode = ACT_TYPE_CODE[String(ref.actType || '').toLowerCase()] || null;
    return targetTypeCode && expectedTypeCode === targetTypeCode
      ? { ...ref, actCelex: targetCelex }
      : ref;
  });
}

/**
 * Remove the internal cross-reference anchors whose target article does not
 * exist in the parsed act, leaving the citation visible as plain text. A bare
 * "Article N" is only a valid internal link when N is an article of the current
 * act; flattened correlation tables and predecessor-act citations otherwise
 * produce broken or guessed links.
 */
function stripInvalidArticleLinks(html, validArticles) {
  return String(html || '').replace(
    /<a\b(?=[^>]*\bclass="cross-ref")(?=[^>]*\bdata-ref-article="([^"]+)")[^>]*>([\s\S]*?)<\/a>/gi,
    (match, target, label) => (validArticles.has(target) ? match : label),
  );
}

/**
 * Final integrity guard shared by both source formats (Formex XML and EUR-Lex
 * HTML): no internal edge or anchor may target an article absent from the fully
 * parsed act. Mutates `parsed` in place (article/recital/annex HTML and the
 * crossReferences map) and returns it. `article.paragraphs[].html` is guarded
 * defensively so the invariant extends to that field wherever it is produced.
 */
function enforceInternalReferenceIntegrity(parsed) {
  const validArticles = new Set((parsed.articles || []).map((article) => String(article.article_number)));
  const clean = (html) => stripInvalidArticleLinks(html, validArticles);
  for (const article of parsed.articles || []) {
    article.article_html = clean(article.article_html);
    for (const paragraph of article.paragraphs || []) paragraph.html = clean(paragraph.html);
  }
  for (const recital of parsed.recitals || []) recital.recital_html = clean(recital.recital_html);
  for (const annex of parsed.annexes || []) annex.annex_html = clean(annex.annex_html);
  for (const [location, refs] of Object.entries(parsed.crossReferences || {})) {
    const validRefs = refs.filter((ref) => ref.type !== 'article' || validArticles.has(String(ref.target)));
    if (validRefs.length) parsed.crossReferences[location] = validRefs;
    else delete parsed.crossReferences[location];
  }
  return parsed;
}

module.exports = {
  ACT_CELEX_MAP,
  MAX_ARTICLE_ACT_BRIDGE,
  MAX_THEREOF_ANTECEDENT_DISTANCE,
  bindArticleRefsToExternalRefs,
  bindThereofArticleRefs,
  dedupeReferences,
  enforceInternalReferenceIntegrity,
  hydrateContextualRefs,
  isArticleOfActBridge,
  normalizeYear,
  parseInstrumentIdentifier,
  referenceDedupeKey,
  resolveInstrumentCelex,
  scanArticleEnumerations,
  stripInvalidArticleLinks,
};
