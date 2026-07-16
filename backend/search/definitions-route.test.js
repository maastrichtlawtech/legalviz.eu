const test = require("node:test");
const assert = require("node:assert/strict");

const { createDefinitionCompareHandler, createDefinitionSearchHandler } = require("./definitions-route");

function response() {
  return {
    statusCode: 200, payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

test("definition search handler validates and returns grouped results", () => {
  const store = {
    searchDefinitions: (query, options) => [{ term: query, lawCount: Number(options.limit) }],
    getDefinitionsStatus: () => ({ ready: true }),
  };
  const handler = createDefinitionSearchHandler(store);
  const missing = response();
  handler({ query: {} }, missing);
  assert.equal(missing.statusCode, 400);

  const found = response();
  handler({ query: { q: " risk ", limit: "4" } }, found);
  assert.deepEqual(found.payload, {
    query: "risk", filter: null, count: 1, results: [{ term: "risk", lawCount: 4 }],
  });

  const discovered = response();
  handler({ query: { filter: "different", limit: "6" } }, discovered);
  assert.deepEqual(discovered.payload, {
    query: "", filter: "different", count: 1, results: [{ term: "", lawCount: 6 }],
  });

  const invalid = response();
  handler({ query: { filter: "conflicts" } }, invalid);
  assert.equal(invalid.statusCode, 400);
});

test("definition compare handler returns comparison and maps unavailable index", () => {
  const available = createDefinitionCompareHandler({
    compareDefinitions: (term) => ({ term, occurrences: [] }),
    getDefinitionsStatus: () => ({ ready: true }),
  });
  const found = response();
  available({ query: { term: "risk" } }, found);
  assert.deepEqual(found.payload, { term: "risk", occurrences: [] });

  const unavailable = createDefinitionCompareHandler({
    compareDefinitions() { const error = new Error("missing"); error.code = "definition_index_unavailable"; throw error; },
    getDefinitionsStatus: () => ({ ready: false, terms: 0 }),
  });
  const missing = response();
  unavailable({ query: { term: "risk" } }, missing);
  assert.equal(missing.statusCode, 503);
  assert.equal(missing.payload.code, "definition_index_unavailable");
  assert.deepEqual(missing.payload.details, { ready: false, terms: 0 });
});
