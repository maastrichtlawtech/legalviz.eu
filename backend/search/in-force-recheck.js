"use strict";

// Periodic in-force re-check (issue #167).
//
// in-force-enrich.js only ever fills a *gap*: it skips any record that already
// carries `inForce`. Every record restored from the published search cache
// carries it, so no act's status is ever re-asked after its first harvest — a
// repealed act keeps reading `inForce: true` forever.
//
// This tool clears the field and asks Cellar again. It re-checks everything NOT
// already known to be out of force: `inForce: false` is effectively terminal —
// an act that has fallen out of force does not come back — and that is 50,393
// of the 80,469 acts in data-v11. What is left is small enough to sweep whole
// on every run:
//
//   inForce: true    19,588   can be repealed or expire     -> swept
//   inForce: null    10,488   Cellar had no status yet      -> swept (may gain one)
//   inForce: false   50,393   terminal                      -> skipped (--all to include)
//
// ~30k records is ~301 SPARQL batches at 100 ids each, measured at 200-400ms per
// batch against Cellar: about two minutes, most of it spent parsing and
// re-serialising the cache rather than on the network. There is deliberately no
// slicing, batch budget or turnover cycle — at this cost, a partial re-check
// would only buy staleness back.
//
// Nor is there a resume journal. The run is all-or-nothing: it writes the cache
// once, at the end, only if a status actually moved, so a run that fails
// partway leaves nothing behind to resume from and is simply re-run. Passing
// `useJournal: false` also spares ~60 rewrites of a 30k-entry file per run.
// (The builders that call the same enrichment keep the journal — an interrupted
// multi-hour harvest genuinely needs to resume.)
//
// Usage:
//   node --max-old-space-size=8192 search/in-force-recheck.js
//     [--cache-path path] [--all] [--limit N] [--max-null-ratio R] [--no-gz]

const fs = require("fs");
const zlib = require("zlib");

const { JsonLegalCacheStore } = require("./legal-cache-store");
const { enrichRecordsWithInForce } = require("./in-force-enrich");

const LABEL = "in-force-recheck";

// Cellar answering "no status" for a re-checked record that previously had one
// is indistinguishable, per record, from a genuine retraction. In bulk it is
// not: it means the endpoint is degraded but still returning 200s. Refuse to
// write past this fraction rather than let a bad afternoon at Cellar erase the
// status coverage the Docker guard checks for (>80%, currently 87%).
const DEFAULT_MAX_NULL_RATIO = 0.05;

// `false` is terminal; everything else (true, null, or a record that predates
// the field entirely) is a status that can still move.
function isRecheckable(record) {
  return record.inForce !== false;
}

function classifyFlip(before, after) {
  if (before.inForce === true && after.inForce === false) return "toRepealed";
  if (before.inForce === false && after.inForce === true) return "toInForce";
  return null;
}

// Any difference in either field, not just a true<->false flip: a status going
// to or from `null`, or an end-of-validity date being corrected, is a real
// change to the published data and must be written.
function hasChanged(before, after) {
  return before.inForce !== after.inForce || before.endOfValidity !== after.endOfValidity;
}

// A record that had a decided status and came back without one. Counted apart
// from ordinary changes because in bulk it means Cellar, not the law, moved.
function lostStatus(before, after) {
  return (before.inForce === true || before.inForce === false) && after.inForce === null;
}

// Orchestrates one re-check over `records` (mutated in place, same contract as
// enrichRecordsWithInForce). Reports what was re-queried, what actually changed,
// and — separately — the flips, because a re-check that silently stops
// re-checking looks identical to a quiet month unless flips are counted apart
// from work done.
//
// `limit` is applied when choosing the targets, never passed down to the
// enrichment: clearing a record the enrichment then declines to refill would
// leave it with no `inForce` key at all, which is exactly what the Docker guard
// fails the build over.
async function runRecheck(records, options = {}) {
  const { all = false, limit = 0, log = () => {}, runQueryFn } = options;

  const eligible = records.filter((record) => record.celex && (all || isRecheckable(record)));
  const targets = limit > 0 ? eligible.slice(0, limit) : eligible;

  const before = new Map(
    targets.map((record) => [record.celex, { inForce: record.inForce, endOfValidity: record.endOfValidity }]),
  );
  // Defeats the enrichment's "already knows this one" skip.
  for (const record of targets) {
    delete record.inForce;
    delete record.endOfValidity;
  }
  log(`re-checking ${targets.length} records (all=${all})`);

  const enrichStats = await enrichRecordsWithInForce(targets, {
    useJournal: false,
    log,
    ...(runQueryFn ? { runQueryFn } : {}),
  });

  let flippedToRepealed = 0;
  let flippedToInForce = 0;
  let changed = 0;
  let lostStatusCount = 0;
  for (const record of targets) {
    const prev = before.get(record.celex);
    const flip = classifyFlip(prev, record);
    if (flip === "toRepealed") flippedToRepealed += 1;
    else if (flip === "toInForce") flippedToInForce += 1;
    if (hasChanged(prev, record)) changed += 1;
    if (lostStatus(prev, record)) lostStatusCount += 1;
  }

  return {
    rechecked: targets.length,
    requeried: enrichStats.fetched,
    changed,
    lostStatus: lostStatusCount,
    flippedToRepealed,
    flippedToInForce,
    flipped: flippedToRepealed + flippedToInForce,
    enrichStats,
  };
}

