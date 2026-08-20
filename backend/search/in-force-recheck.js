"use strict";

// Periodic in-force RE-check (issue #167).
//
// in-force-enrich.js only ever fills a *gap*: it skips any record that already
// carries `inForce`, and separately skips any celex already answered in
// data/in-force.json. Every record restored from the published search cache
// carries the field, and the journal survives every rebuild, so in practice no
// act's status is ever re-asked after its first harvest — a repealed act keeps
// reading `inForce: true` forever.
//
// This module defeats both skips for a bounded slice only: it clears
// `inForce` / `endOfValidity` on the slice's records AND drops the matching
// journal entries, then hands the slice to enrichRecordsWithInForce, which
// then has no choice but to ask Cellar again. Everything outside the slice is
// untouched — this is not a rebuild and not a sweep.
//
// Slice selection (in priority order):
//   1. Records whose `endOfValidity` has already passed but which still read
//      `inForce: true` — these are known-wrong regardless of when they were
//      last checked, so they always make the slice first.
//   2. A rotating age-based fill, oldest `statusCheckedAt` first (a record
//      that predates the field sorts as infinitely stale), up to --batch-size.
// That rotation is what gives the cache a known, stated turnover cycle: at
// batch-size B against N eligible records, a full sweep takes ceil(N / B) runs.
//
// Not invoked by any workflow — the scheduling decision is a human's. Proposed
// invocation (NOT wired here, see the PR description):
//   node search/in-force-recheck.js --batch-size 2000 --cycle-days 30
//
// Usage:
//   node search/in-force-recheck.js [--batch-size N] [--cycle-days N]
//     [--cache-path path] [--sweep]
//   --sweep treats the whole cache as the slice (explicit opt-in only — an
//   ~80k-act corpus must not be re-queried by default).

const fs = require("fs");
const zlib = require("zlib");

const { JsonLegalCacheStore } = require("./legal-cache-store");
const {
  DEFAULT_JOURNAL_PATH,
  enrichRecordsWithInForce,
  readJournal,
  writeJournal,
} = require("./in-force-enrich");

const LABEL = "in-force-recheck";
const DEFAULT_BATCH_SIZE = 2000;
const DEFAULT_CYCLE_DAYS = 30;

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function isExpiredButInForce(record, today) {
  return record.inForce === true
    && typeof record.endOfValidity === "string"
    && record.endOfValidity < today;
}

// Missing or unparseable statusCheckedAt sorts as "oldest": a record that
// predates the field is at least as overdue as one checked at the dawn of time.
function statusAgeKey(record) {
  const parsed = record.statusCheckedAt ? Date.parse(record.statusCheckedAt) : NaN;
  return Number.isNaN(parsed) ? -Infinity : parsed;
}

// Priority 1 (expired-but-in-force) always makes the slice, even if it alone
// exceeds batchSize — these are the cheapest, most confidently wrong records
// in the cache and should never be starved by the rotation. Priority 2 fills
// whatever budget is left, oldest-checked first.
function selectRecheckSlice(records, options = {}) {
  const { batchSize = DEFAULT_BATCH_SIZE, today = todayIso(), sweep = false } = options;
  const eligible = records.filter((record) => record.celex);

  if (sweep) return eligible.slice();

  const expired = eligible.filter((record) => isExpiredButInForce(record, today));
  const expiredCelex = new Set(expired.map((record) => record.celex));

  const remaining = Math.max(0, batchSize - expired.length);
  const rotationPool = eligible
    .filter((record) => !expiredCelex.has(record.celex))
    .sort((a, b) => statusAgeKey(a) - statusAgeKey(b));

  return expired.concat(rotationPool.slice(0, remaining));
}

// Defeats both in-force-enrich.js skips for exactly this slice: the in-memory
// field guard (`record.inForce !== undefined`) and the on-disk journal entry
// keyed by celex. Mutates `slice` members in place and rewrites the journal
// file with the slice's entries removed; everything else in the journal (and
// every record outside the slice) is left alone.
function primeSliceForRecheck(slice, journalPath) {
  const journal = readJournal(journalPath);
  let journalEntriesDropped = 0;
  for (const record of slice) {
    delete record.inForce;
    delete record.endOfValidity;
    if (Object.prototype.hasOwnProperty.call(journal, record.celex)) {
      delete journal[record.celex];
      journalEntriesDropped += 1;
    }
  }
  writeJournal(journalPath, journal);
  return { journalEntriesDropped };
}

function classifyFlip(before, after) {
  if (before.inForce === true && after.inForce === false) return "toRepealed";
  if (before.inForce === false && after.inForce === true) return "toInForce";
  return null;
}

// Orchestrates one bounded recheck run over `records` (mutated in place, same
// contract as enrichRecordsWithInForce). Returns how many records were
// touched, how many were actually re-queried (vs. answered from a still-valid
// journal entry for some *other* celex — should be ~0 for the slice since we
// just dropped its own entries), and — the number that matters for catching a
// silent no-op regression — how many statuses actually flipped.
async function runRecheck(records, options = {}) {
  const {
    journalPath = DEFAULT_JOURNAL_PATH,
    batchSize = DEFAULT_BATCH_SIZE,
    sweep = false,
    today = todayIso(),
    log = () => {},
    runQueryFn,
  } = options;

  const slice = selectRecheckSlice(records, { batchSize, today, sweep });
  const before = new Map(
    slice.map((record) => [record.celex, { inForce: record.inForce, endOfValidity: record.endOfValidity }]),
  );

  const { journalEntriesDropped } = primeSliceForRecheck(slice, journalPath);
  log(`slice=${slice.length} sweep=${sweep} journalEntriesDropped=${journalEntriesDropped}`);

  const enrichStats = await enrichRecordsWithInForce(slice, {
    journalPath,
    log,
    ...(runQueryFn ? { runQueryFn } : {}),
  });

  let flippedToRepealed = 0;
  let flippedToInForce = 0;
  for (const record of slice) {
    const prev = before.get(record.celex);
    const flip = classifyFlip(prev, record);
    if (flip === "toRepealed") flippedToRepealed += 1;
    else if (flip === "toInForce") flippedToInForce += 1;
  }

  return {
    sliceSize: slice.length,
    journalEntriesDropped,
    requeried: enrichStats.fetched,
    flippedToRepealed,
    flippedToInForce,
    flipped: flippedToRepealed + flippedToInForce,
    enrichStats,
  };
}

