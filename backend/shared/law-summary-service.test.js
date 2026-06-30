const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildLawSummaryInput,
  ensureLawSummary,
  parseLawSummaryJson,
} = require('./law-summary-service');

function sampleParsedLaw() {
  return {
    celex: '32016R0679',
    lang: 'ENG',
    title: 'Regulation (EU) 2016/679',
    source: 'test',
    articles: [
      {
        article_number: '1',
        article_title: 'Subject matter and objectives',
        article_html: '<p>This Regulation lays down rules relating to personal data.</p>',
        division: { chapter: { title: 'General provisions' } },
      },
      {
        article_number: '5',
        article_title: 'Principles relating to processing',
        article_html: '<p>Personal data shall be processed lawfully, fairly and transparently.</p>',
        division: { chapter: { title: 'Principles' } },
      },
    ],
    recitals: [{ recital_number: '1', recital_text: 'Protection of natural persons.' }],
    definitions: [{ term: 'personal data', sourceArticle: '4' }],
    crossReferences: {
      1: [{ type: 'external', raw: 'Directive 95/46/EC', target: 'Directive 95/46/EC' }],
    },
  };
}

test('parseLawSummaryJson keeps only valid article citations and related instruments', () => {
  const input = buildLawSummaryInput(sampleParsedLaw());
  const summary = parseLawSummaryJson(JSON.stringify({
    purpose: { text: 'It protects personal data.', citations: ['1', '999'] },
    scope: { text: 'It applies to personal data processing.', citations: ['1'] },
    keyObligations: [
      { text: 'Data must be processed lawfully.', citations: ['5'] },
      { text: 'Invalid obligation is dropped.', citations: ['999'] },
    ],
    structure: 'It starts with general provisions and then sets principles.',
    relatedInstruments: [
      { label: 'Directive 95/46/EC', celex: '31995L0046', relationship: 'Predecessor data-protection framework.' },
      { label: 'Invented Act', celex: '39999X0000', relationship: 'Should be rejected.' },
    ],
  }), input);

  assert.deepEqual(summary.purpose.citations, ['1']);
  assert.deepEqual(summary.keyObligations.map((item) => item.citations), [['5']]);
  assert.equal(summary.relatedInstruments.length, 1);
  assert.equal(summary.relatedInstruments[0].celex, '31995L0046');
});

test('ensureLawSummary caches validated summaries', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'law-summary-service-'));
  let calls = 0;
  const chatComplete = async () => {
    calls++;
    return {
      model: 'test-model',
      usage: { total_tokens: 10 },
      text: JSON.stringify({
        purpose: { text: 'It protects personal data.', citations: ['1'] },
        scope: { text: 'It applies to personal data processing.', citations: ['1'] },
        keyObligations: [{ text: 'Data must be processed lawfully.', citations: ['5'] }],
        structure: 'It starts with general provisions and then sets principles.',
        relatedInstruments: [{ label: 'Directive 95/46/EC', celex: '31995L0046', relationship: 'Predecessor framework.' }],
      }),
    };
  };

  const first = await ensureLawSummary({
    celex: '32016R0679',
    lang: 'ENG',
    parsedLaw: sampleParsedLaw(),
    cacheDir,
    apiKey: 'test-key',
    model: 'test-model',
    chatComplete,
  });
  const second = await ensureLawSummary({
    celex: '32016R0679',
    lang: 'ENG',
    parsedLaw: sampleParsedLaw(),
    cacheDir,
    apiKey: null,
    model: 'test-model',
    chatComplete,
  });

  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
});
