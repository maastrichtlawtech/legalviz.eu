const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { SearchIndex } = require("./search-index");

const fixturePath = path.join(__dirname, "__fixtures__", "search-fixture.json");

const CASES = [
  ["32016R0679", "32016R0679"],
  ["regulation 2016/679", "32016R0679"],
  ["digital markets act", "32022R1925"],
  ["digital services act", "32022R2065"],
  ["data act", "32023R2854"],
  ["data governance act", "32022R0868"],
  ["ecommerce", "32000L0031"],
  ["eprivacy", "32002L0058"],
  ["payment services directive", "32015L2366"],
  ["genral data protection", "32016R0679"],
  ["artifical intelligence act", "32024R1689"],
  ["digital mark", "32022R1925"],
  ["csrd", "32022L2464"],
  ["mica", "32023R1114"],
  ["emfa", "32024R1083"]
];

test("search regression fixture queries rank expected law first without rewrites", () => {
  const index = new SearchIndex(fixturePath);
  assert.equal(index.loadFromDisk(), true);

  for (const [query, expected] of CASES) {
    const results = index.searchLaws(query, { limit: 1, disableRewrites: true });
    assert.equal(results[0]?.celex, expected, `Expected ${expected} for query "${query}"`);
  }
});
