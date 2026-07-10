const test = require('node:test');
const assert = require('node:assert/strict');

const { createParsedLawResolver } = require('./parsed-law-service');

test('resolveParsedLaw uses the HTML fallback path when skipFmxProbe is set and caches the result', async () => {
  let htmlCalls = 0;
  const resolveParsedLaw = createParsedLawResolver({
    prepareLawPayload: async () => { throw new Error('prepareLawPayload should not be called'); },
    fetchAndParseHtmlLaw: async (celex, lang) => {
      htmlCalls += 1;
      return { source: 'eurlex-html', title: `Law ${celex} ${lang}`, articles: [], recitals: [], annexes: [], definitions: [], crossReferences: {} };
    },
    CELEX_NAMES: { '32016R0679': 'GDPR' },
  });

  const first = await resolveParsedLaw('32016R0679', 'ENG', { skipFmxProbe: true });
  assert.equal(first.source, 'eurlex-html');
  assert.equal(first.name, 'GDPR');
  assert.equal(first.format, 'combined-v1');

  const second = await resolveParsedLaw('32016R0679', 'ENG', { skipFmxProbe: true });
  assert.equal(second.title, first.title);
  assert.equal(htmlCalls, 1, 'second call for the same celex/lang should be served from cache');

  // A different language is a distinct cache key.
  await resolveParsedLaw('32016R0679', 'FRA', { skipFmxProbe: true });
  assert.equal(htmlCalls, 2);
});

test('resolveParsedLaw propagates servedLang from the HTML fallback without overriding the requested lang', async () => {
  // Simulates the real fetchAndParseHtmlLawCached in server.js, which always serves
  // English HTML (servedLang) even when a different language was requested (lang),
  // so callers can tell the two apart instead of the content being silently mislabeled.
  const resolveParsedLaw = createParsedLawResolver({
    prepareLawPayload: async () => { throw new Error('prepareLawPayload should not be called'); },
    fetchAndParseHtmlLaw: async (celex, lang) => ({
      celex,
      lang,
      servedLang: 'ENG',
      source: 'eurlex-html',
      title: `Law ${celex}`,
      articles: [],
      recitals: [],
      annexes: [],
      definitions: [],
      crossReferences: {},
    }),
  });

  const result = await resolveParsedLaw('32016R0679', 'FRA', { skipFmxProbe: true });
  assert.equal(result.lang, 'FRA', 'top-level lang should stay the requested language for routing/URL state');
  assert.equal(result.servedLang, 'ENG', 'servedLang should surface the language actually served');
});
