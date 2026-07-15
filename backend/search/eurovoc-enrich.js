"use strict";

// EuroVoc subject-label enrichment: fetches cdm:work_is_about_concept_eurovoc
// for records that don't already carry topics and writes them onto the records
// as `eurovoc`, which is where the server reads them from (legal-cache-store.js,
// topics-route.js).
//
// This runs as the last step of *both* cache builders (search-build.js and
// build-cache-from-corpus.js) rather than as a standalone pass, so a freshly
// built cache is always complete. That coupling is the point: topics are keyed
// by CELEX, so a sidecar generated against one cache and served alongside
// another silently strands every record it never saw — which is exactly how the
// data-v5 corpus expansion (13k -> 80k acts) left ~83% of records topic-less.
// Nothing errors when that happens; the topics just quietly go empty.
//
// data/eurovoc.json is a resume journal only — gitignored, never read at
// runtime. It exists so an interrupted harvest (~800 batches over Cellar)
// doesn't restart from zero, and so a rebuild re-uses labels already fetched
// for unchanged acts.
//
// Enrichment is CELEX-keyed off the finished record set, not tied to the SPARQL
// year harvest, so it covers acts that only ever come from the offline corpus
// rebuild (everything pre-2010) as well as freshly harvested ones.

const fs = require("fs");
const path = require("path");

const SPARQL_ENDPOINT = "https://publications.europa.eu/webapi/rdf/sparql";
const USER_AGENT = "LegalViz API EuroVoc fetcher/0.1";
const DEFAULT_JOURNAL_PATH = path.join(__dirname, "data", "eurovoc.json");
const BATCH_SIZE = 100;
const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt) {
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
}

function readJournal(journalPath) {
  try {
    if (!fs.existsSync(journalPath)) return {};
    const parsed = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // A corrupt journal is only a lost optimisation — re-fetching is correct,
    // just slower. Never fail a multi-hour build over it.
    return {};
  }
}

function writeJournal(journalPath, data) {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  const tempPath = `${journalPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 1));
  fs.renameSync(tempPath, journalPath);
}

function buildQuery(celexBatch) {
  // Cellar stores resource_legal_id_celex as an explicitly-typed xsd:string
  // literal. VALUES with a bare "..." (implicit xsd:string) still fails to
  // join for some reason on this endpoint, and FILTER(STR(?celex) = ...)
  // works but forces an unindexed scan (times out past a handful of
  // values). Explicitly typing the VALUES literals as ^^xsd:string gets a
  // real term-equality join and stays fast at 100-item batches.
  const values = celexBatch.map((c) => `"${c}"^^xsd:string`).join(" ");
  return `
PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?celex (GROUP_CONCAT(DISTINCT ?label; separator="|") AS ?labels)
WHERE {
  VALUES ?celex { ${values} }
  ?work cdm:resource_legal_id_celex ?celex .
  ?work cdm:work_is_about_concept_eurovoc ?concept .
  ?concept skos:prefLabel ?label .
  FILTER(LANG(?label) = "en")
}
GROUP BY ?celex
`.trim();
}

async function runQuery(query, log, attempt = 1) {
  const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&format=application%2Fsparql-results%2Bjson`;

  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/sparql-results+json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (attempt >= MAX_ATTEMPTS) throw new Error(`Request failed after ${attempt} attempts: ${error.message}`);
    const delay = backoffDelay(attempt);
    log(`${error.name === "TimeoutError" ? "timeout" : error.message}, retrying in ${delay}ms (attempt ${attempt})`);
    await sleep(delay);
    return runQuery(query, log, attempt + 1);
  }

  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) {
      if (attempt >= MAX_ATTEMPTS) throw new Error(`HTTP ${response.status} after ${attempt} attempts`);
      const delay = backoffDelay(attempt);
      log(`HTTP ${response.status}, retrying in ${delay}ms (attempt ${attempt})`);
      await sleep(delay);
      return runQuery(query, log, attempt + 1);
    }
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  return response.json();
}

function parseLabels(value) {
  if (!value) return [];
  return [...new Set(value.split("|").map((s) => s.trim()).filter(Boolean))];
}

// Mutates `records` in place, setting `eurovoc` on every record that doesn't
// already have it. Records whose topics are already known (from the journal, or
// carried over from a previous cache) cost nothing.
//
// Callers are builders, so failure policy is deliberate: the journal is flushed
// on the way out even when a batch throws, and the caller decides whether a
// SPARQL outage should fail the whole build or just ship without topics.
async function enrichRecordsWithEurovoc(records, options = {}) {
  const {
    journalPath = DEFAULT_JOURNAL_PATH,
    saveEvery = 5,
    limit = 0,
    log = () => {},
    // Seam for tests: the SPARQL round-trip is the one part that can't be
    // exercised offline, and the builders' failure handling is only meaningful
    // if a failure can be provoked deterministically.
    runQueryFn = runQuery,
  } = options;

  const journal = readJournal(journalPath);
  const stats = { targeted: 0, fromJournal: 0, fetched: 0, withLabels: 0, alreadyPresent: 0 };

  const needsTopics = [];
  for (const record of records) {
    if (Array.isArray(record.eurovoc)) {
      stats.alreadyPresent += 1;
      continue;
    }
    if (!record.celex) continue;
    stats.targeted += 1;

    const journaled = journal[record.celex];
    if (Array.isArray(journaled)) {
      record.eurovoc = journaled;
      stats.fromJournal += 1;
      if (journaled.length > 0) stats.withLabels += 1;
      continue;
    }
    needsTopics.push(record);
  }

  const targets = limit > 0 ? needsTopics.slice(0, limit) : needsTopics;
  log(`${stats.targeted} records need topics — ${stats.fromJournal} from journal, ${targets.length} to fetch`);
  if (targets.length === 0) {
    return stats;
  }

  const byCelex = new Map(targets.map((record) => [record.celex, record]));
  let batches = 0;

  try {
    for (let offset = 0; offset < targets.length; offset += BATCH_SIZE) {
      const batch = targets.slice(offset, offset + BATCH_SIZE).map((record) => record.celex);
      const data = await runQueryFn(buildQuery(batch), log);

      const found = new Set();
      for (const binding of data?.results?.bindings || []) {
        const celex = binding.celex?.value;
        if (!celex) continue;
        found.add(celex);
        const labels = parseLabels(binding.labels?.value);
        journal[celex] = labels;
        const record = byCelex.get(celex);
        if (record) record.eurovoc = labels;
        if (labels.length > 0) stats.withLabels += 1;
      }

      // An act with no EuroVoc concepts is journaled as [] so a rerun skips it
      // rather than re-asking Cellar for an answer it already gave.
      for (const celex of batch) {
        if (found.has(celex)) continue;
        journal[celex] = [];
        const record = byCelex.get(celex);
        if (record) record.eurovoc = [];
      }

      stats.fetched += batch.length;
      batches += 1;
      log(`batch ${batches} (${batch.length} records, ${found.size} with labels) — ${Math.min(offset + batch.length, targets.length)}/${targets.length}`);

      if (batches % saveEvery === 0) writeJournal(journalPath, journal);
    }
  } finally {
    // Persist whatever the run gathered even if a batch threw, so the next
    // attempt resumes from here rather than from zero.
    writeJournal(journalPath, journal);
  }

  return stats;
}

module.exports = {
  DEFAULT_JOURNAL_PATH,
  buildQuery,
  enrichRecordsWithEurovoc,
  parseLabels,
  readJournal,
};
