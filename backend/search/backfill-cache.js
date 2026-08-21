// Adds records for an explicit CELEX list to an existing search cache, without
// re-running the multi-hour year sweep.
//
// This is the repair path for acts a harvest missed one at a time (a transient
// Cellar failure, or an act Cellar had not indexed yet when the sweep ran — see
// issue #100). `reenrich-cache.js` only refreshes records that are ALREADY in
// the cache; this one creates the missing ones.
//
// It runs the same steps the full builder does, in the same order, so a
// backfilled record is indistinguishable from a swept one: SPARQL metadata ->
// enrichRecords (title + excerpt, corpus-first) -> eurovoc -> in-force ->
// enrichSearchRecord (normalized/alias fields the shipped asset carries).
//
// Reads and writes .json or .json.gz (detected by extension), so it can patch
// the shipped release asset directly.
//
// Usage (from backend/):
//   node search/backfill-cache.js --celex 32014D0055,32016D0040 \
//     --cachePath search/data/search-cache.json.gz
//   node search/backfill-cache.js --celex @missing.txt \
//     --cachePath in.json.gz --out out.json.gz
//   node search/backfill-cache.js --celex @missing.txt \
//     --result-json backfill-result.json   # {added, addedIds, replaced, dropped}

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const {
  DEFAULT_SEARCH_CACHE_PATH,
  CORPUS_DIR,
  enrichRecords,
  harvestActsByCelex,
  isQueryableCelexId
} = require("./search-build");
const { enrichRecordsWithEurovoc } = require("./eurovoc-enrich");
const { enrichRecordsWithInForce } = require("./in-force-enrich");
const { enrichSearchRecord } = require("./search-ranking");

function log(message) {
  console.log(`[backfill] ${message}`);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return options;
}

// `--celex` takes either a comma/whitespace-separated list or `@path` to read
// the same from a file (the miss sidecars html-harvest writes are one id/line).
function readCelexIds(value) {
  const raw = typeof value === "string" && value.startsWith("@")
    ? fs.readFileSync(path.resolve(value.slice(1)), "utf8")
    : String(value || "");
  return [...new Set(raw.split(/[\s,]+/).map((id) => id.trim().toUpperCase()).filter(Boolean))];
}

function readPayload(cachePath) {
  const buffer = fs.readFileSync(cachePath);
  const json = cachePath.endsWith(".gz") ? zlib.gunzipSync(buffer) : buffer;
  return JSON.parse(json.toString("utf8"));
}

