const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildArticleDigestInput,
  ensureArticleDigest,
  parseArticleDigestJson,
} = require('./article-digest-service');

function sampleParsedLaw() {
  return {
    celex: '32016R0679',
    lang: 'ENG',
    title: 'Regulation (EU) 2016/679',
    articles: [
      {
        article_number: '6',
        article_title: 'Lawfulness of processing',
        article_html: '<p>Processing shall be lawful only if one legal basis applies.</p>',
        division: { chapter: { title: 'Principles' } },
      },
    ],
  };
}

function sampleCases() {
  return {
    celex: '32016R0679',
    cases: [
      {
        celex: '62018CJ0311',
        ecli: 'ECLI:EU:C:2020:559',
        caseNumber: 'C-311/18',
        date: '2020-07-16',
        name: 'Schrems II',
        declarations: [{ number: 1, text: 'Article 6 must be interpreted as requiring a valid legal basis.' }],
        articleRefs: [{ actCelex: '32016R0679', article: '6', paragraph: '1', point: null }],
      },
      {
        celex: '62020CJ0001',
        ecli: 'ECLI:EU:C:2021:1',
        declarations: [{ number: 1, text: 'Article 5 ruling.' }],
        articleRefs: [{ actCelex: '32016R0679', article: '5' }],
      },
    ],
  };
}

test('buildArticleDigestInput filters case law by structured article refs', () => {
  const input = buildArticleDigestInput('32016R0679', '6', sampleParsedLaw(), sampleCases());

  assert.equal(input.article.number, '6');
  assert.equal(input.cases.length, 1);
  assert.equal(input.cases[0].ecli, 'ECLI:EU:C:2020:559');
  assert.equal(input.cases[0].declarations[0].number, '1');
});

test('parseArticleDigestJson keeps only citations present in the input', () => {
  const input = buildArticleDigestInput('32016R0679', '6', sampleParsedLaw(), sampleCases());
  const digest = parseArticleDigestJson(JSON.stringify({
    summary: 'The Court links Article 6 to a valid legal basis.',
    noCaseLaw: false,
    themes: [
      {
        name: 'Legal basis',
        description: 'Processing must rest on a valid legal basis.',
        cites: [
          { ecli: 'ECLI:EU:C:2020:559', declarationNumber: '1' },
          { ecli: 'ECLI:EU:C:2099:999', declarationNumber: '1' },
        ],
      },
    ],
  }), input);

  assert.equal(digest.noCaseLaw, false);
  assert.equal(digest.themes.length, 1);
  assert.deepEqual(digest.themes[0].cites, [{
    ecli: 'ECLI:EU:C:2020:559',
    celex: '62018CJ0311',
    declarationNumber: '1',
  }]);
});

test('ensureArticleDigest caches no-case-law results without calling the model', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'article-digest-service-'));
  let calls = 0;
  const result = await ensureArticleDigest({
    celex: '32016R0679',
    articleNumber: '6',
    lang: 'ENG',
    parsedLaw: sampleParsedLaw(),
    caseLawPayload: { celex: '32016R0679', cases: [] },
    cacheDir,
    apiKey: null,
    model: 'test-model',
    chatComplete: async () => {
      calls++;
      throw new Error('chatComplete should not be called');
    },
  });

  assert.equal(result.digest.noCaseLaw, true);
  assert.equal(calls, 0);
});
