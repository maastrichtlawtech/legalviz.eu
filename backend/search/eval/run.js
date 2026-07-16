"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const { SearchIndex } = require("../search-index");

const DEFAULT_CASES_PATH = path.join(__dirname, "queries.json");
const DEFAULT_CACHE_PATH = path.join(__dirname, "..", "__fixtures__", "search-fixture.json");

function loadEvaluationCases(filePath = DEFAULT_CASES_PATH) {
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (![1, 2].includes(payload.schemaVersion) || !Array.isArray(payload.cases)) {
    throw new Error(`Unsupported search evaluation dataset at ${filePath}`);
  }

  const ids = new Set();
  for (const entry of payload.cases) {
    if (!entry?.id || ids.has(entry.id)) throw new Error(`Duplicate or missing evaluation id: ${entry?.id}`);
    const hasLegacyJudgments = Array.isArray(entry.expectedCelexes) && entry.expectedCelexes.length > 0;
    const hasGradedJudgments = Array.isArray(entry.judgments) && entry.judgments.length > 0
      && entry.judgments.every((judgment) => judgment?.celex && [1, 2, 3].includes(judgment.relevance));
    const validPairs = entry.mustOutrank == null || (Array.isArray(entry.mustOutrank)
      && entry.mustOutrank.every((pair) => Array.isArray(pair) && pair.length === 2 && pair.every(Boolean)));
    if (!entry.category || !entry.query || (!hasLegacyJudgments && !hasGradedJudgments) || !validPairs) {
      throw new Error(`Invalid search evaluation case: ${entry.id}`);
    }
    ids.add(entry.id);
  }
  return payload.cases.map((entry) => {
    const judgments = entry.judgments || entry.expectedCelexes.map((celex) => ({ celex, relevance: 3 }));
    return {
      ...entry,
      split: entry.split || (payload.schemaVersion === 1 ? "smoke" : "development"),
      judgmentMode: payload.schemaVersion === 1 ? "alternatives" : "graded",
      judgments,
      expectedCelexes: entry.expectedCelexes || judgments.map((judgment) => judgment.celex),
      mustOutrank: entry.mustOutrank || [],
    };
  });
}

function expectedRank(results, expectedCelexes) {
  const expected = new Set(expectedCelexes.map((value) => String(value).toUpperCase()));
  const index = results.findIndex((result) => expected.has(String(result?.celex || "").toUpperCase()));
  return index === -1 ? null : index + 1;
}

function dcgAt(results, judgments, limit) {
  const relevance = new Map(judgments.map((judgment) => [String(judgment.celex).toUpperCase(), judgment.relevance]));
  return results.slice(0, limit).reduce((score, result, index) => {
    const grade = relevance.get(String(result?.celex || "").toUpperCase()) || 0;
    return score + ((2 ** grade) - 1) / Math.log2(index + 2);
  }, 0);
}

function ndcgAt(results, judgments, limit) {
  const ideal = [...judgments]
    .sort((left, right) => right.relevance - left.relevance)
    .slice(0, limit)
    .reduce((score, judgment, index) => score + ((2 ** judgment.relevance) - 1) / Math.log2(index + 2), 0);
  return ideal === 0 ? 0 : dcgAt(results, judgments, limit) / ideal;
}

function alternativeNdcgAt(results, expectedCelexes, limit) {
  const rank = expectedRank(results.slice(0, limit), expectedCelexes);
  return rank == null ? 0 : 1 / Math.log2(rank + 1);
}

function pairwiseOutcome(results, pairs) {
  const ranks = new Map(results.map((result, index) => [String(result?.celex || "").toUpperCase(), index + 1]));
  let correct = 0;
  const failures = [];
  for (const [preferred, other] of pairs) {
    const preferredRank = ranks.get(String(preferred).toUpperCase()) ?? Infinity;
    const otherRank = ranks.get(String(other).toUpperCase()) ?? Infinity;
    if (preferredRank < otherRank) correct += 1;
    else failures.push({ preferred, other, preferredRank, otherRank });
  }
  return { correct, total: pairs.length, failures };
}

