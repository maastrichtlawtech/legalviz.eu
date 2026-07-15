"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const { SearchIndex } = require("../search-index");

const DEFAULT_CASES_PATH = path.join(__dirname, "queries.json");
const DEFAULT_CACHE_PATH = path.join(__dirname, "..", "__fixtures__", "search-fixture.json");

function loadEvaluationCases(filePath = DEFAULT_CASES_PATH) {
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (payload.schemaVersion !== 1 || !Array.isArray(payload.cases)) {
    throw new Error(`Unsupported search evaluation dataset at ${filePath}`);
  }

  const ids = new Set();
  for (const entry of payload.cases) {
    if (!entry?.id || ids.has(entry.id)) throw new Error(`Duplicate or missing evaluation id: ${entry?.id}`);
    if (!entry.category || !entry.query || !Array.isArray(entry.expectedCelexes) || entry.expectedCelexes.length === 0) {
      throw new Error(`Invalid search evaluation case: ${entry.id}`);
    }
    ids.add(entry.id);
  }
  return payload.cases;
}

function expectedRank(results, expectedCelexes) {
  const expected = new Set(expectedCelexes.map((value) => String(value).toUpperCase()));
  const index = results.findIndex((result) => expected.has(String(result?.celex || "").toUpperCase()));
  return index === -1 ? null : index + 1;
}

function summarizeOutcomes(outcomes) {
  const count = outcomes.length;
  const hitsAt = (limit) => outcomes.filter((outcome) => outcome.rank !== null && outcome.rank <= limit).length;
  const reciprocalRank = outcomes.reduce(
    (sum, outcome) => sum + (outcome.rank === null ? 0 : 1 / outcome.rank),
    0
  );
  return {
    count,
    recallAt1: count === 0 ? 0 : hitsAt(1) / count,
    recallAt5: count === 0 ? 0 : hitsAt(5) / count,
    mrr: count === 0 ? 0 : reciprocalRank / count,
  };
}

function evaluateSearch(searcher, cases, { limit = 5, disableRewrites = true } = {}) {
  const outcomes = cases.map((entry) => {
    const results = searcher.searchLaws(entry.query, { limit, disableRewrites });
    return {
      ...entry,
      rank: expectedRank(results, entry.expectedCelexes),
      resultCelexes: results.map((result) => result.celex),
    };
  });

  const byCategory = {};
  for (const category of [...new Set(cases.map((entry) => entry.category))].sort()) {
    byCategory[category] = summarizeOutcomes(outcomes.filter((outcome) => outcome.category === category));
  }

  return {
    ...summarizeOutcomes(outcomes),
    byCategory,
    failures: outcomes.filter((outcome) => outcome.rank === null || outcome.rank > 1),
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
    iterations: 5,
    limit: 5,
    json: false,
    disableRewrites: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") options.json = true;
    else if (token === "--enable-rewrites") options.disableRewrites = false;
    else if (["--label", "--cache", "--cases", "--iterations", "--limit"].includes(token)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${token}`);
      if (token === "--label") options.label = value;
      else if (token === "--cache") options.cachePath = path.resolve(value);
      else if (token === "--cases") options.casesPath = path.resolve(value);
      else if (token === "--iterations") options.iterations = Number.parseInt(value, 10);
      else options.limit = Number.parseInt(value, 10);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  if (!Number.isInteger(options.iterations) || options.iterations < 1) throw new Error("--iterations must be positive");
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 50) throw new Error("--limit must be 1-50");
  return options;
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function rounded(value) {
  return Number(value.toFixed(2));
}

function formatHuman(report) {
  const lines = [
    `Search evaluation (${report.label}): ${report.cases} cases against ${report.cachePath}`,
    `Quality: recall@1 ${percent(report.quality.recallAt1)}, recall@5 ${percent(report.quality.recallAt5)}, MRR ${report.quality.mrr.toFixed(3)}`,
    `Latency: p50 ${report.latency.p50Ms.toFixed(2)} ms, p95 ${report.latency.p95Ms.toFixed(2)} ms, max ${report.latency.maxMs.toFixed(2)} ms (${report.latency.samples} samples)`,
    `Load: ${report.loadMs.toFixed(2)} ms; memory after load: ${report.memory.rssMb.toFixed(1)} MB RSS, ${report.memory.heapUsedMb.toFixed(1)} MB heap`,
    "Categories:",
  ];
  for (const [category, metrics] of Object.entries(report.quality.byCategory)) {
    lines.push(`  ${category}: ${metrics.count} cases, recall@1 ${percent(metrics.recallAt1)}, MRR ${metrics.mrr.toFixed(3)}`);
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
  const cases = loadEvaluationCases(options.casesPath);
  const beforeMemory = memorySnapshot();
  const searcher = new SearchIndex(options.cachePath);
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
    cachePath: options.cachePath,
    cases: cases.length,
    rewritesEnabled: !options.disableRewrites,
    loadMs,
    memory: {
      ...afterMemory,
      rssDeltaMb: afterMemory.rssMb - beforeMemory.rssMb,
      heapDeltaMb: afterMemory.heapUsedMb - beforeMemory.heapUsedMb,
      gcAvailable: typeof global.gc === "function",
    },
    latency,
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
  benchmarkLatency,
  evaluateSearch,
  expectedRank,
  formatHuman,
  loadEvaluationCases,
  parseArgs,
  percentile,
  run,
  summarizeOutcomes,
};
