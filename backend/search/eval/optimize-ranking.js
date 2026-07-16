"use strict";

const path = require("node:path");

const { SearchIndex } = require("../search-index");
const { documentPrior } = require("../legal-cache-store");
const { parseStructuredQuery } = require("../search-ranking");
const { compareOutcomes } = require("./compare-ranking");
const {
  expectedRank,
  loadEvaluationCases,
  ndcgAt,
  pairwiseOutcome,
  summarizeOutcomes,
} = require("./run");

const CASES_PATH = path.join(__dirname, "ranking-queries.json");
const SOURCE_NAMES = ["title", "eurovoc", "excerpt"];
const HALTON_BASES = [2, 3, 5, 7, 11, 13, 17];
const DEFAULT_CONFIG = {
  name: "current",
  rrfK: 20,
  coverageExponent: 2,
  sourceWeights: { title: 1, eurovoc: 1, excerpt: 0.5 / 1.1 },
  inForceBoost: 1.08,
  noLongerInForceBoost: 0.9,
  citationLogScale: 0.025,
};

function objective(metrics) {
  const pairwise = metrics.pairwiseAccuracy ?? 0;
  return (0.45 * metrics.ndcgAt10) + (0.2 * metrics.recallAt1)
    + (0.2 * metrics.recallAt5) + (0.15 * pairwise);
}

function radicalInverse(index, base) {
  let value = 0;
  let fraction = 1 / base;
  let remaining = index;
  while (remaining > 0) {
    value += fraction * (remaining % base);
    remaining = Math.floor(remaining / base);
    fraction /= base;
  }
  return value;
}

function haltonPoint(index, dimensions = HALTON_BASES.length) {
  return HALTON_BASES.slice(0, dimensions).map((base) => radicalInverse(index, base));
}

function interpolate(minimum, maximum, fraction) {
  return minimum + ((maximum - minimum) * fraction);
}

function generateConfigurations(samples) {
  const configurations = [{ ...DEFAULT_CONFIG, sourceWeights: { ...DEFAULT_CONFIG.sourceWeights } }];
  for (let index = 1; index <= samples; index += 1) {
    const [k, coverage, eurovoc, excerpt, current, historical, citation] = haltonPoint(index);
    configurations.push({
      name: `halton-${index}`,
      rrfK: Math.round(Math.exp(interpolate(Math.log(5), Math.log(80), k))),
      coverageExponent: interpolate(1, 3.5, coverage),
      sourceWeights: {
        title: 1,
        eurovoc: interpolate(0.55, 1.65, eurovoc),
        excerpt: interpolate(0.2, 0.9, excerpt),
      },
      inForceBoost: interpolate(1, 1.15, current),
      noLongerInForceBoost: interpolate(0.75, 1, historical),
      citationLogScale: interpolate(0, 0.06, citation),
    });
  }
  return configurations;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = ((1664525 * state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function stratifiedFolds(cases, foldCount, seed = 0x51a7f1ed) {
  const random = seededRandom(seed);
  const groups = new Map();
  cases.forEach((entry, index) => {
    const values = groups.get(entry.category) || [];
    values.push(index);
    groups.set(entry.category, values);
  });
  const folds = Array.from({ length: foldCount }, () => []);
  let offset = 0;
  for (const category of [...groups.keys()].sort()) {
    const values = groups.get(category);
    for (let index = values.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1));
      [values[index], values[other]] = [values[other], values[index]];
    }
    values.forEach((caseIndex, index) => folds[(offset + index) % foldCount].push(caseIndex));
    offset = (offset + values.length) % foldCount;
  }
  return folds.map((fold) => fold.sort((left, right) => left - right));
}

function cacheQueries(searcher, cases) {
  return cases.map((entry) => {
    let diagnostics = null;
    const liveResults = searcher.searchLaws(entry.query, {
      limit: 10,
      disableRewrites: true,
      onDiagnostics: (value) => { diagnostics = value; },
    });
    if (!diagnostics) throw new Error(`No candidate diagnostics for ${entry.id}`);
    return {
      entry,
      parsed: parseStructuredQuery(entry.query, { disableRewrites: true }),
      deterministic: diagnostics.deterministic || [],
      liveResultCelexes: liveResults.map((result) => result.celex),
      candidates: diagnostics.ranked.map((candidate) => ({
        celex: candidate.celex,
        ordinal: candidate.ordinal,
        record: searcher.getByCelex(candidate.celex),
        sources: candidate.sources,
      })),
    };
  });
}

function rerankCached(searcher, cached, configuration, limit = 10) {
  const ranked = cached.candidates.map((candidate) => {
    let fusionScore = 0;
    for (const source of SOURCE_NAMES) {
      const match = candidate.sources[source];
      if (!match) continue;
      fusionScore += configuration.sourceWeights[source]
        * (match.coverage ** configuration.coverageExponent)
        / (configuration.rrfK + match.rank);
    }
    return {
      ...candidate,
      finalScore: fusionScore * documentPrior(
        cached.parsed,
        candidate.record,
        searcher.citationCounts,
        configuration
      ),
    };
  }).sort((left, right) => right.finalScore - left.finalScore || left.ordinal - right.ordinal);

  const seen = new Set();
  const results = [];
  for (const celex of [...cached.deterministic, ...ranked.map((candidate) => candidate.celex)]) {
    if (!celex || seen.has(celex)) continue;
    seen.add(celex);
    results.push({ celex });
    if (results.length >= limit) break;
  }
  return results;
}

function outcomeFor(entry, results) {
  const expectedCelexes = entry.expectedCelexes || entry.judgments.map((judgment) => judgment.celex);
  return {
    id: entry.id,
    category: entry.category,
    rank: expectedRank(results, expectedCelexes),
    ndcgAt5: ndcgAt(results, entry.judgments, 5),
    ndcgAt10: ndcgAt(results, entry.judgments, 10),
    pairwise: pairwiseOutcome(results, entry.mustOutrank || []),
  };
}

function evaluateConfiguration(searcher, cachedQueries, configuration) {
  return cachedQueries.map((cached) => outcomeFor(
    cached.entry,
    rerankCached(searcher, cached, configuration)
  ));
}

function summarizeSubset(outcomes, indices) {
  return summarizeOutcomes(indices.map((index) => outcomes[index]));
}

function standardDeviation(values) {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length);
}

