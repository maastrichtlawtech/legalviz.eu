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
