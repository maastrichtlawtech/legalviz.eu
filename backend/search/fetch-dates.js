// Fetches the document date (cdm:work_date_document) for CELEX numbers from
// the Cellar SPARQL endpoint (same endpoint/conventions as fetch-eurovoc.js),
// writing a resumable celex -> "YYYY-MM-DD" sidecar to data/dates.json.
//
// The search-cache release asset only carries a `date` for acts harvested with
// the date-bearing query (2010+). Older acts, folded in by the corpus
// expansion, arrive without one; legal-cache-store.js backfills `record.date`
// from this sidecar at load time. Regenerating the 48 MB search cache just to
// add dates is not worth it — this sidecar is committed and merged instead.
//
// Usage:
//   node search/fetch-dates.js              # full run over date-less records
//   node search/fetch-dates.js --limit 200  # smoke test on a subset
//   node search/fetch-dates.js --all        # target every record, not just date-less

const fs = require("fs");
const path = require("path");

const { JsonLegalCacheStore } = require("./legal-cache-store");

const SPARQL_ENDPOINT = "https://publications.europa.eu/webapi/rdf/sparql";
const USER_AGENT = "LegalViz API date fetcher/0.1";
const OUT_PATH = path.join(__dirname, "data", "dates.json");
const BATCH_SIZE = 100;
const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;

function parseArgs(argv) {
  const options = { limit: 0, saveEvery: 5, all: false };
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
  options.all = Boolean(options.all);
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
  // Explicitly type the VALUES literals as ^^xsd:string so the join stays a
  // fast term-equality match against Cellar's typed celex literals (see the
  // note in fetch-eurovoc.js). A work carries a single work_date_document, but
  // MIN keeps the result deterministic if the endpoint ever returns more.
  const values = celexBatch.map((c) => `"${c}"^^xsd:string`).join(" ");
  return `
PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?celex (MIN(?date) AS ?date)
WHERE {
  VALUES ?celex { ${values} }
  ?work cdm:resource_legal_id_celex ?celex .
  ?work cdm:work_date_document ?date .
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
    console.log(`[dates] ${error.name === "TimeoutError" ? "timeout" : error.message}, retrying in ${delay}ms (attempt ${attempt})`);
    await sleep(delay);
    return runQuery(query, attempt + 1);
  }

  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) {
      if (attempt > 5) throw new Error(`HTTP ${response.status} after ${attempt} attempts`);
      const delay = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
      console.log(`[dates] HTTP ${response.status}, retrying in ${delay}ms (attempt ${attempt})`);
      await sleep(delay);
      return runQuery(query, attempt + 1);
    }
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  return response.json();
}

// Normalize an xsd:date/xsd:dateTime literal to a bare YYYY-MM-DD.
function normalizeDate(value) {
  const match = String(value || "").match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const store = new JsonLegalCacheStore();
  if (!store.load()) {
    throw new Error(`Failed to load search cache: ${store.loadError}`);
  }

  // Only the records that arrived without a date need backfilling; --all
  // widens the target to every record (e.g. to re-verify existing dates).
  const targetRecords = options.all ? store.records : store.records.filter((r) => !r.date);
  const allCelex = targetRecords.map((r) => r.celex).filter(Boolean);
  const celexList = options.limit > 0 ? allCelex.slice(0, options.limit) : allCelex;

  const result = loadExisting();
  const remaining = celexList.filter((celex) => !(celex in result));

  console.log(`[dates] ${celexList.length} target records, ${remaining.length} remaining (${Object.keys(result).length} already cached)`);

  let processedBatches = 0;
  for (let i = 0; i < remaining.length; i += BATCH_SIZE) {
    const batch = remaining.slice(i, i + BATCH_SIZE);
    const query = buildQuery(batch);

    let data;
    try {
      data = await runQuery(query);
    } catch (error) {
      console.error(`[dates] batch starting at ${i} failed: ${error.message}`);
      save(result);
      throw error;
    }

    const bindings = data?.results?.bindings || [];
    const found = new Set();
    for (const binding of bindings) {
      const celex = binding.celex?.value;
      const date = normalizeDate(binding.date?.value);
      if (!celex) continue;
      found.add(celex);
      result[celex] = date;
    }
    // Record a null for every celex the endpoint had no date for, so a resume
    // does not re-query it.
    for (const celex of batch) {
      if (!found.has(celex)) result[celex] = null;
    }

    processedBatches += 1;
    console.log(`[dates] batch ${processedBatches} (${batch.length} records, ${found.size} with dates) — ${i + batch.length}/${remaining.length}`);

    if (processedBatches % options.saveEvery === 0) {
      save(result);
    }
  }

  save(result);
  const withDates = Object.values(result).filter(Boolean).length;
  console.log(`[dates] done. Wrote ${Object.keys(result).length} records (${withDates} with dates) to ${OUT_PATH}`);
}

main().catch((error) => {
  console.error("[dates] fatal:", error.message);
  process.exit(1);
});