function optimize(searcher, cases, { samples = 512, foldCount = 5, repeatCount = 5 } = {}) {
  const cached = cacheQueries(searcher, cases);
  const defaultOutcomes = evaluateConfiguration(searcher, cached, DEFAULT_CONFIG);
  const mismatches = cached.filter((query, index) => {
    const offline = rerankCached(searcher, query, DEFAULT_CONFIG).map((result) => result.celex);
    return offline.join("|") !== query.liveResultCelexes.join("|") || !defaultOutcomes[index];
  });
  if (mismatches.length > 0) {
    throw new Error(`Offline reranker differs from live search for: ${mismatches.map((query) => query.entry.id).join(", ")}`);
  }

  const configurations = generateConfigurations(samples);
  const foldSets = Array.from({ length: repeatCount }, (_value, repeat) =>
    stratifiedFolds(cases, foldCount, 0x51a7f1ed + repeat));
  const folds = foldSets.flat();
  const allIndices = cases.map((_entry, index) => index);
  const evaluated = configurations.map((configuration) => {
    const outcomes = evaluateConfiguration(searcher, cached, configuration);
    const metrics = summarizeOutcomes(outcomes);
    const foldObjectives = folds.map((fold) => objective(summarizeSubset(outcomes, fold)));
    return {
      configuration,
      outcomes,
      metrics,
      score: objective(metrics),
      foldObjectives,
      foldStdDev: standardDeviation(foldObjectives),
      minimumFold: Math.min(...foldObjectives),
    };
  });

  const foldSelections = folds.map((validation, selectionIndex) => {
    const repeatIndex = Math.floor(selectionIndex / foldCount);
    const foldIndex = selectionIndex % foldCount;
    const validationSet = new Set(validation);
    const training = allIndices.filter((index) => !validationSet.has(index));
    const winner = [...evaluated].sort((left, right) => {
      const leftScore = objective(summarizeSubset(left.outcomes, training));
      const rightScore = objective(summarizeSubset(right.outcomes, training));
      return rightScore - leftScore || left.foldStdDev - right.foldStdDev;
    })[0];
    const trainingMetrics = summarizeSubset(winner.outcomes, training);
    const validationMetrics = summarizeSubset(winner.outcomes, validation);
    return {
      fold: foldIndex + 1,
      repeat: repeatIndex + 1,
      trainingCases: training.length,
      validationCases: validation.length,
      configuration: winner.configuration,
      trainingScore: objective(trainingMetrics),
      validationScore: objective(validationMetrics),
      validationMetrics,
      validationOutcomes: validation.map((index) => winner.outcomes[index]),
    };
  });
  const nestedOutcomes = foldSelections.flatMap((selection) => selection.validationOutcomes);
  const ranked = [...evaluated].sort((left, right) => right.score - left.score
    || left.foldStdDev - right.foldStdDev);
  const current = ranked.find((entry) => entry.configuration.name === "current");
  return {
    samples: configurations.length,
    repeats: repeatCount,
    folds: foldSets.map((repeat) => repeat.map((fold) => fold.map((index) => cases[index].id))),
    default: current,
    best: ranked[0],
    bestVsDefault: compareOutcomes(current.outcomes, ranked[0].outcomes),
    top: ranked.slice(0, 20),
    foldSelections,
    nestedMetrics: summarizeOutcomes(nestedOutcomes),
    nestedScore: objective(summarizeOutcomes(nestedOutcomes)),
  };
}

function compactResult(entry) {
  return {
    name: entry.configuration.name,
    score: entry.score,
    foldStdDev: entry.foldStdDev,
    minimumFold: entry.minimumFold,
    configuration: entry.configuration,
    metrics: {
      recallAt1: entry.metrics.recallAt1,
      recallAt5: entry.metrics.recallAt5,
      ndcgAt10: entry.metrics.ndcgAt10,
      pairwiseAccuracy: entry.metrics.pairwiseAccuracy,
    },
  };
}

