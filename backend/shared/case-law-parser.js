/**
 * Citation parsing for English EUR-Lex judgment text.
 *
 * Judgment HTML has changed several times, but its visible citation grammar is
 * much more stable.  Parse the visible text instead of depending on a particular
 * HTML generation, and keep unresolved/contextual references rather than
 * silently discarding them.
 */

// Bump whenever citation extraction changes so cached judgments are reparsed.
// v13 disambiguates unlabelled historical regulation number/year forms.
const CITATION_PARSER_VERSION = 13;
const {
  ACT_CELEX_MAP,
  dedupeReferences,
  hydrateContextualRefs,
  resolveInstrumentCelex,
  scanArticleEnumerations: scanSharedArticleEnumerations,
} = require('./legal-reference-core.mjs');

function cleanText(text) {
  return String(text || '').replace(/[\s\n\t]+/g, ' ').trim();
}

function parseArticleToken(tok) {
  const match = String(tok || '').trim().match(/^(\d+[a-z]?)((?:\([^)]+\))*)$/i);
  if (!match) return null;
  let paragraph = null;
  let point = null;
  for (const group of [...match[2].matchAll(/\(([^)]+)\)/g)].map((item) => item[1])) {
    if (/^\d+[a-z]?$/i.test(group) && paragraph === null) paragraph = group;
    else if (/^[a-z0-9]+$/i.test(group) && point === null) point = group.toLowerCase();
  }
  return { article: match[1], paragraph, point };
}

function articleLabel(ref) {
  return `${ref.article}${ref.paragraph ? `(${ref.paragraph})` : ''}${ref.point ? `(${ref.point})` : ''}`;
}

function scanArticleEnumerations(text) {
  return scanSharedArticleEnumerations(text, {
    articleWordSource: '\\bArticles?',
    listWordSource: 'and\\/or|and|or|et|read\\s+in\\s+conjunction\\s+with',
  })
    .map((enumeration) => ({
      ...enumeration,
      items: enumeration.items.map((item) => ({
        article: item.articleNumber,
        paragraph: item.paragraph,
        point: item.point,
      })),
    }));
}

