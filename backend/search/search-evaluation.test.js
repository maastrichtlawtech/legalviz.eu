const test = require("node:test");
const assert = require("node:assert/strict");

const {
  evaluateSearch,
  loadEvaluationCases,
  parseArgs,
  percentile,
  summarizeOutcomes,
} = require("./eval/run");

test("search evaluation dataset has unique, valid categorized cases", () => {
  const cases = loadEvaluationCases();
  assert.ok(cases.length >= 15);
  assert.equal(new Set(cases.map((entry) => entry.id)).size, cases.length);
  assert.ok(cases.some((entry) => entry.category === "typo"));
  assert.ok(cases.some((entry) => entry.category === "alias"));
});

test("search evaluation calculates recall, reciprocal rank, and failures", () => {
  const cases = [
    { id: "first", category: "exact", query: "one", expectedCelexes: ["A"] },
    { id: "second", category: "title", query: "two", expectedCelexes: ["B"] },
    { id: "miss", category: "title", query: "three", expectedCelexes: ["C"] },
  ];
  const results = {
    one: [{ celex: "A" }],
    two: [{ celex: "X" }, { celex: "B" }],
    three: [{ celex: "X" }],
  };
  const report = evaluateSearch({ searchLaws: (query) => results[query] }, cases);
  assert.equal(report.recallAt1, 1 / 3);
  assert.equal(report.recallAt5, 2 / 3);
  assert.equal(report.mrr, 0.5);
  assert.deepEqual(report.failures.map((entry) => entry.id), ["second", "miss"]);
  assert.deepEqual(summarizeOutcomes(report.outcomes), {
    count: 3,
    recallAt1: 1 / 3,
    recallAt5: 2 / 3,
    mrr: 0.5,
  });
});

test("search evaluation percentile and CLI validation are deterministic", () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
  assert.equal(percentile([1, 2, 3, 4], 0.95), 4);
  assert.equal(parseArgs(["--iterations", "2", "--limit", "10", "--json"]).iterations, 2);
  assert.throws(() => parseArgs(["--iterations", "0"]), /positive/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown argument/);
});
