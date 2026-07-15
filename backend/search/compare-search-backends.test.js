const test = require("node:test");
const assert = require("node:assert/strict");

const { evaluateParity } = require("./compare-search-backends");

test("evaluateParity reports preserved and regressed rankings", () => {
  const cases = [
    { query: "gdpr", expectedCelex: "32016R0679", maxRank: 1 },
    { query: "conceptual query" },
  ];
  const jsonRuns = [
    { results: ["32016R0679", "A"] },
    { results: ["OLD", "B"] },
  ];
  const sqliteRuns = [
    { results: ["32016R0679", "A"] },
    { results: ["B", "C", "D", "E", "F", "OLD"] },
  ];
  const report = evaluateParity(cases, jsonRuns, sqliteRuns, 5);
  assert.equal(report.summary.queries, 2);
  assert.equal(report.summary.sameTopResult, 1);
  assert.equal(report.summary.failures, 1);
  assert.match(report.failures[0], /outside SQLite top 5/);
});
