const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { fetchCaseLaw, parseCitationsToRefs } = require("./law-queries");
const { CITATION_PARSER_VERSION } = require('./case-law-parser');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("fetchCaseLaw returns quickly while warming uncached details in the background", async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "case-law-cache-"));
  const caseCelex = "61999CJ0465";
  const startedAt = Date.now();

  const payload = await fetchCaseLaw("31995L0046", async () => ({
    results: {
      bindings: [
        {
          caseCelex: { value: caseCelex },
          ecli: { value: "ECLI:EU:C:2000:000" },
          date: { value: "2000-05-01" },
        },
      ],
    },
  }), {
    cacheDir,
    enrichBudgetMs: 10,
    detailsFetcher: async () => {
      await sleep(80);
      return {
        name: "Example v Example",
        declarations: [{ number: 1, text: "Example ruling." }],
        articlesCited: ["Art. 6 GDPR"],
        citationParserVersion: CITATION_PARSER_VERSION,
      };
    },
  });

  const elapsedMs = Date.now() - startedAt;
  assert.equal(payload.celex, "31995L0046");
  assert.equal(payload.cases.length, 1);
  assert.equal(payload.cases[0].name, null);
  assert.deepEqual(payload.cases[0].declarations, []);
  assert.ok(elapsedMs < 70, `Expected a bounded response, got ${elapsedMs}ms`);

  await sleep(140);

  const cachePath = path.join(cacheDir, "case-law-cache-v5.json");
  const saved = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  assert.deepEqual(saved[caseCelex], {
    name: "Example v Example",
    declarations: [{ number: 1, text: "Example ruling." }],
    articlesCited: ["Art. 6 GDPR"],
    citationParserVersion: CITATION_PARSER_VERSION,
    articleRefs: [
      {
        raw: "Art. 6 GDPR",
        act: "GDPR",
        actCelex: "32016R0679",
        article: "6",
        paragraph: null,
        point: null,
      },
    ],
  });
});

test("parseCitationsToRefs handles plain, paragraph, point, and 95/46-style tokens", () => {
  const refs = parseCitationsToRefs([
    "Art. 6 GDPR",
    "Art. 6(1) GDPR",
    "Art. 6(1)(a) GDPR",
    "Art. 7(a) 95/46",
    "Art. 267 TFEU",
  ]);
  assert.deepEqual(refs, [
    { raw: "Art. 6 GDPR", act: "GDPR", actCelex: "32016R0679", article: "6", paragraph: null, point: null },
    { raw: "Art. 6(1) GDPR", act: "GDPR", actCelex: "32016R0679", article: "6", paragraph: "1", point: null },
    { raw: "Art. 6(1)(a) GDPR", act: "GDPR", actCelex: "32016R0679", article: "6", paragraph: "1", point: "a" },
    { raw: "Art. 7(a) 95/46", act: "95/46", actCelex: "31995L0046", article: "7", paragraph: null, point: "a" },
    { raw: "Art. 267 TFEU", act: "TFEU", actCelex: "12012E", article: "267", paragraph: null, point: null },
  ]);
});

test("parseCitationsToRefs resolves actCelex for all mapped acts", () => {
  const cases = [
    ["Art. 5 2002/58",   "32002L0058"],
    ["Art. 1 2016/680",  "32016L0680"],
    ["Art. 8 Charter",   "12012P"],
    ["Art. 5 2016/679",  "32016R0679"],
    ["Art. 3 TEU",       "12012M"],
    ["Art. 1 2022/2065", "32022R2065"],
    ["Art. 1 2022/1925", "32022R1925"],
    ["Art. 1 2024/1689", "32024R1689"],
    ["Art. 1 2016/943",  null],   // unmapped — left null
  ];
  for (const [str, expectedCelex] of cases) {
    const refs = parseCitationsToRefs([str]);
    assert.equal(refs.length, 1, `expected one ref for "${str}"`);
    assert.equal(refs[0].actCelex, expectedCelex, `actCelex mismatch for "${str}"`);
  }
});

test("parseCitationsToRefs splits composite 'N and M' / 'N, M and P' strings", () => {
  const refs = parseCitationsToRefs([
    "Art. 45 and 46 GDPR",
    "Art. 5, 6 and 10 GDPR",
  ]);
  assert.equal(refs.length, 5);
  assert.deepEqual(
    refs.map((r) => ({ art: r.article, raw: r.raw })),
    [
      { art: "45", raw: "Art. 45 and 46 GDPR" },
      { art: "46", raw: "Art. 45 and 46 GDPR" },
      { art: "5", raw: "Art. 5, 6 and 10 GDPR" },
      { art: "6", raw: "Art. 5, 6 and 10 GDPR" },
      { art: "10", raw: "Art. 5, 6 and 10 GDPR" },
    ]
  );
});

