const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  clip,
  stableHash,
  makeSingleFlight,
  loadCache,
  saveCache,
  extractJsonObject,
  normalizeCites,
} = require('./ai-digest-utils');

test('clip strips tags and caps length with an ellipsis', () => {
  assert.equal(clip('<p>hello  world</p>', 100), 'hello world');
  assert.equal(clip('abcdef', 3), 'abc...');
});

test('loadCache / saveCache round-trip under a caller-supplied filename', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-digest-utils-'));
  assert.deepEqual(loadCache(dir, 'a.json'), {});
  saveCache(dir, 'a.json', { x: 1 });
  saveCache(dir, 'b.json', { y: 2 });
  assert.deepEqual(loadCache(dir, 'a.json'), { x: 1 });
  assert.deepEqual(loadCache(dir, 'b.json'), { y: 2 });
});

test('makeSingleFlight coalesces concurrent calls and clears after settle', async () => {
  const withSingleFlight = makeSingleFlight();
  let calls = 0;
  const factory = () => { calls++; return Promise.resolve('v'); };
  const [a, b] = await Promise.all([
    withSingleFlight('k', factory),
    withSingleFlight('k', factory),
  ]);
  assert.equal(a, 'v');
  assert.equal(b, 'v');
  assert.equal(calls, 1);
  await withSingleFlight('k', factory); // new flight once the first settled
  assert.equal(calls, 2);
});

test('extractJsonObject unwraps fenced JSON and throws on non-JSON', () => {
  assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => extractJsonObject('no json here'), /did not return a JSON object/);
});

test('normalizeCites drops ungrounded cites and honours the limit', () => {
  const input = {
    cases: [
      { celex: '62021CJ0163', ecli: 'ECLI:EU:C:2022:863', caseNumber: 'C-163/21', name: 'PACCAR', declarations: [{ number: 1 }] },
      { celex: '62020CJ0267', ecli: 'ECLI:EU:C:2022:494', caseNumber: 'C-267/20', name: 'Volvo', declarations: [{ number: 1 }] },
    ],
  };
  const cites = [
    { ecli: 'ECLI:EU:C:2022:863', declarationNumber: '1' },
    { ecli: 'ECLI:EU:C:2022:494', declarationNumber: '1' },
    { ecli: 'ECLI:EU:C:2099:999', declarationNumber: '1' }, // not in input
  ];
  assert.equal(normalizeCites(cites, input).length, 2);
  assert.equal(normalizeCites(cites, input, { limit: 1 }).length, 1);
});

test('stableHash is deterministic for equal values', () => {
  assert.equal(stableHash({ a: 1, b: [2, 3] }), stableHash({ a: 1, b: [2, 3] }));
});