function parseActAfterEnumeration(text, end) {
  const tail = text.slice(end, end + 280);
  const connector = tail.match(
    /^\s*\]?\s*\[?\s*[,;:…–—-]?\s*(?:(?:entitled\s+)?[‘'](?!(?:this|that|same|latter)\b)[^’']{1,80}[’']\s*,?\s*)?(?:(?:respectively\s*,?\s*)?(?:of|in|into|to|du)\s*,?\s+)?(?:(?:(?:and|together\s+with)\s+(?:the\s+)?annex(?:es)?\b[^.;:]{0,80}?\b(?:to|of)\s*,?\s+)|(?:and\s+(?:(?:in\s+the\s+light\s+of|of)\s+)?recitals?\s+\d+[a-z]?\s+(?:in\s+the\s+preamble\s+)?(?:of|to)\s+))?(?:(?:the\s+)?\[\s*(?:the\s+)?|(?:the\s+)?)[‘']?/i,
  );
  const offset = connector ? connector[0].length : 0;
  const candidate = tail.slice(offset);

  const thereof = candidate.match(/^thereof\b/i);
  if (thereof) {
    return {
      act: 'thereof',
      actType: null,
      actCelex: null,
      contextual: true,
      end: end + offset + thereof[0].length,
    };
  }

  const shorthand = candidate.match(
    /^(GDPR|Charter|TFEU|TEU|ECHR|EEC\s+Treaty|EC\s+Treaty|ECSC\s+Treaty|EAEC\s+Treaty|Euratom\s+Treaty|Treaty\s+establishing\s+the\s+European(?:\s+Economic)?\s+Community|(?:the\s+)?same\s+Treaty|Treaty|EC)\b/i,
  );
  if (shorthand) {
    const canonical = {
      gdpr: 'GDPR', charter: 'Charter', tfeu: 'TFEU', teu: 'TEU', echr: 'ECHR',
      'eec treaty': 'EEC Treaty', 'ec treaty': 'EC Treaty', 'ecsc treaty': 'ECSC Treaty',
      'eaec treaty': 'Euratom Treaty', 'euratom treaty': 'Euratom Treaty', ec: 'EC Treaty',
      'treaty establishing the european economic community': 'EEC Treaty',
      'treaty establishing the european community': 'EC Treaty',
      'same treaty': 'Treaty', 'the same treaty': 'Treaty', treaty: 'Treaty',
    }[shorthand[1].toLowerCase().replace(/\s+/g, ' ')];
    return {
      act: canonical,
      actType: null,
      actCelex: ACT_CELEX_MAP[canonical] || null,
      contextual: canonical === 'Treaty',
      end: end + offset + shorthand[0].length,
    };
  }

  const namedContextual = candidate.match(/^(Authorisation\s+Directive|SGEI\s+Decision)\b/i);
  if (namedContextual) {
    const actType = /Directive$/i.test(namedContextual[1]) ? 'directive' : 'decision';
    return {
      act: namedContextual[1],
      actType,
      actCelex: null,
      contextual: true,
      end: end + offset + namedContextual[0].length,
    };
  }

  const contextual = candidate.match(
    /^(?:(?:that\s+same|that|this|same|latter)\s+)?(Regulation|Directive|Decision|Charter)(?!\s+(?:\([^)]*\)\s*)?(?:No\s*\.?\s*)?\d)\b/i,
  );
  if (contextual) {
    const actName = contextual[1].toLowerCase() === 'charter' ? 'Charter' : contextual[0];
    return {
      act: actName,
      actType: contextual[1].toLowerCase() === 'charter' ? null : contextual[1].toLowerCase(),
      actCelex: contextual[1].toLowerCase() === 'charter' ? ACT_CELEX_MAP.Charter : null,
      contextual: true,
      end: end + offset + contextual[0].length,
    };
  }

  const instrument = candidate.match(
    /^\[?\s*(?:First\s+)?(?:(?:Council|Commission|European Parliament and(?: of)? the Council)\]?\s+)?(?:(?:new\s+)?basic\s+)?(?:(EEC|EC|EU)\s+)?(?:(Framework|Implementing|Delegated)\s+)?(Regulation|Directive|Decision)s?\s+(?:\(\s*([A-Z]+)\s*\)\s*)?((?:No)\s*\.?)?\s*(\d{2,4}\/\d{1,4})(?:\/([A-Z]+))?/i,
  );
  if (!instrument) return null;
  const qualifier = instrument[2]?.toLowerCase() || null;
  const baseActType = instrument[3].toLowerCase();
  const actType = qualifier === 'framework' && baseActType === 'decision'
    ? 'framework decision'
    : baseActType;
  const originalIdentifier = instrument[6];
  const [first, originalSecond] = originalIdentifier.split('/');
  // Old HTML sometimes glues a footnote marker to a two-digit year
  // ("Decision 3632/93" + footnote 64 => "3632/9364").
  const second = first.length >= 3 && !/^(?:19|20)\d{2}$/.test(first)
    && /^\d{3,4}$/.test(originalSecond)
    && !/^(?:19|20)\d{2}$/.test(originalSecond)
    ? originalSecond.slice(0, 2)
    : originalSecond;
  const identifier = `${first}/${second}`;
  const implicitNumberFirst = (baseActType === 'regulation' || baseActType === 'decision')
    && second.length === 2 && !/^(?:19|20)\d{2}$/.test(first);
  return {
    act: identifier,
    actType,
    actCelex: resolveInstrumentCelex({
      actType,
      identifier,
      hasNo: Boolean(instrument[5]) || implicitNumberFirst,
    }),
    contextual: false,
    end: end + offset + instrument[0].length,
  };
}

