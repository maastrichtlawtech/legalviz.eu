"use strict";

const path = require("node:path");

const { SearchIndex } = require("../search-index");
const { evaluateSearch, loadEvaluationCases } = require("./run");

const casesPath = path.join(__dirname, "ranking-queries.json");
const sqliteFlag = process.argv.indexOf("--sqlite");
const sqlitePath = sqliteFlag === -1 ? null : process.argv[sqliteFlag + 1];
const ablationsOnly = process.argv.includes("--ablations-only");
if (!sqlitePath) {
  console.error("Usage: node search/eval/tune-ranking.js --sqlite /path/to/data.sqlite");
  process.exit(1);
}

// Keep this intentionally small and explicit. The holdout set is never loaded
// here, making accidental tuning on it impossible.
const configurations = [
  { name: "default", rrfK: 20, coverageExponent: 2, sourceWeights: { title: 1.1, eurovoc: 1.1, excerpt: 0.5 } },
  { name: "initial-fusion", rrfK: 20, coverageExponent: 2, sourceWeights: { title: 1, eurovoc: 1.2, excerpt: 0.5 } },
  { name: "k10", rrfK: 10, coverageExponent: 2, sourceWeights: { title: 1, eurovoc: 1.2, excerpt: 0.5 } },
  { name: "k40", rrfK: 40, coverageExponent: 2, sourceWeights: { title: 1, eurovoc: 1.2, excerpt: 0.5 } },
  { name: "coverage-1.5", rrfK: 20, coverageExponent: 1.5, sourceWeights: { title: 1, eurovoc: 1.2, excerpt: 0.5 } },
  { name: "coverage-2.5", rrfK: 20, coverageExponent: 2.5, sourceWeights: { title: 1, eurovoc: 1.2, excerpt: 0.5 } },
  { name: "title-1.2", rrfK: 20, coverageExponent: 2, sourceWeights: { title: 1.2, eurovoc: 1.2, excerpt: 0.5 } },
  { name: "title-1.4", rrfK: 20, coverageExponent: 2, sourceWeights: { title: 1.4, eurovoc: 1.2, excerpt: 0.5 } },
  { name: "eurovoc-0.8", rrfK: 20, coverageExponent: 2, sourceWeights: { title: 1, eurovoc: 0.8, excerpt: 0.5 } },
  { name: "eurovoc-1.0", rrfK: 20, coverageExponent: 2, sourceWeights: { title: 1, eurovoc: 1, excerpt: 0.5 } },
  { name: "eurovoc-1.4", rrfK: 20, coverageExponent: 2, sourceWeights: { title: 1, eurovoc: 1.4, excerpt: 0.5 } },
  { name: "excerpt-0.3", rrfK: 20, coverageExponent: 2, sourceWeights: { title: 1, eurovoc: 1.2, excerpt: 0.3 } },
  { name: "excerpt-0.7", rrfK: 20, coverageExponent: 2, sourceWeights: { title: 1, eurovoc: 1.2, excerpt: 0.7 } },
  { name: "title-heavy", rrfK: 20, coverageExponent: 2, sourceWeights: { title: 1.3, eurovoc: 1, excerpt: 0.4 } },
  { name: "topic-heavy", rrfK: 20, coverageExponent: 2, sourceWeights: { title: 1, eurovoc: 1.4, excerpt: 0.4 } },
  { name: "body-heavy", rrfK: 20, coverageExponent: 2, sourceWeights: { title: 1, eurovoc: 1, excerpt: 0.7 } },
  { name: "k10-coverage-2.5", rrfK: 10, coverageExponent: 2.5, sourceWeights: { title: 1, eurovoc: 1.2, excerpt: 0.5 } },
  { name: "k40-coverage-1.5", rrfK: 40, coverageExponent: 1.5, sourceWeights: { title: 1, eurovoc: 1.2, excerpt: 0.5 } },
  { name: "balanced-1.2", rrfK: 20, coverageExponent: 2, sourceWeights: { title: 1.2, eurovoc: 1.2, excerpt: 0.5 } },
  { name: "title-1.1-eurovoc-1.0", rrfK: 20, coverageExponent: 2, sourceWeights: { title: 1.1, eurovoc: 1, excerpt: 0.5 } },
  { name: "title-1.2-eurovoc-1.0", rrfK: 20, coverageExponent: 2, sourceWeights: { title: 1.2, eurovoc: 1, excerpt: 0.5 } },
  { name: "title-1.2-eurovoc-1.1", rrfK: 20, coverageExponent: 2, sourceWeights: { title: 1.2, eurovoc: 1.1, excerpt: 0.5 } },
  { name: "title-1.2-excerpt-0.4", rrfK: 20, coverageExponent: 2, sourceWeights: { title: 1.2, eurovoc: 1.2, excerpt: 0.4 } },
  { name: "title-1.2-excerpt-0.6", rrfK: 20, coverageExponent: 2, sourceWeights: { title: 1.2, eurovoc: 1.2, excerpt: 0.6 } },
  { name: "title-1.3-eurovoc-1.1", rrfK: 20, coverageExponent: 2, sourceWeights: { title: 1.3, eurovoc: 1.1, excerpt: 0.5 } },
  { name: "no-status-prior", rrfK: 20, coverageExponent: 2, sourceWeights: { title: 1.1, eurovoc: 1.1, excerpt: 0.5 }, useStatusPrior: false },
  { name: "no-citation-prior", rrfK: 20, coverageExponent: 2, sourceWeights: { title: 1.1, eurovoc: 1.1, excerpt: 0.5 }, useCitationPrior: false },
  { name: "no-global-priors", rrfK: 20, coverageExponent: 2, sourceWeights: { title: 1.1, eurovoc: 1.1, excerpt: 0.5 }, useStatusPrior: false, useCitationPrior: false },
  { name: "no-eurovoc-source", rrfK: 20, coverageExponent: 2, sourceWeights: { title: 1.1, eurovoc: 0, excerpt: 0.5 } },
  { name: "no-excerpt-source", rrfK: 20, coverageExponent: 2, sourceWeights: { title: 1.1, eurovoc: 1.1, excerpt: 0 } },
  { name: "no-topic-or-excerpt", rrfK: 20, coverageExponent: 2, sourceWeights: { title: 1.1, eurovoc: 0, excerpt: 0 } },
];

