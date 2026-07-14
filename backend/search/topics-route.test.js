const test = require("node:test");
const assert = require("node:assert/strict");

const { createTopicsHandler } = require("./topics-route");

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
    },
  };
}

function createStore({ ready = true, records = {} } = {}) {
  return {
    isReady() {
      return ready;
    },
    getStatus() {
      return { ready, count: Object.keys(records).length };
    },
    getByCelex(celex) {
      return records[celex] || null;
    },
  };
}

test("topics route requires celex", () => {
  const handler = createTopicsHandler(createStore());
  const res = createResponseRecorder();
  handler({ query: {} }, res);
  assert.equal(res.statusCode, 400);
});

test("topics route rejects too many celex ids", () => {
  const handler = createTopicsHandler(createStore());
  const res = createResponseRecorder();
  const many = Array.from({ length: 201 }, (_, i) => `C${i}`).join(",");
  handler({ query: { celex: many } }, res);
  assert.equal(res.statusCode, 400);
});

test("topics route returns 503 when cache is unavailable", () => {
  const handler = createTopicsHandler(createStore({ ready: false }));
  const res = createResponseRecorder();
  handler({ query: { celex: "32016R0679" } }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.payload.code, "search_cache_unavailable");
  assert.equal(res.payload.details.ready, false);
});

test("topics route maps celex ids to their eurovoc labels", () => {
  const handler = createTopicsHandler(createStore({
    records: {
      "32016R0679": { celex: "32016R0679", eurovoc: ["data protection", "personal data"] },
      "32024R1689": { celex: "32024R1689", eurovoc: [] },
    },
  }));
  const res = createResponseRecorder();
  // lowercase + duplicate + unknown celex should be normalized/handled.
  handler({ query: { celex: "32016r0679, 32016R0679 ,32024R1689,39999X9999" } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.topics, { "32016R0679": ["data protection", "personal data"] });
});

test("topics route caps topics at five per law", () => {
  const handler = createTopicsHandler(createStore({
    records: {
      "32016R0679": { celex: "32016R0679", eurovoc: ["a", "b", "c", "d", "e", "f", "g"] },
    },
  }));
  const res = createResponseRecorder();
  handler({ query: { celex: "32016R0679" } }, res);
  assert.deepEqual(res.payload.topics["32016R0679"], ["a", "b", "c", "d", "e"]);
});
