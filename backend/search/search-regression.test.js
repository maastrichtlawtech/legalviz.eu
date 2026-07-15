const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { SearchIndex } = require("./search-index");
const { evaluateSearch, loadEvaluationCases } = require("./eval/run");

const fixturePath = path.join(__dirname, "__fixtures__", "search-fixture.json");

test("search regression fixture queries rank expected law first without rewrites", () => {
  const index = new SearchIndex(fixturePath);
  assert.equal(index.loadFromDisk(), true);
  const report = evaluateSearch(index, loadEvaluationCases(), { limit: 5, disableRewrites: true });
  assert.equal(
    report.recallAt1,
    1,
    report.failures.map((failure) => `${failure.id}: expected ${failure.expectedCelexes.join("/")}, got ${failure.resultCelexes.join(", ")}`).join("\n")
  );
});