function parseArgs(argv) {
  const options = {
    cachePath: undefined,
    batchSize: DEFAULT_BATCH_SIZE,
    cycleDays: DEFAULT_CYCLE_DAYS,
    sweep: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--batch-size" && argv[index + 1]) {
      options.batchSize = Number.parseInt(argv[++index], 10) || DEFAULT_BATCH_SIZE;
    } else if (token === "--cycle-days" && argv[index + 1]) {
      options.cycleDays = Number.parseInt(argv[++index], 10) || DEFAULT_CYCLE_DAYS;
    } else if (token === "--cache-path" && argv[index + 1]) {
      options.cachePath = argv[++index];
    } else if (token === "--sweep") {
      options.sweep = true;
    }
  }
  return options;
}

// store.payload.records are the untouched parsed records — see the identical
// note in fetch-in-force.js. Writing the payload back keeps every other field
// (date, eurovoc, excerpt, ...) byte-for-byte as the builder wrote it.
function writeCache(store) {
  const json = `${JSON.stringify(store.payload)}\n`;
  const cachePath = store.cachePath;
  const gzPath = `${cachePath}.gz`;

  const tempJson = `${cachePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempJson, json, "utf8");
  fs.renameSync(tempJson, cachePath);

  const tempGz = `${gzPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempGz, zlib.gzipSync(Buffer.from(json, "utf8")));
  fs.renameSync(tempGz, gzPath);

  return { cachePath, gzPath };
}

// Same regression guard as fetch-in-force.js: this tool only ever touches
// inForce/endOfValidity/statusCheckedAt on a slice, so date/eurovoc coverage
// must never move. A drop means this ran against the wrong cache.
function assertEnrichmentIntact(records, before) {
  const dated = records.filter((r) => r.date).length;
  const topiced = records.filter((r) => Array.isArray(r.eurovoc)).length;
  if (dated < before.dated || topiced < before.topiced) {
    throw new Error(
      `refusing to write: enrichment regressed (dates ${before.dated} -> ${dated}, `
      + `eurovoc ${before.topiced} -> ${topiced}). The cache this ran against is not the enriched one.`,
    );
  }
  return { dated, topiced };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const store = new JsonLegalCacheStore(options.cachePath, { preferJson: true });
  if (!store.load()) {
    throw new Error(`Failed to load search cache: ${store.loadError}`);
  }

  const records = store.payload.records;
  const before = {
    dated: records.filter((r) => r.date).length,
    topiced: records.filter((r) => Array.isArray(r.eurovoc)).length,
  };
  console.log(`[${LABEL}] loaded ${records.length} records from ${store.cachePath}`);
  if (options.sweep) {
    console.log(`[${LABEL}] --sweep: treating the ENTIRE cache as the slice, ignoring --batch-size`);
  } else {
    console.log(`[${LABEL}] batch-size=${options.batchSize} cycle-days=${options.cycleDays}`
      + ` (at this batch size, a full rotation takes ceil(eligible / batch-size) runs,`
      + ` i.e. roughly every ${options.cycleDays} x ceil(eligible / batch-size) days if run on that cadence)`);
  }

  const result = await runRecheck(records, {
    batchSize: options.batchSize,
    sweep: options.sweep,
    log: (message) => console.log(`[${LABEL}] ${message}`),
  });

  console.log(
    `[${LABEL}] rechecked ${result.sliceSize} records`
    + ` (${result.journalEntriesDropped} journal entries dropped, ${result.requeried} re-queried against Cellar)`,
  );
  console.log(
    `[${LABEL}] status flips: ${result.flipped} total`
    + ` (${result.flippedToRepealed} in-force -> repealed, ${result.flippedToInForce} repealed -> in-force)`,
  );
  if (result.flipped === 0 && result.requeried > 0) {
    console.log(`[${LABEL}] note: 0 flips out of ${result.requeried} re-queried records is expected on most runs — status rarely changes day to day.`);
  }

  const after = assertEnrichmentIntact(records, before);
  console.log(`[${LABEL}] enrichment intact: ${after.dated} dated, ${after.topiced} with topics`);

  const { cachePath, gzPath } = writeCache(store);
  console.log(`[${LABEL}] wrote ${cachePath} and ${gzPath}`);
  console.log(`[${LABEL}] next: publish the .gz as the data-vN release asset and bump DATA_RELEASE_TAG in backend/Dockerfile`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[${LABEL}] fatal:`, error.message);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  DEFAULT_CYCLE_DAYS,
  classifyFlip,
  isExpiredButInForce,
  primeSliceForRecheck,
  runRecheck,
  selectRecheckSlice,
  statusAgeKey,
};