function summarizeOutcomes(outcomes) {
  const count = outcomes.length;
  const hitsAt = (limit) => outcomes.filter((outcome) => outcome.rank !== null && outcome.rank <= limit).length;
  const reciprocalRank = outcomes.reduce(
    (sum, outcome) => sum + (outcome.rank === null ? 0 : 1 / outcome.rank),
    0
  );
  const pairwiseCorrect = outcomes.reduce((sum, outcome) => sum + outcome.pairwise.correct, 0);
  const pairwisePairs = outcomes.reduce((sum, outcome) => sum + outcome.pairwise.total, 0);
  const diagnosticOutcomes = outcomes.filter((outcome) => outcome.candidateHits != null);
  const candidateRecall = (source) => diagnosticOutcomes.length === 0 ? null
    : diagnosticOutcomes.filter((outcome) => outcome.candidateHits[source]).length / diagnosticOutcomes.length;
  return {
    count,
    recallAt1: count === 0 ? 0 : hitsAt(1) / count,
    recallAt5: count === 0 ? 0 : hitsAt(5) / count,
    mrr: count === 0 ? 0 : reciprocalRank / count,
    ndcgAt5: count === 0 ? 0 : outcomes.reduce((sum, outcome) => sum + outcome.ndcgAt5, 0) / count,
    ndcgAt10: count === 0 ? 0 : outcomes.reduce((sum, outcome) => sum + outcome.ndcgAt10, 0) / count,
    pairwiseAccuracy: pairwisePairs === 0 ? null : pairwiseCorrect / pairwisePairs,
    pairwisePairs,
    candidateRecall: {
      title: candidateRecall("title"),
      eurovoc: candidateRecall("eurovoc"),
      excerpt: candidateRecall("excerpt"),
      union: candidateRecall("union"),
    },
  };
}

function evaluateSearch(searcher, cases, { limit = 5, disableRewrites = true } = {}) {
  const outcomes = cases.map((entry) => {
    const judgmentMode = entry.judgmentMode || (entry.judgments ? "graded" : "alternatives");
    const judgments = entry.judgments || entry.expectedCelexes.map((celex) => ({ celex, relevance: 3 }));
    const expectedCelexes = entry.expectedCelexes || judgments.map((judgment) => judgment.celex);
    const mustOutrank = entry.mustOutrank || [];
    let diagnostics = null;
    const results = searcher.searchLaws(entry.query, {
      limit,
      disableRewrites,
      onDiagnostics: (value) => { diagnostics = value; },
    });
    const expected = new Set(expectedCelexes.map((celex) => String(celex).toUpperCase()));
    const hasExpected = (values) => (values || []).some((celex) => expected.has(String(celex).toUpperCase()));
    const pairwise = pairwiseOutcome(results, mustOutrank);
    return {
      ...entry,
      split: entry.split || "smoke",
      judgmentMode,
      judgments,
      expectedCelexes,
      mustOutrank,
      rank: expectedRank(results, expectedCelexes),
      resultCelexes: results.map((result) => result.celex),
      ndcgAt5: judgmentMode === "alternatives"
        ? alternativeNdcgAt(results, expectedCelexes, 5)
        : ndcgAt(results, judgments, 5),
      ndcgAt10: judgmentMode === "alternatives"
        ? alternativeNdcgAt(results, expectedCelexes, 10)
        : ndcgAt(results, judgments, 10),
      pairwise,
      candidateHits: diagnostics ? {
        title: hasExpected(diagnostics.sources.title),
        eurovoc: hasExpected(diagnostics.sources.eurovoc),
        excerpt: hasExpected(diagnostics.sources.excerpt),
        union: hasExpected(diagnostics.union),
      } : null,
    };
  });

  const byCategory = {};
  for (const category of [...new Set(cases.map((entry) => entry.category))].sort()) {
    byCategory[category] = summarizeOutcomes(outcomes.filter((outcome) => outcome.category === category));
  }
  const bySplit = {};
  for (const split of [...new Set(cases.map((entry) => entry.split))].sort()) {
    bySplit[split] = summarizeOutcomes(outcomes.filter((outcome) => outcome.split === split));
  }

  return {
    ...summarizeOutcomes(outcomes),
    byCategory,
    bySplit,
    failures: outcomes.filter((outcome) => outcome.rank === null || outcome.rank > 1 || outcome.pairwise.failures.length > 0),
    outcomes,
  };
}

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return 0;
  return sortedValues[Math.max(0, Math.ceil(sortedValues.length * fraction) - 1)];
}

