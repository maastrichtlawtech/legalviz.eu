const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  evaluateSearch,
  loadEvaluationCases,
  ndcgAt,
  pairwiseOutcome,
  parseArgs,
  percentile,
  summarizeOutcomes,
} = require("./eval/run");
const {
  compareOutcomes,
  pairedBootstrap,
  parseArgs: parseComparisonArgs,
} = require("./eval/compare-ranking");

test("search evaluation dataset has unique, valid categorized cases", () => {
  const cases = loadEvaluationCases();
  assert.ok(cases.length >= 15);
  assert.equal(new Set(cases.map((entry) => entry.id)).size, cases.length);
  assert.ok(cases.some((entry) => entry.category === "typo"));
  assert.ok(cases.some((entry) => entry.category === "alias"));
});

test("ranking evaluation has a fixed development/holdout split and graded judgments", () => {
  const cases = loadEvaluationCases(path.join(__dirname, "eval", "ranking-queries.json"));
  assert.equal(cases.length, 100);
  assert.equal(cases.filter((entry) => entry.split === "development").length, 80);
  assert.equal(cases.filter((entry) => entry.split === "holdout").length, 20);
  assert.equal(new Set(cases.map((entry) => entry.id)).size, cases.length);
  assert.ok(cases.every((entry) => entry.judgments.every((judgment) => [1, 2, 3].includes(judgment.relevance))));
  assert.ok(cases.some((entry) => entry.mustOutrank.length > 0));
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
  const summary = summarizeOutcomes(report.outcomes);
  assert.equal(summary.count, 3);
  assert.equal(summary.recallAt1, 1 / 3);
  assert.equal(summary.recallAt5, 2 / 3);
  assert.equal(summary.mrr, 0.5);
  assert.ok(Math.abs(summary.ndcgAt5 - 0.5436432511904858) < 1e-12);
  assert.equal(summary.pairwiseAccuracy, null);
  assert.equal(summary.pairwisePairs, 0);
});

test("search evaluation calculates graded nDCG and pairwise preferences", () => {
  const results = [{ celex: "CURRENT" }, { celex: "HISTORIC" }, { celex: "RELATED" }];
  const judgments = [
    { celex: "CURRENT", relevance: 3 },
    { celex: "RELATED", relevance: 2 },
    { celex: "HISTORIC", relevance: 1 },
  ];
  assert.ok(ndcgAt(results, judgments, 5) < 1);
  assert.ok(ndcgAt(results, judgments, 5) > 0.9);
  assert.deepEqual(pairwiseOutcome(results, [["CURRENT", "HISTORIC"]]), {
    correct: 1,
    total: 1,
    failures: [],
  });
  assert.equal(pairwiseOutcome(results, [["HISTORIC", "CURRENT"]]).correct, 0);
});

test("search evaluation percentile and CLI validation are deterministic", () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
  assert.equal(percentile([1, 2, 3, 4], 0.95), 4);
  assert.equal(parseArgs(["--iterations", "2", "--limit", "10", "--json"]).iterations, 2);
  assert.equal(parseArgs(["--split", "holdout", "--sqlite", "data.sqlite"]).split, "holdout");
  assert.equal(parseArgs(["--baseline-ranking"]).rankingProfile, "baseline");
  assert.throws(() => parseArgs(["--iterations", "0"]), /positive/);
  assert.throws(() => parseArgs(["--split", "training"]), /--split/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown argument/);
});

test("paired ranking comparison reports deterministic confidence intervals and wins", () => {
  const baseline = [
    { id: "a", rank: 2, ndcgAt5: 0.5, ndcgAt10: 0.5 },
    { id: "b", rank: null, ndcgAt5: 0, ndcgAt10: 0 },
    { id: "c", rank: 1, ndcgAt5: 1, ndcgAt10: 1 },
  ];
  const revised = [
    { id: "a", rank: 1, ndcgAt5: 1, ndcgAt10: 1 },
    { id: "b", rank: 4, ndcgAt5: 0.4, ndcgAt10: 0.4 },
    { id: "c", rank: 1, ndcgAt5: 1, ndcgAt10: 1 },
  ];
  const comparison = compareOutcomes(baseline, revised, { samples: 1_000, seed: 42 });
  assert.equal(comparison.recallAt1.wins, 1);
  assert.equal(comparison.recallAt5.wins, 1);
  assert.equal(comparison.ndcgAt10.wins, 2);
  assert.equal(comparison.ndcgAt10.losses, 0);
  assert.deepEqual(
    pairedBootstrap([1, 0, -1], { samples: 100, seed: 7 }),
    pairedBootstrap([1, 0, -1], { samples: 100, seed: 7 })
  );
  assert.equal(parseComparisonArgs(["--sqlite", "data.sqlite"]).split, "holdout");
  assert.equal(parseComparisonArgs(["--sqlite", "data.sqlite", "--enable-rewrites"]).disableRewrites, false);
  assert.throws(() => parseComparisonArgs(["--sqlite", "data.sqlite", "--split", "all"]), /--split/);
});
