"use strict";

const path = require("node:path");

const { SearchIndex } = require("../search-index");
const { evaluateSearch, loadEvaluationCases, percentile } = require("./run");

function seededRandom(seed = 0x5eed1234) {
  let state = seed >>> 0;
  return () => {
    state = ((1664525 * state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pairedBootstrap(deltas, { samples = 10_000, seed = 0x5eed1234 } = {}) {
  if (deltas.length === 0) return { mean: 0, low: 0, high: 0, probabilityPositive: 0 };
  const random = seededRandom(seed);
  const means = [];
  let positive = 0;
  for (let sample = 0; sample < samples; sample += 1) {
    let total = 0;
    for (let index = 0; index < deltas.length; index += 1) {
      total += deltas[Math.floor(random() * deltas.length)];
    }
    const mean = total / deltas.length;
    means.push(mean);
    if (mean > 0) positive += 1;
  }
  means.sort((left, right) => left - right);
  return {
    mean: deltas.reduce((sum, value) => sum + value, 0) / deltas.length,
    low: percentile(means, 0.025),
    high: percentile(means, 0.975),
    probabilityPositive: positive / samples,
  };
}

function compareOutcomes(baseline, revised, options = {}) {
  const revisedById = new Map(revised.map((outcome) => [outcome.id, outcome]));
  const pairs = baseline.map((left) => {
    const right = revisedById.get(left.id);
    if (!right) throw new Error(`Missing revised outcome for ${left.id}`);
    return { left, right };
  });
  const extractors = {
    recallAt1: (outcome) => outcome.rank === 1 ? 1 : 0,
    recallAt5: (outcome) => outcome.rank != null && outcome.rank <= 5 ? 1 : 0,
    reciprocalRank: (outcome) => outcome.rank == null ? 0 : 1 / outcome.rank,
    ndcgAt5: (outcome) => outcome.ndcgAt5,
    ndcgAt10: (outcome) => outcome.ndcgAt10,
  };
  return Object.fromEntries(Object.entries(extractors).map(([name, extract]) => {
    const deltas = pairs.map(({ left, right }) => extract(right) - extract(left));
    const wins = deltas.filter((delta) => delta > 0).length;
    const losses = deltas.filter((delta) => delta < 0).length;
    return [name, { ...pairedBootstrap(deltas, options), wins, losses, ties: deltas.length - wins - losses }];
  }));
}

function evaluateProfile(sqlitePath, cases, rankingProfile, { disableRewrites = true } = {}) {
  const searcher = new SearchIndex(undefined, {
    sqlitePath,
    requireSqlite: true,
    rankingProfile,
  });
  if (!searcher.loadFromDisk()) throw new Error(searcher.loadError || "Search cache failed to load");
  const report = evaluateSearch(searcher, cases, { limit: 10, disableRewrites });
  searcher.close();
  return report;
}

function parseArgs(argv) {
  const options = {
    sqlitePath: null,
    casesPath: path.join(__dirname, "ranking-queries.json"),
    split: "holdout",
    samples: 10_000,
    disableRewrites: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--enable-rewrites") {
      options.disableRewrites = false;
      continue;
    }
    const value = argv[index + 1];
    if (!["--sqlite", "--cases", "--split", "--samples"].includes(token) || !value) {
      throw new Error(`Unknown or incomplete argument: ${token}`);
    }
    if (token === "--sqlite") options.sqlitePath = path.resolve(value);
    else if (token === "--cases") options.casesPath = path.resolve(value);
    else if (token === "--split") options.split = value;
    else options.samples = Number.parseInt(value, 10);
    index += 1;
  }
  if (!options.sqlitePath) throw new Error("--sqlite is required");
  if (!["development", "holdout"].includes(options.split)) throw new Error("--split must be development or holdout");
  if (!Number.isInteger(options.samples) || options.samples < 100) throw new Error("--samples must be at least 100");
  return options;
}

function percent(value) {
  return `${(100 * value).toFixed(1)}%`;
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const cases = loadEvaluationCases(options.casesPath).filter((entry) => entry.split === options.split);
    const baseline = evaluateProfile(options.sqlitePath, cases, "baseline", options);
    const revised = evaluateProfile(options.sqlitePath, cases, "revised", options);
    const comparison = compareOutcomes(baseline.outcomes, revised.outcomes, { samples: options.samples });
    console.log(`Paired ranking comparison: ${cases.length} ${options.split} cases, ${options.samples} bootstrap samples, rewrites ${options.disableRewrites ? "off" : "on"}`);
    console.table(Object.entries(comparison).map(([metric, result]) => ({
      metric,
      delta: Number(result.mean.toFixed(4)),
      "95% CI": `[${result.low.toFixed(4)}, ${result.high.toFixed(4)}]`,
      "P(delta>0)": percent(result.probabilityPositive),
      wins: result.wins,
      losses: result.losses,
      ties: result.ties,
    })));
  } catch (error) {
    console.error(`Ranking comparison failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { compareOutcomes, pairedBootstrap, parseArgs, seededRandom };