function benchmarkLatency(searcher, cases, {
  iterations = 5,
  limit = 5,
  disableRewrites = true,
} = {}) {
  for (const entry of cases) {
    searcher.searchLaws(entry.query, { limit, disableRewrites });
  }

  const durations = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (const entry of cases) {
      const started = performance.now();
      searcher.searchLaws(entry.query, { limit, disableRewrites });
      durations.push(performance.now() - started);
    }
  }
  durations.sort((left, right) => left - right);
  return {
    samples: durations.length,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: durations.at(-1) || 0,
  };
}

function memorySnapshot() {
  if (typeof global.gc === "function") global.gc();
  const usage = process.memoryUsage();
  return {
    rssMb: usage.rss / 1024 / 1024,
    heapUsedMb: usage.heapUsed / 1024 / 1024,
  };
}

function parseArgs(argv) {
  const options = {
    label: "current",
    cachePath: DEFAULT_CACHE_PATH,
    casesPath: DEFAULT_CASES_PATH,
    sqlitePath: null,
    split: "all",
    iterations: 5,
    limit: 5,
    json: false,
    disableRewrites: true,
    rankingProfile: "revised",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") options.json = true;
    else if (token === "--enable-rewrites") options.disableRewrites = false;
    else if (token === "--baseline-ranking") options.rankingProfile = "baseline";
    else if (["--label", "--cache", "--cases", "--sqlite", "--split", "--iterations", "--limit"].includes(token)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${token}`);
      if (token === "--label") options.label = value;
      else if (token === "--cache") options.cachePath = path.resolve(value);
      else if (token === "--cases") options.casesPath = path.resolve(value);
      else if (token === "--sqlite") options.sqlitePath = path.resolve(value);
      else if (token === "--split") options.split = value;
      else if (token === "--iterations") options.iterations = Number.parseInt(value, 10);
      else options.limit = Number.parseInt(value, 10);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  if (!Number.isInteger(options.iterations) || options.iterations < 1) throw new Error("--iterations must be positive");
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 50) throw new Error("--limit must be 1-50");
  if (!["all", "development", "holdout", "smoke"].includes(options.split)) throw new Error("--split must be all, development, holdout, or smoke");
  return options;
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function optionalPercent(value) {
  return value == null ? "n/a" : percent(value);
}

function rounded(value) {
  return Number(value.toFixed(2));
}

function formatHuman(report) {
  const signalPercent = (count) => report.signals.records === 0 ? "0.0%" : percent(count / report.signals.records);
  const lines = [
    `Search evaluation (${report.label}): ${report.cases} cases against ${report.cachePath}`,
    `Quality: recall@1 ${percent(report.quality.recallAt1)}, recall@5 ${percent(report.quality.recallAt5)}, MRR ${report.quality.mrr.toFixed(3)}, nDCG@5 ${report.quality.ndcgAt5.toFixed(3)}, nDCG@10 ${report.quality.ndcgAt10.toFixed(3)}`,
    `Candidate recall: union ${optionalPercent(report.quality.candidateRecall.union)}, title ${optionalPercent(report.quality.candidateRecall.title)}, EuroVoc ${optionalPercent(report.quality.candidateRecall.eurovoc)}, excerpt ${optionalPercent(report.quality.candidateRecall.excerpt)}`,
    `Latency: p50 ${report.latency.p50Ms.toFixed(2)} ms, p95 ${report.latency.p95Ms.toFixed(2)} ms, max ${report.latency.maxMs.toFixed(2)} ms (${report.latency.samples} samples)`,
    `Load: ${report.loadMs.toFixed(2)} ms; memory after load: ${report.memory.rssMb.toFixed(1)} MB RSS, ${report.memory.heapUsedMb.toFixed(1)} MB heap`,
    `Signals: EuroVoc ${signalPercent(report.signals.eurovocRecords)}, status ${signalPercent(report.signals.knownStatusRecords)}, excerpts ${signalPercent(report.signals.excerptRecords)}, cited ${signalPercent(report.signals.citedRecords)}`,
    "Categories:",
  ];
  for (const [category, metrics] of Object.entries(report.quality.byCategory)) {
    const pairwise = metrics.pairwiseAccuracy == null ? "" : `, pairwise ${percent(metrics.pairwiseAccuracy)} (${metrics.pairwisePairs})`;
    lines.push(`  ${category}: ${metrics.count} cases, recall@1 ${percent(metrics.recallAt1)}, MRR ${metrics.mrr.toFixed(3)}, nDCG@5 ${metrics.ndcgAt5.toFixed(3)}${pairwise}`);
  }
  if (report.quality.failures.length > 0) {
    lines.push("Non-top-1 cases:");
    for (const failure of report.quality.failures) {
      lines.push(`  ${failure.id}: expected ${failure.expectedCelexes.join("/")}, rank ${failure.rank ?? "miss"}, got ${failure.resultCelexes.join(", ") || "no results"}`);
    }
  }
  if (!report.memory.gcAvailable) lines.push("Note: run with node --expose-gc for less noisy memory measurements.");
  return lines.join("\n");
}

function run(options) {
  const loadedCases = loadEvaluationCases(options.casesPath);
  const cases = options.split === "all" ? loadedCases : loadedCases.filter((entry) => entry.split === options.split);
  if (cases.length === 0) throw new Error(`No ${options.split} cases in ${options.casesPath}`);
  const beforeMemory = memorySnapshot();
  const searcher = new SearchIndex(options.cachePath, options.sqlitePath
    ? { sqlitePath: options.sqlitePath, requireSqlite: true, rankingProfile: options.rankingProfile }
    : { rankingProfile: options.rankingProfile });
  const loadStarted = performance.now();
  if (!searcher.loadFromDisk()) throw new Error(searcher.loadError || "Search cache failed to load");
  const loadMs = performance.now() - loadStarted;
  const afterMemory = memorySnapshot();
  const quality = evaluateSearch(searcher, cases, options);
  const latency = benchmarkLatency(searcher, cases, options);
  const report = {
    label: options.label,
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
    cachePath: searcher.activePath || options.sqlitePath || options.cachePath,
    cases: cases.length,
    split: options.split,
    rewritesEnabled: !options.disableRewrites,
    rankingProfile: options.rankingProfile,
    loadMs,
    memory: {
      ...afterMemory,
      rssDeltaMb: afterMemory.rssMb - beforeMemory.rssMb,
      heapDeltaMb: afterMemory.heapUsedMb - beforeMemory.heapUsedMb,
      gcAvailable: typeof global.gc === "function",
    },
    latency,
    signals: searcher.getRankingSignalStats(),
    quality,
  };
  if (typeof searcher.close === "function") searcher.close();
  return report;
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = run(options);
    if (options.json) {
      console.log(JSON.stringify(report, (_key, value) => typeof value === "number" ? rounded(value) : value, 2));
    } else {
      console.log(formatHuman(report));
    }
  } catch (error) {
    console.error(`Search evaluation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_CACHE_PATH,
  DEFAULT_CASES_PATH,
  alternativeNdcgAt,
  benchmarkLatency,
  dcgAt,
  evaluateSearch,
  expectedRank,
  formatHuman,
  loadEvaluationCases,
  ndcgAt,
  pairwiseOutcome,
  parseArgs,
  percentile,
  run,
  summarizeOutcomes,
};
