const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SearchIndex } = require("./search-index");
const { evaluateSearch, loadEvaluationCases } = require("./eval/run");
const { buildSqliteData } = require("./build-sqlite-data");

const fixturePath = path.join(__dirname, "__fixtures__", "search-fixture.json");

function assertRegressionCases(index, cases, label) {
  assert.equal(index.loadFromDisk(), true, `${label} failed to load`);
  const report = evaluateSearch(index, cases, { limit: 5, disableRewrites: true });
  assert.equal(
    report.recallAt1,
    1,
    report.failures
      .map((failure) => `${label}/${failure.id}: expected ${failure.expectedCelexes.join("/")}, got ${failure.resultCelexes.join(", ")}`)
      .join("\n")
  );
}

test("search regression fixture queries rank expected law first without rewrites", () => {
  const cases = loadEvaluationCases();
  const jsonIndex = new SearchIndex(fixturePath);
  assertRegressionCases(jsonIndex, cases, "json");
  jsonIndex.close();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "search-regression-sqlite-"));
  const caseLawPath = path.join(tempDir, "case-law.json");
  const sqlitePath = path.join(tempDir, "data.sqlite");
  fs.writeFileSync(caseLawPath, "{}", "utf8");
  buildSqliteData({ searchCachePath: fixturePath, caseLawCachePath: caseLawPath, outputPath: sqlitePath });
  const sqliteIndex = new SearchIndex(fixturePath, { sqlitePath, requireSqlite: true });
  assertRegressionCases(sqliteIndex, cases, "sqlite");
  sqliteIndex.close();
});