// Throws when too much of the run lost a previously known status at once.
// Bounded by what was re-checked, not by the whole cache, so it stays
// meaningful under --limit as well as on a full sweep.
function assertStatusNotDegraded(result, maxNullRatio = DEFAULT_MAX_NULL_RATIO) {
  if (result.rechecked === 0) return 0;
  const ratio = result.lostStatus / result.rechecked;
  if (ratio > maxNullRatio) {
    throw new Error(
      `refusing to write: ${result.lostStatus}/${result.rechecked} re-checked records `
      + `(${(ratio * 100).toFixed(1)}%) lost a previously known status, above the `
      + `${(maxNullRatio * 100).toFixed(1)}% threshold. Cellar is answering but degraded; `
      + "re-run rather than publish this.",
    );
  }
  return ratio;
}

function parseArgs(argv) {
  const options = {
    cachePath: undefined,
    all: false,
    limit: 0,
    maxNullRatio: DEFAULT_MAX_NULL_RATIO,
    gz: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--cache-path" && argv[index + 1]) {
      options.cachePath = argv[++index];
    } else if (token === "--limit" && argv[index + 1]) {
      options.limit = Number.parseInt(argv[++index], 10) || 0;
    } else if (token === "--max-null-ratio" && argv[index + 1]) {
      const parsed = Number.parseFloat(argv[++index]);
      if (Number.isFinite(parsed)) options.maxNullRatio = parsed;
    } else if (token === "--all") {
      options.all = true;
    } else if (token === "--no-gz") {
      options.gz = false;
    }
  }
  return options;
}

// store.payload.records are the untouched parsed records — see the identical
// note in fetch-in-force.js. Writing the payload back keeps every other field
// (date, eurovoc, excerpt, ...) byte-for-byte as the builder wrote it.
//
// The .gz sidecar is skippable: refresh-data.yml gzips search-cache.json itself
// as a later step, so writing it here would be ~50 MB of redundant compression
// on a runner that also holds the corpus.
function writeCache(store, { gz = true } = {}) {
  const json = `${JSON.stringify(store.payload)}\n`;
  const cachePath = store.cachePath;

  const tempJson = `${cachePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempJson, json, "utf8");
  fs.renameSync(tempJson, cachePath);

  if (!gz) return { cachePath, gzPath: null };

  const gzPath = `${cachePath}.gz`;
  const tempGz = `${gzPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempGz, zlib.gzipSync(Buffer.from(json, "utf8")));
  fs.renameSync(tempGz, gzPath);

  return { cachePath, gzPath };
}

// Same regression guard as fetch-in-force.js: this tool only ever touches
// inForce/endOfValidity, so date/eurovoc coverage must never move. A drop means
// this ran against the wrong cache.
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
  const outOfForce = records.filter((r) => r.inForce === false).length;
  console.log(`[${LABEL}] loaded ${records.length} records from ${store.cachePath}`);
  console.log(
    `[${LABEL}] ${outOfForce} records are already out of force`
    + `${options.all ? " (re-checked anyway: --all)" : " and are not re-checked"}`,
  );

  const result = await runRecheck(records, {
    all: options.all,
    limit: options.limit,
    log: (message) => console.log(`[${LABEL}] ${message}`),
  });

  console.log(
    `[${LABEL}] re-checked ${result.rechecked} records`
    + ` (${result.requeried} re-queried against Cellar)`,
  );
  console.log(
    `[${LABEL}] status flips: ${result.flipped} total`
    + ` (${result.flippedToRepealed} in-force -> repealed, ${result.flippedToInForce} repealed -> in-force);`
    + ` ${result.changed} records changed in all, ${result.lostStatus} lost a known status`,
  );

  const ratio = assertStatusNotDegraded(result, options.maxNullRatio);
  console.log(`[${LABEL}] status loss ${(ratio * 100).toFixed(2)}% is within the ${(options.maxNullRatio * 100).toFixed(1)}% threshold`);

  const after = assertEnrichmentIntact(records, before);
  console.log(`[${LABEL}] enrichment intact: ${after.dated} dated, ${after.topiced} with topics`);

  // The no-op short circuit. refresh-data.yml publishes a release iff the cache
  // bytes changed, so confirming 30k unchanged statuses must not touch the file.
  if (result.changed === 0) {
    console.log(`[${LABEL}] no status changed; leaving ${store.cachePath} untouched (no release needed)`);
    return;
  }

  const { cachePath, gzPath } = writeCache(store, { gz: options.gz });
  console.log(`[${LABEL}] wrote ${cachePath}${gzPath ? ` and ${gzPath}` : ""}`);
  console.log(`[${LABEL}] next: publish the .gz as the data-vN release asset and bump DATA_RELEASE_TAG in backend/Dockerfile`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[${LABEL}] fatal:`, error.message);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_MAX_NULL_RATIO,
  assertStatusNotDegraded,
  classifyFlip,
  hasChanged,
  isRecheckable,
  runRecheck,
};
