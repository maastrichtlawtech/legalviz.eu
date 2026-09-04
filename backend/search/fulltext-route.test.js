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
