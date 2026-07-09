// Fetches EuroVoc subject labels for CELEX numbers from the Cellar SPARQL
// endpoint (same endpoint/conventions as search-build.js), writing a
// resumable celex -> [labels] sidecar to data/eurovoc.json.
//
// Usage:
//   node search/fetch-eurovoc.js             # full run over the real cache
//   node search/fetch-eurovoc.js --limit 200  # smoke test on a subset

const fs = require("fs");
const path = require("path");

const { JsonLegalCacheStore } = require("./legal-cache-store");

const SPARQL_ENDPOINT = "https://publications.europa.eu/webapi/rdf/sparql";
const USER_AGENT = "LegalViz API EuroVoc fetcher/0.1";
const OUT_PATH = path.join(__dirname, "data", "eurovoc.json");
const BATCH_SIZE = 100;
const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;

function parseArgs(argv) {
  const options = { limit: 0, saveEvery: 5 };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      i += 1;
    } else {
      options[key] = true;
    }
  }
  options.limit = Number.parseInt(String(options.limit || "0"), 10) || 0;
  options.saveEvery = Math.max(1, Number.parseInt(String(options.saveEvery || "5"), 10) || 5);
  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadExisting() {
  if (!fs.existsSync(OUT_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(OUT_PATH, "utf8"));
  } catch {
    return {};
  }
}

function save(data) {
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(data, null, 1));
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

async function runQuery(query, attempt = 1) {
  const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&format=application%2Fsparql-results%2Bjson`;

  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/sparql-results+json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (attempt > 5) throw new Error(`Request failed after ${attempt} attempts: ${error.message}`);
    const delay = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
    console.log(`[eurovoc] ${error.name === "TimeoutError" ? "timeout" : error.message}, retrying in ${delay}ms (attempt ${attempt})`);
    await sleep(delay);
    return runQuery(query, attempt + 1);
  }

  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) {
      if (attempt > 5) throw new Error(`HTTP ${response.status} after ${attempt} attempts`);
      const delay = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
      console.log(`[eurovoc] HTTP ${response.status}, retrying in ${delay}ms (attempt ${attempt})`);
      await sleep(delay);
      return runQuery(query, attempt + 1);
    }
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  return response.json();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const store = new JsonLegalCacheStore();
  if (!store.load()) {
    throw new Error(`Failed to load search cache: ${store.loadError}`);
  }

  const allCelex = store.records.map((r) => r.celex).filter(Boolean);
  const celexList = options.limit > 0 ? allCelex.slice(0, options.limit) : allCelex;

  const result = loadExisting();
  const remaining = celexList.filter((celex) => !(celex in result));

  console.log(`[eurovoc] ${celexList.length} target records, ${remaining.length} remaining (${Object.keys(result).length} already cached)`);

  let processedBatches = 0;
  for (let i = 0; i < remaining.length; i += BATCH_SIZE) {
    const batch = remaining.slice(i, i + BATCH_SIZE);
    const query = buildQuery(batch);

    let data;
    try {
      data = await runQuery(query);
    } catch (error) {
      console.error(`[eurovoc] batch starting at ${i} failed: ${error.message}`);
      save(result);
      throw error;
    }

    const bindings = data?.results?.bindings || [];
    const found = new Set();
    for (const binding of bindings) {
      const celex = binding.celex?.value;
      const labels = binding.labels?.value;
      if (!celex) continue;
      found.add(celex);
      result[celex] = labels ? [...new Set(labels.split("|").map((s) => s.trim()).filter(Boolean))] : [];
    }
    for (const celex of batch) {
      if (!found.has(celex)) result[celex] = [];
    }

    processedBatches += 1;
    console.log(`[eurovoc] batch ${processedBatches} (${batch.length} records, ${found.size} with labels) — ${i + batch.length}/${remaining.length}`);

    if (processedBatches % options.saveEvery === 0) {
      save(result);
    }
  }

  save(result);
  console.log(`[eurovoc] done. Wrote ${Object.keys(result).length} records to ${OUT_PATH}`);
}

main().catch((error) => {
  console.error("[eurovoc] fatal:", error.message);
  process.exit(1);
});