function parseArgs(argv) {
  const options = { sqlitePath: null, samples: 512, foldCount: 5, repeatCount: 5, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") options.json = true;
    else if (["--sqlite", "--samples", "--folds", "--repeats"].includes(token)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${token}`);
      if (token === "--sqlite") options.sqlitePath = path.resolve(value);
      else if (token === "--samples") options.samples = Number.parseInt(value, 10);
      else if (token === "--folds") options.foldCount = Number.parseInt(value, 10);
      else options.repeatCount = Number.parseInt(value, 10);
      index += 1;
    } else throw new Error(`Unknown argument: ${token}`);
  }
  if (!options.sqlitePath) throw new Error("--sqlite is required");
  if (!Number.isInteger(options.samples) || options.samples < 16) throw new Error("--samples must be at least 16");
  if (!Number.isInteger(options.foldCount) || options.foldCount < 2 || options.foldCount > 10) {
    throw new Error("--folds must be between 2 and 10");
  }
  if (!Number.isInteger(options.repeatCount) || options.repeatCount < 1 || options.repeatCount > 20) {
    throw new Error("--repeats must be between 1 and 20");
  }
  return options;
}

function rounded(value) {
  return typeof value === "number" ? Number(value.toFixed(4)) : value;
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const cases = loadEvaluationCases(CASES_PATH).filter((entry) => entry.split === "development");
    const searcher = new SearchIndex(undefined, { sqlitePath: options.sqlitePath, requireSqlite: true });
    if (!searcher.loadFromDisk()) throw new Error(searcher.loadError || "Search cache failed to load");
    const report = optimize(searcher, cases, options);
    searcher.close();
    if (options.json) {
      console.log(JSON.stringify({
        samples: report.samples,
        default: compactResult(report.default),
        best: compactResult(report.best),
        bestVsDefault: report.bestVsDefault,
        top: report.top.map(compactResult),
        foldSelections: report.foldSelections.map((selection) => ({
          ...selection,
          validationOutcomes: undefined,
        })),
        nestedMetrics: report.nestedMetrics,
        nestedScore: report.nestedScore,
      }, (_key, value) => rounded(value), 2));
    } else {
      console.log(`Ranking optimisation: ${report.samples} configurations, ${options.repeatCount}x${options.foldCount} stratified folds, development only`);
      console.table(report.top.slice(0, 10).map((entry) => ({
        name: entry.configuration.name,
        score: rounded(entry.score),
        foldSd: rounded(entry.foldStdDev),
        minFold: rounded(entry.minimumFold),
        recall1: rounded(entry.metrics.recallAt1),
        recall5: rounded(entry.metrics.recallAt5),
        ndcg10: rounded(entry.metrics.ndcgAt10),
        pairwise: rounded(entry.metrics.pairwiseAccuracy),
        k: entry.configuration.rrfK,
        coverage: rounded(entry.configuration.coverageExponent),
        eurovoc: rounded(entry.configuration.sourceWeights.eurovoc),
        excerpt: rounded(entry.configuration.sourceWeights.excerpt),
        current: rounded(entry.configuration.inForceBoost),
        historical: rounded(entry.configuration.noLongerInForceBoost),
        citation: rounded(entry.configuration.citationLogScale),
      })));
      console.log("Fold-selected validation:");
      console.table(report.foldSelections.map((selection) => ({
        fold: selection.fold,
        repeat: selection.repeat,
        config: selection.configuration.name,
        training: rounded(selection.trainingScore),
        validation: rounded(selection.validationScore),
        recall1: rounded(selection.validationMetrics.recallAt1),
        ndcg10: rounded(selection.validationMetrics.ndcgAt10),
      })));
      console.log(`Nested-CV objective ${report.nestedScore.toFixed(4)}, recall@1 ${report.nestedMetrics.recallAt1.toFixed(4)}, recall@5 ${report.nestedMetrics.recallAt5.toFixed(4)}, nDCG@10 ${report.nestedMetrics.ndcgAt10.toFixed(4)}, pairwise ${(report.nestedMetrics.pairwiseAccuracy ?? 0).toFixed(4)}`);
      console.log(`Current objective ${report.default.score.toFixed(4)}; best full-development objective ${report.best.score.toFixed(4)}`);
      console.log("Best versus current, paired development bootstrap:");
      console.table(Object.entries(report.bestVsDefault).map(([metric, result]) => ({
        metric,
        delta: rounded(result.mean),
        ci95: `[${result.low.toFixed(4)}, ${result.high.toFixed(4)}]`,
        probabilityPositive: rounded(result.probabilityPositive),
        wins: result.wins,
        losses: result.losses,
      })));
    }
  } catch (error) {
    console.error(`Ranking optimisation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_CONFIG,
  generateConfigurations,
  haltonPoint,
  objective,
  optimize,
  radicalInverse,
  stratifiedFolds,
};
