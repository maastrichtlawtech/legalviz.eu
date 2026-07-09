const test = require("node:test");
const assert = require("node:assert/strict");

const { createSearchHandler } = require("./search-route");

function createResponseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    }
  };
}

test("search route requires q", () => {
  const handler = createSearchHandler({
    searchLaws() {
      throw new Error("should not be called");
    }
  });
  const res = createResponseRecorder();
  handler({ query: {} }, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.payload, { error: 'Query parameter "q" required' });
});

test("search route returns 503 when cache is unavailable", () => {
  const handler = createSearchHandler({
    searchLaws() {
      const error = new Error("cache unavailable");
      error.code = "search_cache_unavailable";
      throw error;
    },
    getStatus() {
      return { ready: false, count: 0 };
    }
  });
  const res = createResponseRecorder();
  handler({ query: { q: "gdpr" } }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.payload.code, "search_cache_unavailable");
  assert.equal(res.payload.details.ready, false);
});

test("search route returns results payload", () => {
  const handler = createSearchHandler({
    searchLaws(query, options) {
      assert.equal(query, "gdpr");
      assert.equal(options.limit, "1");
      assert.equal(options.disableRewrites, false);
      return [
        {
          celex: "32016R0679",
          title: "GDPR",
          type: "regulation",
          date: "2016-04-27",
          eli: "http://data.europa.eu/eli/reg/2016/679/oj",
          fmxAvailable: true,
          matchReason: "alias_exact",
          topics: ["data protection", "personal data"]
        }
      ];
    }
  });
  const res = createResponseRecorder();
  handler({ query: { q: "gdpr", limit: "1" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.query, "gdpr");
  assert.equal(res.payload.count, 1);
  assert.equal(res.payload.results[0].celex, "32016R0679");
  assert.deepEqual(res.payload.results[0].topics, ["data protection", "personal data"]);
});