function isOmissionVariant(shortValue, longValue) {
  if (shortValue.length > longValue.length || longValue.length - shortValue.length > 2) return false;
  let shortIndex = 0;
  for (const char of longValue) {
    if (char === shortValue[shortIndex]) shortIndex += 1;
  }
  return shortIndex === shortValue.length;
}

/**
 * Some judgment HTML has individual citation strings with dropped digits, even
 * while the correctly printed identifier appears elsewhere in the same
 * judgment.  Repair only a strict omission variant against one uniquely known
 * same-type instrument: this corrects source flattening such as 1408/1 →
 * 1408/71 without turning arbitrary malformed citations into guessed links.
 */
function hydrateOmittedIdentifierRefs(refs) {
  const known = (refs || []).filter((ref) => ref.actCelex && ref.actType
    && /^\d{2,4}\/\d{1,4}$/.test(ref.act || ''));
  return (refs || []).map((ref) => {
    if (ref.actCelex || ref.contextual || !ref.actType || !/^\d{2,4}\/\d{1,4}$/.test(ref.act || '')) return ref;
    const [shortFirst, shortSecond] = ref.act.split('/');
    const candidates = new Map();
    for (const candidate of known) {
      if (candidate.actType !== ref.actType) continue;
      const [longFirst, longSecond] = candidate.act.split('/');
      if (!isOmissionVariant(shortFirst, longFirst) || !isOmissionVariant(shortSecond, longSecond)) continue;
      if (shortFirst === longFirst && shortSecond === longSecond) continue;
      candidates.set(`${candidate.act}:${candidate.actCelex}`, candidate);
    }
    if (candidates.size !== 1) return ref;
    const candidate = candidates.values().next().value;
    return { ...ref, act: candidate.act, actCelex: candidate.actCelex };
  });
}

function extractArticleCitationsFromText(input) {
  const text = cleanText(input);
  const articlesCited = [];
  const articleRefs = [];
  const seenPills = new Set();

  for (const enumeration of scanArticleEnumerations(text)) {
    const act = parseActAfterEnumeration(text, enumeration.end);
    if (!act) continue;
    const raw = cleanText(text.slice(enumeration.start, act.end));
    const refs = enumeration.items.map((item) => ({
      raw,
      act: act.act,
      actType: act.actType,
      actCelex: act.actCelex,
      contextual: act.contextual,
      article: item.article,
      paragraph: item.paragraph,
      point: item.point,
    }));
    articleRefs.push(...refs);
    const pill = `Art. ${refs.map(articleLabel).join(', ')} ${act.act}`;
    const pillKey = pill.toLowerCase();
    if (!seenPills.has(pillKey)) {
      seenPills.add(pillKey);
      articlesCited.push(pill);
    }
  }

  return { articlesCited, articleRefs: dedupeReferences(hydrateOmittedIdentifierRefs(articleRefs)) };
}

/** Parse legacy compact pills retained in v3/v4 caches. */
function parseCitationsToRefs(citationStrings) {
  const refs = [];
  for (const value of citationStrings || []) {
    if (typeof value !== 'string') continue;
    const match = value.match(/^Art\.?\s+(.+?)\s+([A-Za-z]+|\d{2,4}\/\d+)\s*$/i);
    if (!match) continue;
    const act = match[2];
    const actKey = Object.keys(ACT_CELEX_MAP).find((key) => key.toLowerCase() === act.toLowerCase());
    const actCelex = actKey ? ACT_CELEX_MAP[actKey] : null;
    const tokens = match[1].replace(/\s+and\s+/gi, ',').split(',');
    for (const token of tokens) {
      const parsed = parseArticleToken(token);
      if (!parsed) continue;
      refs.push({ raw: value, act: actKey || act, actCelex, ...parsed });
    }
  }
  return dedupeReferences(refs);
}

module.exports = {
  ACT_CELEX_MAP,
  CITATION_PARSER_VERSION,
  extractArticleCitationsFromText,
  hydrateOmittedIdentifierRefs,
  hydrateContextualRefs,
  parseCitationsToRefs,
  resolveInstrumentCelex,
  scanArticleEnumerations,
};
