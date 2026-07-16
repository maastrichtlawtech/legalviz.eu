"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { performance } = require("node:perf_hooks");

const Database = require("better-sqlite3");

const { SearchIndex } = require("../search-index");
const { documentPrior } = require("../legal-cache-store");
const { parseStructuredQuery } = require("../search-ranking");
const { compareOutcomes } = require("./compare-ranking");
const { objective, stratifiedFolds } = require("./optimize-ranking");
const {
  expectedRank,
  loadEvaluationCases,
  ndcgAt,
  pairwiseOutcome,
  percentile,
  summarizeOutcomes,
} = require("./run");

const CASES_PATH = path.join(__dirname, "ranking-queries.json");
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DIMENSIONS = 512;
const SOURCE_NAMES = ["title", "eurovoc", "excerpt"];

function parseArgs(argv) {
  const options = {
    sqlitePath: null,
    searchPath: null,
    cacheDir: "/tmp/legalviz-embedding-experiment",
    model: null,
    split: "development",
    batchSize: 64,
    concurrency: 4,
    limitCases: null,
    semanticWeight: null,
    semanticK: null,
    benchmarkQueries: 10,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (!["--sqlite", "--search", "--cache-dir", "--model", "--split", "--batch-size", "--concurrency", "--limit-cases", "--semantic-weight", "--semantic-k", "--benchmark-queries"].includes(token) || !value) {
      throw new Error(`Unknown or incomplete argument: ${token}`);
    }
    if (token === "--sqlite") options.sqlitePath = path.resolve(value);
    else if (token === "--search") options.searchPath = path.resolve(value);
    else if (token === "--cache-dir") options.cacheDir = path.resolve(value);
    else if (token === "--model") options.model = value;
    else if (token === "--split") options.split = value;
    else if (token === "--batch-size") options.batchSize = Number.parseInt(value, 10);
    else if (token === "--concurrency") options.concurrency = Number.parseInt(value, 10);
    else if (token === "--limit-cases") options.limitCases = Number.parseInt(value, 10);
    else if (token === "--semantic-weight") options.semanticWeight = Number.parseFloat(value);
    else if (token === "--semantic-k") options.semanticK = Number.parseFloat(value);
    else options.benchmarkQueries = Number.parseInt(value, 10);
    index += 1;
  }
  if (!options.sqlitePath || !options.searchPath || !options.model) {
    throw new Error("--sqlite, --search, and --model are required");
  }
  if (!['development', 'holdout'].includes(options.split)) throw new Error("--split must be development or holdout");
  if (options.split === "holdout" && (options.semanticWeight == null || options.semanticK == null)) {
    throw new Error("holdout requires fixed --semantic-weight and --semantic-k selected on development");
  }
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 256) throw new Error("--batch-size must be 1-256");
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) throw new Error("--concurrency must be 1-8");
  return options;
}

function normalizeVector(values) {
  let squared = 0;
  for (const value of values) squared += value * value;
  const magnitude = Math.sqrt(squared) || 1;
  const normalized = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 1) normalized[index] = values[index] / magnitude;
  return normalized;
}

function dot(left, right) {
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index] * right[index];
  return score;
}

function textHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function modelSlug(model) {
  return model.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

function openCache(cacheDir, model) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const cachePath = path.join(cacheDir, `${modelSlug(model)}-${DIMENSIONS}.sqlite`);
  const database = new Database(cachePath);
  database.pragma("journal_mode = WAL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS embeddings (
      key TEXT PRIMARY KEY,
      text_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector BLOB NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  return { database, cachePath };
}

function vectorFromBlob(blob) {
  const buffer = new ArrayBuffer(blob.byteLength);
  new Uint8Array(buffer).set(blob);
  return new Float32Array(buffer);
}

async function fetchEmbeddingBatch({ model, inputs, inputType, apiKey, baseUrl, retries = 4 }) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    const started = performance.now();
    try {
      const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/embeddings`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://legalviz.local",
          "X-Title": "EUR-Lex Visualiser",
        },
        body: JSON.stringify({
          model,
          dimensions: DIMENSIONS,
          input: inputs,
          input_type: inputType,
          provider: { allow_fallbacks: true, data_collection: "deny" },
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        const message = payload?.error?.message || payload?.message || response.statusText;
        const retryable = [429, 502, 503, 529].includes(response.status);
        if (!retryable || attempt === retries) throw new Error(`${response.status}: ${message}`);
        lastError = new Error(`${response.status}: ${message}`);
      } else {
        const vectors = (payload.data || [])
          .sort((left, right) => left.index - right.index)
          .map((entry) => normalizeVector(entry.embedding));
        if (vectors.length !== inputs.length || vectors.some((vector) => vector.length !== DIMENSIONS)) {
          lastError = new Error(`Unexpected embedding response shape: ${vectors.length}x${vectors[0]?.length || 0}`);
          if (attempt === retries) throw lastError;
        } else {
          return {
            vectors,
            latencyMs: performance.now() - started,
            usage: payload.usage || null,
            returnedModel: payload.model || model,
          };
        }
      }
    } catch (error) {
      lastError = error;
      if (attempt === retries || (!String(error.message).includes("429") && !String(error.message).includes("502")
        && !String(error.message).includes("503") && !String(error.message).includes("529")
        && error.name !== "AbortError")) throw error;
    } finally {
      clearTimeout(timeout);
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** (attempt - 1))));
  }
  throw lastError;
}

async function mapConcurrent(items, concurrency, worker) {
  let next = 0;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

async function ensureEmbeddings({ database, entries, model, inputType, apiKey, baseUrl, batchSize, concurrency, onProgress }) {
  const select = database.prepare("SELECT vector FROM embeddings WHERE key = ? AND text_hash = ? AND model = ? AND dimensions = ?");
  const missing = entries.filter((entry) => !select.get(entry.key, textHash(entry.text), model, DIMENSIONS));
  const batches = [];
  for (let index = 0; index < missing.length; index += batchSize) batches.push(missing.slice(index, index + batchSize));
  const insert = database.prepare(`
    INSERT INTO embeddings (key, text_hash, model, dimensions, vector, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      text_hash=excluded.text_hash, model=excluded.model, dimensions=excluded.dimensions,
      vector=excluded.vector, created_at=excluded.created_at
  `);
  const insertBatch = database.transaction((batch, vectors) => {
    batch.forEach((entry, index) => {
      const vector = vectors[index];
      insert.run(
        entry.key,
        textHash(entry.text),
        model,
        DIMENSIONS,
        Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
        new Date().toISOString()
      );
    });
  });
  let completed = 0;
  const apiResults = await mapConcurrent(batches, concurrency, async (batch) => {
    const result = await fetchEmbeddingBatch({
      model,
      inputs: batch.map((entry) => entry.text),
      inputType,
      apiKey,
      baseUrl,
    });
    insertBatch(batch, result.vectors);
    completed += batch.length;
    if (onProgress) onProgress({ completed, missing: missing.length, batches: batches.length });
    return result;
  });

  const vectors = new Map();
  for (const entry of entries) {
    const row = select.get(entry.key, textHash(entry.text), model, DIMENSIONS);
    if (!row) throw new Error(`Embedding cache miss after generation: ${entry.key}`);
    vectors.set(entry.key, vectorFromBlob(row.vector));
  }
  return {
    vectors,
    generated: missing.length,
    cached: entries.length - missing.length,
    promptTokens: apiResults.reduce((sum, result) => sum + (result.usage?.prompt_tokens || 0), 0),
    cost: apiResults.reduce((sum, result) => sum + (result.usage?.cost || 0), 0),
    batchLatenciesMs: apiResults.map((result) => result.latencyMs),
  };
}

function loadCandidateQueries(searcher, cases) {
  return cases.map((entry) => {
    let diagnostics = null;
    const live = searcher.searchLaws(entry.query, {
      limit: 10,
      disableRewrites: true,
      onDiagnostics: (value) => { diagnostics = value; },
    });
    if (!diagnostics) throw new Error(`Missing diagnostics for ${entry.id}`);
    return {
      entry,
      parsed: parseStructuredQuery(entry.query, { disableRewrites: true }),
      deterministic: diagnostics.deterministic || [],
      live: live.map((result) => result.celex),
      candidates: diagnostics.ranked.map((candidate) => ({
        celex: candidate.celex,
        ordinal: candidate.ordinal,
        record: searcher.getByCelex(candidate.celex),
        sources: candidate.sources,
      })),
    };
  });
}

function loadDocumentTexts(searchPath, celexes) {
  const raw = fs.readFileSync(searchPath);
  const payload = JSON.parse((searchPath.endsWith(".gz") ? zlib.gunzipSync(raw) : raw).toString("utf8"));
  const wanted = new Set(celexes);
  const entries = [];
  for (const record of payload.records || []) {
    const celex = String(record.celex || "").toUpperCase();
    if (!wanted.has(celex)) continue;
    const topics = (record.eurovoc || []).join("; ");
    const text = [record.title || "", topics ? `EuroVoc: ${topics}` : "", record.excerpt || ""]
      .filter(Boolean)
      .join("\n");
    entries.push({ key: `doc:${celex}`, celex, text });
  }
  const found = new Set(entries.map((entry) => entry.celex));
  const missing = [...wanted].filter((celex) => !found.has(celex));
  if (missing.length > 0) throw new Error(`${missing.length} candidate documents missing from search cache`);
  return entries.sort((left, right) => left.celex.localeCompare(right.celex));
}

function rankSemanticCandidates(query, queryVector, documentVectors) {
  return query.candidates
    .map((candidate) => ({
      celex: candidate.celex,
      score: dot(queryVector, documentVectors.get(`doc:${candidate.celex}`)),
      ordinal: candidate.ordinal,
    }))
    .sort((left, right) => right.score - left.score || left.ordinal - right.ordinal)
    .map((candidate, index) => [candidate.celex, index + 1]);
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

function rerank(searcher, query, semanticRanks, { semanticWeight, semanticK }) {
  const ranked = query.candidates.map((candidate) => {
    let fusionScore = 0;
    for (const source of SOURCE_NAMES) {
      const match = candidate.sources[source];
      if (!match) continue;
      fusionScore += searcher.rankingConfig.sourceWeights[source]
        * (match.coverage ** searcher.rankingConfig.coverageExponent)
        / (searcher.rankingConfig.rrfK + match.rank);
    }
    const semanticRank = semanticRanks.get(candidate.celex);
    if (semanticRank != null && semanticWeight > 0) {
      fusionScore += semanticWeight / (semanticK + semanticRank);
    }
    return {
      ...candidate,
      finalScore: fusionScore * documentPrior(
        query.parsed,
        candidate.record,
        searcher.citationCounts,
        searcher.rankingConfig
      ),
    };
  }).sort((left, right) => right.finalScore - left.finalScore || left.ordinal - right.ordinal);
  const seen = new Set();
  const results = [];
  for (const celex of [...query.deterministic, ...ranked.map((candidate) => candidate.celex)]) {
    if (!celex || seen.has(celex)) continue;
    seen.add(celex);
    results.push({ celex });
    if (results.length === 10) break;
  }
  return results;
}

function evaluateSemantic(searcher, queries, semanticRanksById, configuration) {
  return queries.map((query) => outcomeFor(
    query.entry,
    rerank(searcher, query, semanticRanksById.get(query.entry.id), configuration)
  ));
}

function summarizeSubset(outcomes, indices) {
  return summarizeOutcomes(indices.map((index) => outcomes[index]));
}

function tuneSemantic(searcher, queries, semanticRanksById) {
  const configurations = [{ semanticWeight: 0, semanticK: 20 }];
  for (const semanticK of [5, 10, 20, 40, 80]) {
    for (let step = 1; step <= 100; step += 1) {
      configurations.push({ semanticWeight: step / 10, semanticK });
    }
  }
  const folds = Array.from({ length: 5 }, (_value, repeat) =>
    stratifiedFolds(queries.map((query) => query.entry), 5, 0x0e6bed00 + repeat)).flat();
  const allIndices = queries.map((_query, index) => index);
  const evaluated = configurations.map((configuration) => {
    const outcomes = evaluateSemantic(searcher, queries, semanticRanksById, configuration);
    const metrics = summarizeOutcomes(outcomes);
    return { configuration, outcomes, metrics, score: objective(metrics) };
  });
  const selections = folds.map((validation) => {
    const heldOut = new Set(validation);
    const training = allIndices.filter((index) => !heldOut.has(index));
    const winner = [...evaluated].sort((left, right) =>
      objective(summarizeSubset(right.outcomes, training)) - objective(summarizeSubset(left.outcomes, training))
      || left.configuration.semanticWeight - right.configuration.semanticWeight)[0];
    return {
      configuration: winner.configuration,
      validationOutcomes: validation.map((index) => winner.outcomes[index]),
    };
  });
  const ranked = [...evaluated].sort((left, right) => right.score - left.score
    || left.configuration.semanticWeight - right.configuration.semanticWeight);
  const baseline = evaluated[0];
  const best = ranked[0];
  const nestedMetrics = summarizeOutcomes(selections.flatMap((selection) => selection.validationOutcomes));
  return {
    baseline: { configuration: baseline.configuration, metrics: baseline.metrics, score: baseline.score },
    best: { configuration: best.configuration, metrics: best.metrics, score: best.score },
    bestVsBaseline: compareOutcomes(baseline.outcomes, best.outcomes),
    nestedMetrics,
    nestedScore: objective(nestedMetrics),
    selectionCounts: Object.entries(selections.reduce((counts, selection) => {
      const key = `${selection.configuration.semanticWeight}@${selection.configuration.semanticK}`;
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {})).sort((left, right) => right[1] - left[1]),
  };
}

async function benchmarkQueries({ model, queryTexts, apiKey, baseUrl, count }) {
  const durations = [];
  for (const text of queryTexts.slice(0, count)) {
    const result = await fetchEmbeddingBatch({
      model,
      inputs: [text],
      inputType: "search_query",
      apiKey,
      baseUrl,
    });
    durations.push(result.latencyMs);
  }
  durations.sort((left, right) => left - right);
  return {
    count: durations.length,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: durations.at(-1) || 0,
  };
}

async function main(options) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");
  const baseUrl = process.env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL;
  let cases = loadEvaluationCases(CASES_PATH).filter((entry) => entry.split === options.split);
  if (options.limitCases != null) cases = cases.slice(0, options.limitCases);
  const searcher = new SearchIndex(undefined, { sqlitePath: options.sqlitePath, requireSqlite: true });
  if (!searcher.loadFromDisk()) throw new Error(searcher.loadError || "Search cache failed to load");
  const queries = loadCandidateQueries(searcher, cases);
  const candidateCelexes = [...new Set(queries.flatMap((query) => query.candidates.map((candidate) => candidate.celex)))];
  const documentEntries = loadDocumentTexts(options.searchPath, candidateCelexes);
  const queryEntries = queries.map((query) => ({
    key: `query:${options.split}:${query.entry.id}`,
    text: query.entry.query,
  }));
  const { database, cachePath } = openCache(options.cacheDir, options.model);
  let lastProgress = 0;
  const documents = await ensureEmbeddings({
    database,
    entries: documentEntries,
    model: options.model,
    inputType: "search_document",
    apiKey,
    baseUrl,
    batchSize: options.batchSize,
    concurrency: options.concurrency,
    onProgress: ({ completed, missing }) => {
      if (completed - lastProgress >= 500 || completed === missing) {
        console.error(`[embeddings] documents ${completed}/${missing}`);
        lastProgress = completed;
      }
    },
  });
  const embeddedQueries = await ensureEmbeddings({
    database,
    entries: queryEntries,
    model: options.model,
    inputType: "search_query",
    apiKey,
    baseUrl,
    batchSize: options.batchSize,
    concurrency: options.concurrency,
  });
  const semanticScoringDurations = [];
  const semanticRanksById = new Map(queries.map((query) => {
    const started = performance.now();
    const ranks = new Map(rankSemanticCandidates(
      query,
      embeddedQueries.vectors.get(`query:${options.split}:${query.entry.id}`),
      documents.vectors
    ));
    semanticScoringDurations.push(performance.now() - started);
    return [query.entry.id, ranks];
  }));

  const zeroOutcomes = evaluateSemantic(searcher, queries, semanticRanksById, { semanticWeight: 0, semanticK: 20 });
  const zeroResults = zeroOutcomes.map((_outcome, index) =>
    rerank(searcher, queries[index], semanticRanksById.get(queries[index].entry.id), { semanticWeight: 0, semanticK: 20 })
      .map((result) => result.celex));
  const parityFailures = queries.filter((query, index) => query.live.join("|") !== zeroResults[index].join("|")).map((query) => query.entry.id);
  if (parityFailures.length > 0) throw new Error(`Zero-weight parity failed: ${parityFailures.join(", ")}`);

  let evaluation;
  if (options.split === "development" && options.semanticWeight == null) {
    evaluation = tuneSemantic(searcher, queries, semanticRanksById);
  } else {
    const configuration = { semanticWeight: options.semanticWeight || 0, semanticK: options.semanticK || 20 };
    const outcomes = evaluateSemantic(searcher, queries, semanticRanksById, configuration);
    evaluation = {
      configuration,
      metrics: summarizeOutcomes(outcomes),
      comparison: compareOutcomes(zeroOutcomes, outcomes),
    };
  }

  const latency = await benchmarkQueries({
    model: options.model,
    queryTexts: queryEntries.map((entry) => entry.text),
    apiKey,
    baseUrl,
    count: options.benchmarkQueries,
  });
  database.pragma("wal_checkpoint(TRUNCATE)");
  const cacheBytes = fs.statSync(cachePath).size;
  database.close();
  searcher.close();
  return {
    model: options.model,
    dimensions: DIMENSIONS,
    split: options.split,
    cases: cases.length,
    candidates: candidateCelexes.length,
    cachePath,
    cacheBytes,
    generated: { documents: documents.generated, queries: embeddedQueries.generated },
    usage: {
      promptTokens: documents.promptTokens + embeddedQueries.promptTokens,
      cost: documents.cost + embeddedQueries.cost,
    },
    batchLatency: {
      count: documents.batchLatenciesMs.length,
      p50Ms: percentile([...documents.batchLatenciesMs].sort((a, b) => a - b), 0.5),
      p95Ms: percentile([...documents.batchLatenciesMs].sort((a, b) => a - b), 0.95),
    },
    queryLatency: latency,
    semanticScoringLatency: {
      p50Ms: percentile([...semanticScoringDurations].sort((a, b) => a - b), 0.5),
      p95Ms: percentile([...semanticScoringDurations].sort((a, b) => a - b), 0.95),
      maxMs: Math.max(...semanticScoringDurations, 0),
    },
    evaluation,
  };
}

if (require.main === module) {
  main(parseArgs(process.argv.slice(2)))
    .then((report) => console.log(JSON.stringify(report, (_key, value) => {
      if (typeof value === "number") return Number(value.toFixed(6));
      if (value instanceof Map) return Object.fromEntries(value);
      return value;
    }, 2)))
    .catch((error) => {
      console.error(`Embedding experiment failed: ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = {
  DIMENSIONS,
  dot,
  normalizeVector,
  parseArgs,
  rankSemanticCandidates,
  tuneSemantic,
};