test("parseCitationsToRefs deduplicates repeated (act, article, paragraph, point) tuples", () => {
  const refs = parseCitationsToRefs([
    "Art. 6(1)(a) GDPR",
    "Art. 6(1)(a) GDPR",
  ]);
  assert.equal(refs.length, 1);
});

test("parseCitationsToRefs tolerates malformed strings without throwing", () => {
  const refs = parseCitationsToRefs([
    "",
    "not a citation",
    "Article 6 of Regulation (EU) 2016/679", // long form, not compact
    null,
  ]);
  assert.deepEqual(refs, []);
});

test("fetchCaseLaw migrates v4 cache and schedules it for citation re-parsing", async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "case-law-cache-"));
  const caseCelex = "62019CJ0439";

  // Seed a v4-style cache file. It has structured refs but no parser version,
  // so it is returned immediately and refreshed in the background.
  const v4Path = path.join(cacheDir, "case-law-cache-v4.json");
  fs.writeFileSync(v4Path, JSON.stringify({
    [caseCelex]: {
      name: "B v Latvijas Republikas Saeima",
      declarations: [{ number: 1, text: "The Court rules." }],
      articlesCited: ["Art. 5, 6 and 10 GDPR"],
      articleRefs: parseCitationsToRefs(["Art. 5, 6 and 10 GDPR"]),
    },
  }));

  const payload = await fetchCaseLaw("32016R0679", async () => ({
    results: {
      bindings: [
        {
          caseCelex: { value: caseCelex },
          ecli: { value: "ECLI:EU:C:2021:504" },
          date: { value: "2021-06-22" },
        },
      ],
    },
  }), {
    cacheDir,
    enrichBudgetMs: 10,
    detailsFetcher: async () => null,
  });

  const caseEntry = payload.cases[0];
  assert.equal(caseEntry.articleRefs.length, 3);
  assert.deepEqual(
    caseEntry.articleRefs.map((r) => r.article),
    ["5", "6", "10"]
  );

  // A v5 file is written, but the old entry deliberately has no current parser
  // marker and will therefore be retried rather than treated as permanently good.
  const v5Path = path.join(cacheDir, "case-law-cache-v5.json");
  assert.ok(fs.existsSync(v5Path), "expected v5 cache file to be written");
  const v5 = JSON.parse(fs.readFileSync(v5Path, "utf8"));
  assert.equal(v5[caseCelex].citationParserVersion, undefined);
});

test('fetchCaseLaw includes and formats General Court judgments', async () => {
  let query = '';
  const payload = await fetchCaseLaw('32022R2065', async (value) => {
    query = value;
    return {
      results: {
        bindings: [{
          caseCelex: { value: '62025TJ0123' },
          ecli: { value: 'ECLI:EU:T:2026:1' },
          date: { value: '2026-01-01' },
        }],
      },
    };
  }, { enrichBudgetMs: 0, detailsFetcher: async () => null });

  assert.match(query, /\(CJ\|TJ\)/);
  assert.equal(payload.cases[0].caseNumber, 'T-123/25');
});

test('fetchCaseLaw keeps zero-ref parses retryable instead of silently accepting them', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'case-law-cache-'));
  const caseCelex = '62020CJ0001';
  await fetchCaseLaw('32004L0048', async () => ({
    results: { bindings: [{ caseCelex: { value: caseCelex } }] },
  }), {
    cacheDir,
    enrichBudgetMs: 100,
    detailsFetcher: async () => ({
      name: 'Example judgment',
      declarations: [{ number: 1, text: 'The Court rules.' }],
      articlesCited: [],
      articleRefs: [],
      citationParserVersion: CITATION_PARSER_VERSION,
    }),
  });

  const saved = JSON.parse(fs.readFileSync(path.join(cacheDir, 'case-law-cache-v5.json'), 'utf8'));
  assert.equal(saved[caseCelex].name, 'Example judgment');
  assert.deepEqual(saved[caseCelex].articleRefs, []);
  assert.equal(typeof saved[caseCelex].lastFailedAt, 'number');
});
