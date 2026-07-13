const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildCaseLawDigestInput,
  ensureCaseLawDigest,
  parseCaseLawDigestJson,
} = require('./case-law-digest-service');

function sampleParsedLaw() {
  return {
    celex: '32014L0104',
    lang: 'ENG',
    title: 'Directive 2014/104/EU (Antitrust Damages)',
  };
}

function sampleCases() {
  return {
    celex: '32014L0104',
    cases: [
      {
        celex: '62021CJ0163',
        ecli: 'ECLI:EU:C:2022:863',
        caseNumber: 'C-163/21',
        date: '2022-11-10',
        name: 'PACCAR and Others',
        articlesCited: ['Article 5'],
        declarations: [{ number: 1, text: 'Article 5(1) covers the disclosure of relevant evidence that must be created ex novo.' }],
      },
      {
        celex: '62020CJ0267',
        ecli: 'ECLI:EU:C:2022:494',
        caseNumber: 'C-267/20',
        date: '2022-06-22',
        name: 'Volvo and DAF Trucks',
        articlesCited: ['Article 10'],
        declarations: [{ number: 1, text: 'Article 10 on limitation periods has partly retroactive effect.' }],
      },
    ],
  };
}

test('buildCaseLawDigestInput includes all cases sorted by date desc', () => {
  const input = buildCaseLawDigestInput('32014L0104', sampleParsedLaw(), sampleCases());

  assert.equal(input.totalCases, 2);
  assert.equal(input.includedCases, 2);
  assert.equal(input.actType, 'directive');
  assert.equal(input.cases[0].ecli, 'ECLI:EU:C:2022:863');
  assert.equal(input.cases[0].declarations[0].number, '1');
});

test('parseCaseLawDigestJson keeps only citations present in the input', () => {
  const input = buildCaseLawDigestInput('32014L0104', sampleParsedLaw(), sampleCases());
  const digest = parseCaseLawDigestJson(JSON.stringify({
    summary: 'The Court has clarified evidence disclosure and limitation periods.',
    noCaseLaw: false,
    themes: [
      {
        name: 'Disclosure of evidence',
        description: 'Article 5 covers evidence created ex novo.',
        cites: [
          { ecli: 'ECLI:EU:C:2022:863', declarationNumber: '1' },
          { ecli: 'ECLI:EU:C:2099:999', declarationNumber: '1' },
        ],
      },
    ],
  }), input);

  assert.equal(digest.noCaseLaw, false);
  assert.equal(digest.themes.length, 1);
  assert.deepEqual(digest.themes[0].cites, [{
    ecli: 'ECLI:EU:C:2022:863',
    celex: '62021CJ0163',
    caseNumber: 'C-163/21',
    name: 'PACCAR and Others',
    declarationNumber: '1',
  }]);
});

test('parseCaseLawDigestJson falls back to noCaseLaw when no theme can be grounded', () => {
  const input = buildCaseLawDigestInput('32014L0104', sampleParsedLaw(), sampleCases());

  const digest = parseCaseLawDigestJson(JSON.stringify({
    summary: 'The Court discusses the directive.',
    noCaseLaw: false,
    themes: [
      {
        name: 'Ungrounded',
        description: 'Nothing in the input supports this.',
        cites: [{ ecli: 'ECLI:EU:C:2099:999', declarationNumber: '1' }],
      },
    ],
  }), input);

  assert.equal(digest.noCaseLaw, true);
  assert.deepEqual(digest.themes, []);
});

test('ensureCaseLawDigest caches results without re-calling the model', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'case-law-digest-service-'));
  let calls = 0;
  const chatComplete = async () => {
    calls++;
    return {
      model: 'test-model',
      usage: null,
      text: JSON.stringify({
        summary: 'The Court has clarified evidence disclosure.',
        noCaseLaw: false,
        themes: [{
          name: 'Disclosure of evidence',
          description: 'Article 5 covers evidence created ex novo.',
          cites: [{ ecli: 'ECLI:EU:C:2022:863', declarationNumber: '1' }],
        }],
      }),
    };
  };
  const args = {
    celex: '32014L0104',
    lang: 'ENG',
    parsedLaw: sampleParsedLaw(),
    caseLawPayload: sampleCases(),
    cacheDir,
    apiKey: 'test-key',
    model: 'test-model',
    chatComplete,
  };

  const first = await ensureCaseLawDigest(args);
  const second = await ensureCaseLawDigest(args);

  assert.equal(first.digest.noCaseLaw, false);
  assert.equal(first.digest.themes.length, 1);
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
});

test('ensureCaseLawDigest caches no-case-law results without calling the model', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'case-law-digest-service-'));
  let calls = 0;
  const result = await ensureCaseLawDigest({
    celex: '32014L0104',
    lang: 'ENG',
    parsedLaw: sampleParsedLaw(),
    caseLawPayload: { celex: '32014L0104', cases: [] },
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