// Written via a temp file + rename so an interrupted run can never leave a
// truncated cache behind where a valid one used to be.
function writePayload(cachePath, payload) {
  const json = `${JSON.stringify(payload)}\n`;
  const body = cachePath.endsWith(".gz")
    ? zlib.gzipSync(Buffer.from(json, "utf8"), { level: 9 })
    : Buffer.from(json, "utf8");
  const tempPath = `${cachePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, body);
  fs.renameSync(tempPath, cachePath);
}

async function backfillCache(options = {}) {
  const cachePath = path.resolve(options.cachePath || DEFAULT_SEARCH_CACHE_PATH);
  const outPath = path.resolve(options.out || cachePath);
  const celexIds = readCelexIds(options.celex);
  if (!celexIds.length) throw new Error("backfill-cache requires --celex <ids|@file>");

  const payload = readPayload(cachePath);
  const byCelex = new Map(payload.records.map((record) => [record.celex, record]));

  // Corrigenda (`…R(01)`) and stray tokens are never primary acts and can't go
  // into the query — drop them here so one bad id doesn't sink the batch.
  const unqueryable = celexIds.filter((celex) => !isQueryableCelexId(celex));
  if (unqueryable.length) {
    log(`not queryable CELEX ids, dropping ${unqueryable.length}: ${unqueryable.join(",")}`);
  }
  const queryable = celexIds.filter((celex) => isQueryableCelexId(celex));

  // Corpus-first: an id already in the cache is left alone unless --force, so a
  // re-run after a partial failure only fetches what is still missing.
  const targets = options.force ? queryable : queryable.filter((celex) => !byCelex.has(celex));
  log(`cache=${cachePath} records=${payload.records.length}`);
  log(`requested=${celexIds.length} already present=${celexIds.length - targets.length} to fetch=${targets.length}`);
  if (!targets.length) return { added: 0, addedIds: [], replaced: 0, dropped: unqueryable, count: payload.count };

  // Seams for tests: the SPARQL/EUR-Lex round-trips are the one part that can't
  // be exercised offline.
  const harvestImpl = options.harvestImpl || harvestActsByCelex;
  const enrichImpl = options.enrichImpl || enrichRecords;

  const harvested = await harvestImpl({ celexIds: targets });
  const withoutEli = targets.filter((celex) => !harvested.some((record) => record.celex === celex));
  if (withoutEli.length) {
    log(`no primary ELI in Cellar, dropping ${withoutEli.length}: ${withoutEli.join(",")}`);
  }
  if (!harvested.length) {
    return { added: 0, addedIds: [], replaced: 0, dropped: [...unqueryable, ...withoutEli], count: payload.count };
  }

  // Title + excerpt. corpusDir is the default corpus, so anything already
  // downloaded is read from disk and only genuine misses hit the network.
  await enrichImpl(harvested, {
    concurrency: Number.parseInt(String(options.concurrency || "4"), 10) || 4,
    corpusDir: options.corpusDir === undefined ? CORPUS_DIR : options.corpusDir
  });

  // Same last-step-of-the-build order as buildSearchCache: these are CELEX-keyed
  // and must see the records they ship alongside, or they silently serve empty.
  if (options.eurovoc !== false && options["no-eurovoc"] !== true) {
    await enrichRecordsWithEurovoc(harvested, { log });
  }
  if (options.inForce !== false && options["no-in-force"] !== true) {
    await enrichRecordsWithInForce(harvested, { log });
  }

  // The shipped asset carries enrichSearchRecord's derived fields (aliases,
  // normalizedTitle, isPrimaryAct…) baked in; bake them here too so a
  // backfilled record hydrates identically from JSON and SQLite.
  const enriched = harvested.map((record) => enrichSearchRecord(record));
  const nonPrimary = enriched.filter((record) => !record.isPrimaryAct);
  if (nonPrimary.length) {
    log(`not primary acts, dropping ${nonPrimary.length}: ${nonPrimary.map((r) => r.celex).join(",")}`);
  }
  const additions = enriched.filter((record) => record.isPrimaryAct);

  const addedIds = [];
  let replaced = 0;
  for (const record of additions) {
    if (byCelex.has(record.celex)) {
      Object.assign(byCelex.get(record.celex), record);
      replaced += 1;
    } else {
      payload.records.push(record);
      byCelex.set(record.celex, record);
      addedIds.push(record.celex);
    }
  }
  const added = addedIds.length;

  payload.count = payload.records.length;
  payload.patchedAt = new Date().toISOString();

  if (options["dry-run"]) {
    log(`dry run — would write ${payload.count} records (added=${added} replaced=${replaced})`);
  } else {
    writePayload(outPath, payload);
    log(`wrote ${outPath} with ${payload.count} records (added=${added} replaced=${replaced})`);
  }
  return {
    added,
    addedIds,
    replaced,
    dropped: [...unqueryable, ...withoutEli, ...nonPrimary.map((record) => record.celex)],
    count: payload.count
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await backfillCache(options);
  // Counts only: `dropped` can hold tens of thousands of ids, and callers
  // (refresh-data's baseline step) parse this line for `.added`. The full
  // result, ids included, goes to --result-json for anything that needs it.
  log(`done: ${JSON.stringify({
    added: result.added,
    replaced: result.replaced,
    dropped: result.dropped.length,
    count: result.count
  })}`);
  if (typeof options["result-json"] === "string") {
    const resultPath = path.resolve(options["result-json"]);
    fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    log(`wrote ${resultPath}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[backfill] fatal: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { backfillCache, readCelexIds };
