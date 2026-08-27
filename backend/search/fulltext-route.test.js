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