function objective(metrics) {
  const pairwise = metrics.pairwiseAccuracy ?? 0;
  return (0.45 * metrics.ndcgAt10) + (0.2 * metrics.recallAt1)
    + (0.2 * metrics.recallAt5) + (0.15 * pairwise);
}

const searcher = new SearchIndex(undefined, {
  sqlitePath: path.resolve(sqlitePath),
  requireSqlite: true,
});
if (!searcher.loadFromDisk()) throw new Error(searcher.loadError || "Search cache failed to load");

const developmentCases = loadEvaluationCases(casesPath)
  .filter((entry) => entry.split === "development");
const baseRankingConfig = {
  ...searcher.rankingConfig,
  sourceWeights: { ...searcher.rankingConfig.sourceWeights },
};
const selectedConfigurations = ablationsOnly
  ? configurations.filter((configuration) => configuration.name === "default" || configuration.name.startsWith("no-"))
  : configurations;
const rows = selectedConfigurations.map((configuration) => {
  searcher.rankingConfig = {
    ...baseRankingConfig,
    ...configuration,
    sourceWeights: { ...baseRankingConfig.sourceWeights, ...configuration.sourceWeights },
  };
  const metrics = evaluateSearch(searcher, developmentCases, { limit: 10 });
  return {
    name: configuration.name,
    score: objective(metrics),
    recallAt1: metrics.recallAt1,
    recallAt5: metrics.recallAt5,
    ndcgAt5: metrics.ndcgAt5,
    ndcgAt10: metrics.ndcgAt10,
    pairwise: metrics.pairwiseAccuracy,
  };
}).sort((left, right) => right.score - left.score);

console.table(rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [
  key,
  typeof value === "number" ? Number(value.toFixed(4)) : value,
]))));
searcher.close();
