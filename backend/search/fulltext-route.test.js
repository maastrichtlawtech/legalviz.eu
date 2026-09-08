const test = require("node:test");
const assert = require("node:assert/strict");

const { createFulltextSearchHandler } = require("./fulltext-route");

function response() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

test("fulltext route returns normalized scoped results and forwards the bounded limit", () => {
  const calls = [];
  const handler = createFulltextSearchHandler({
    searchFulltextUnits(query, options) {
      calls.push({ query, options });
      return [{ celex: "32016R0679", title: "GDPR", unitType: "article", number: "5", snippet: "data", highlightRanges: [{ start: 0, end: 4 }] }];
    },
  }, { validateCelex: (value) => value === "32016R0679" });
  const res = response();

  handler({ query: { q: "  data  ", celex: "32016r0679", limit: "50" } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.query, "data");
  assert.equal(res.payload.celex, "32016R0679");
  assert.equal(res.payload.count, 1);
  assert.deepEqual(calls, [{ query: "data", options: { limit: "50", celex: "32016R0679" } }]);
});

test("fulltext POST route normalizes and deduplicates a CELEX collection", () => {
  const calls = [];
  const handler = createFulltextSearchHandler({
    searchFulltextUnits(query, options) {
      calls.push({ query, options });
      return [{ celex: "32016R0679", title: "GDPR", unitType: "article", number: "5", snippet: "data", highlightRanges: [] }];
    },
  }, {
    validateCelex: (value) => ["32016R0679", "32024R1689"].includes(value),
    collection: true,
  });
  const res = response();

  handler({
    method: "POST",
    body: { q: "  data  ", celexes: [" 32016r0679 ", "32024r1689", "32016R0679"], limit: 50 },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.celexes, ["32016R0679", "32024R1689"]);
  assert.equal(res.payload.count, 1);
  assert.deepEqual(calls, [{
    query: "data",
    options: { limit: 50, celexes: ["32016R0679", "32024R1689"] },
  }]);
});

test("fulltext POST route opts into two previews per selected act", () => {
  const calls = [];
  const handler = createFulltextSearchHandler({
    searchFulltextUnits(query, options) {
      calls.push({ query, options });
      return [
        { celex: "32016R0679", title: "GDPR", unitType: "article", number: "5", snippet: "data", highlightRanges: [] },
        { celex: "32016R0679", title: "GDPR", unitType: "article", number: "6", snippet: "data", highlightRanges: [] },
      ];
    },
  }, {
    validateCelex: (value) => value === "32016R0679",
    collection: true,
  });
  const res = response();

  handler({
    method: "POST",
    body: { q: "data", celexes: ["32016R0679"], limit: 1, previewsPerAct: 2 },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.count, 2);
  assert.deepEqual(calls, [{
    query: "data",
    options: { limit: 1, celexes: ["32016R0679"], previewsPerAct: 2 },
  }]);
});

test("fulltext route adds counts only for an explicit opt-in", () => {
  const calls = [];
  const handler = createFulltextSearchHandler({
    searchFulltextUnits(query, options) {
      calls.push({ type: "results", query, options });
      return [{ celex: "32016R0679", title: "GDPR", unitType: "article", number: "5", snippet: "data", highlightRanges: [] }];
    },
    getFulltextMatchCounts(query, options) {
      calls.push({ type: "counts", query, options });
      return {
        totalMatchingPassages: 3,
        totalMatchingActs: 2,
        totalMatchingArticles: 2,
        totalMatchingRecitals: 1,
        matchCountsByCelex: { "32016R0679": 2, "32024R1689": 1 },
        matchTypesByCelex: {
          "32016R0679": { articles: 2, recitals: 0 },
          "32024R1689": { articles: 0, recitals: 1 },
        },
      };
    },
  }, {
    validateCelex: (value) => ["32016R0679", "32024R1689"].includes(value),
    collection: true,
  });

  const legacy = response();
  handler({ method: "POST", body: { q: "data", celexes: ["32016R0679"] } }, legacy);
  assert.deepEqual(legacy.payload, {
    query: "data",
    celexes: ["32016R0679"],
    count: 1,
    results: [{ celex: "32016R0679", title: "GDPR", unitType: "article", number: "5", snippet: "data", highlightRanges: [] }],
  });
  assert.equal(calls.filter((call) => call.type === "counts").length, 0);

  for (const includeCounts of [true, "true", "1", 1]) {
    const res = response();
    handler({ method: "POST", body: { q: "data", celexes: ["32016R0679", "32024R1689"], includeCounts } }, res);
    assert.equal(res.payload.totalMatchingPassages, 3);
    assert.equal(res.payload.totalMatchingActs, 2);
    assert.equal(res.payload.totalMatchingArticles, 2);
    assert.equal(res.payload.totalMatchingRecitals, 1);
    assert.deepEqual(res.payload.matchCountsByCelex, { "32016R0679": 2, "32024R1689": 1 });
    assert.deepEqual(res.payload.matchTypesByCelex, {
      "32016R0679": { articles: 2, recitals: 0 },
      "32024R1689": { articles: 0, recitals: 1 },
    });
    assert.equal(res.payload.results[0].matchCount, 2);
    assert.deepEqual(res.payload.results[0].matchTypes, { articles: 2, recitals: 0 });
  }
  assert.equal(calls.filter((call) => call.type === "counts").length, 4);
});

test("fulltext POST two previews retain exact count metadata for each result", () => {
  const handler = createFulltextSearchHandler({
    searchFulltextUnits() {
      return [
        { celex: "32016R0679", title: "GDPR", unitType: "article", number: "5", snippet: "data", highlightRanges: [] },
        { celex: "32016R0679", title: "GDPR", unitType: "article", number: "6", snippet: "data", highlightRanges: [] },
      ];
    },
    getFulltextMatchCounts() {
      return {
        totalMatchingPassages: 3,
        totalMatchingActs: 1,
        totalMatchingArticles: 2,
        totalMatchingRecitals: 1,
        matchCountsByCelex: { "32016R0679": 3 },
        matchTypesByCelex: { "32016R0679": { articles: 2, recitals: 1 } },
      };
    },
  }, {
    validateCelex: (value) => value === "32016R0679",
    collection: true,
  });
  const res = response();

  handler({
    method: "POST",
    body: { q: "data", celexes: ["32016R0679"], previewsPerAct: 2, includeCounts: true },
  }, res);

  assert.equal(res.payload.totalMatchingPassages, 3);
  assert.equal(res.payload.totalMatchingActs, 1);
  assert.equal(res.payload.totalMatchingArticles, 2);
  assert.equal(res.payload.totalMatchingRecitals, 1);
  assert.deepEqual(res.payload.matchCountsByCelex, { "32016R0679": 3 });
  assert.deepEqual(res.payload.matchTypesByCelex, { "32016R0679": { articles: 2, recitals: 1 } });
  assert.deepEqual(res.payload.results.map((result) => result.matchCount), [3, 3]);
  assert.deepEqual(res.payload.results.map((result) => result.matchTypes), [
    { articles: 2, recitals: 1 },
    { articles: 2, recitals: 1 },
  ]);
});

test("unscoped GET omits the global count map while scoped GET includes it", () => {
  const handler = createFulltextSearchHandler({
    searchFulltextUnits() {
      return [{ celex: "32016R0679", title: "GDPR", unitType: "article", number: "5", snippet: "data", highlightRanges: [] }];
    },
    getFulltextMatchCounts(query, { celex }) {
      assert.equal(query, "data");
      if (celex) {
        assert.equal(celex, "32016R0679");
        return {
          totalMatchingPassages: 2,
          totalMatchingActs: 1,
          totalMatchingArticles: 1,
          totalMatchingRecitals: 1,
          matchCountsByCelex: { [celex]: 2 },
          matchTypesByCelex: { [celex]: { articles: 1, recitals: 1 } },
        };
      }
      return {
        totalMatchingPassages: 3,
        totalMatchingActs: 2,
        totalMatchingArticles: 2,
        totalMatchingRecitals: 1,
        matchCountsByCelex: { "32016R0679": 2, "32024R1689": 1 },
        matchTypesByCelex: {
          "32016R0679": { articles: 1, recitals: 1 },
          "32024R1689": { articles: 1, recitals: 0 },
        },
      };
    },
  }, { validateCelex: (value) => value === "32016R0679" });

  const global = response();
  handler({ query: { q: "data", includeCounts: "true" } }, global);
  assert.equal(global.payload.matchCountsByCelex, undefined);
  assert.equal(global.payload.matchTypesByCelex, undefined);
  assert.equal(global.payload.results[0].matchCount, 2);
  assert.deepEqual(global.payload.results[0].matchTypes, { articles: 1, recitals: 1 });

  const scoped = response();
  handler({ query: { q: "data", celex: "32016R0679", includeCounts: "1" } }, scoped);
  assert.deepEqual(scoped.payload.matchCountsByCelex, { "32016R0679": 2 });
  assert.deepEqual(scoped.payload.matchTypesByCelex, { "32016R0679": { articles: 1, recitals: 1 } });
  assert.equal(scoped.payload.totalMatchingPassages, 2);
});

test("fulltext POST route rejects malformed collections with stable codes", () => {
  const handler = createFulltextSearchHandler({
    searchFulltextUnits() { throw new Error("must not search invalid input"); },
  }, {
    validateCelex: (value) => /^\d{5}[A-Z]{1,2}\d{4}(?:\([0-9]+\))?$/.test(value),
    collection: true,
  });

  for (const celexes of [undefined, null, "32016R0679", []]) {
    const res = response();
    handler({ method: "POST", body: { q: "data", celexes } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.code, "fulltext_celexes_required");
  }

  const tooMany = response();
  handler({ method: "POST", body: { q: "data", celexes: Array.from({ length: 201 }, () => "32016R0679") } }, tooMany);
  assert.equal(tooMany.statusCode, 400);
  assert.equal(tooMany.payload.code, "fulltext_celexes_too_many");

  for (const celexes of [["not-a-celex"], [null], ["  "]]) {
    const res = response();
    handler({ method: "POST", body: { q: "data", celexes } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.code, "invalid_celex");
  }

  for (const previewsPerAct of [0, 3, 1.5, "2", null, {}]) {
    const res = response();
    handler({ method: "POST", body: { q: "data", celexes: ["32016R0679"], previewsPerAct } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.code, "fulltext_previews_per_act_invalid");
    assert.equal(res.payload.error, 'Request body property "previewsPerAct" must be an integer from 1 to 2');
  }
});

test("fulltext route validates required, bounded, punctuation-only, and CELEX input", () => {
  const handler = createFulltextSearchHandler({
    searchFulltextUnits() { throw new Error("must not search invalid input"); },
  }, { validateCelex: () => false });

  for (const query of [undefined, "", "   "]) {
    const res = response();
    handler({ query: { q: query } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.code, "fulltext_query_required");
  }

  for (const query of ["***", "a", "a ".repeat(101), "one two three four five six seven eight nine ten eleven twelve thirteen"]) {
    const res = response();
    handler({ query: { q: query } }, res);
    assert.equal(res.statusCode, 400, query);
    assert.match(res.payload.code, /^fulltext_query_/);
  }

  const celexRes = response();
  handler({ query: { q: "data", celex: "not-a-celex" } }, celexRes);
  assert.equal(celexRes.statusCode, 400);
  assert.equal(celexRes.payload.code, "invalid_celex");
});

test("fulltext route maps unavailable indexes to a detailed 503", () => {
  const handler = createFulltextSearchHandler({
    searchFulltextUnits() {
      const error = new Error("Full-text index is not loaded");
      error.code = "fulltext_index_unavailable";
      throw error;
    },
    getFulltextStatus: () => ({ available: false, reason: "missing" }),
  });
  const res = response();

  handler({ query: { q: "data" } }, res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.payload.code, "fulltext_index_unavailable");
  assert.equal(res.payload.error, "Full-text index is not available; metadata/title/excerpt search remains available but is not an equivalent fallback.");
  assert.deepEqual(res.payload.details, { available: false, reason: "missing" });
});
