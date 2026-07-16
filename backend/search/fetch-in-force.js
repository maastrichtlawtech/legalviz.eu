"use strict";

// Backfills in-force status into an already-built search cache, for when you
// want status without paying for a full rebuild.
//
// This is NOT the primary path: both cache builders (search-build.js and
// build-cache-from-corpus.js) run the same enrichment as their last step, so a
// freshly built cache already has status and you should not need this. It exists
// for the case where the cache is fine but the status isn't — e.g. acts have
// since fallen out of force, or a build ran with --no-in-force.
//
// It is also how the data-v8 asset was produced: status is the *only* field it
// adds, so patching the published cache in place is strictly safer than
// rebuilding one. A rebuild re-derives `date` and `eurovoc` from scratch and
// will silently ship a cache with 13k/80k dates and zero topics if the harvest
// is anything short of complete — that is not hypothetical, it is what happened
// to the first data-v7 upload. Always patch the released asset; never rebuild it
// to add a field.
//
// Usage (from backend/):
//   node --max-old-space-size=8192 search/fetch-in-force.js
//   node search/fetch-in-force.js --limit 200   # smoke test on a subset
//
// Rewrites the whole (~276 MB) cache, hence the heap flag on a full run.

const fs = require("fs");
const zlib = require("zlib");

const { JsonLegalCacheStore } = require("./legal-cache-store");
const { enrichRecordsWithInForce } = require("./in-force-enrich");

const LABEL = "in-force";

function parseArgs(argv) {
  const options = { limit: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--limit" && argv[i + 1]) {
      options.limit = Number.parseInt(argv[i + 1], 10) || 0;
    }
  }
  return options;
}

// store.payload.records are the untouched parsed records — enrichSearchRecord
// spreads into new objects for store.records — so writing the payload back keeps
// the on-disk shape exactly as the builder wrote it, plus `inForce` /
// `endOfValidity`. Every other field, `date` and `eurovoc` included, is carried
// through byte-for-byte rather than recomputed.
function writeCache(store) {
  const json = `${JSON.stringify(store.payload)}\n`;
  const cachePath = store.cachePath;
  const gzPath = `${cachePath}.gz`;

  // Atomic: an interrupted write would otherwise leave a truncated cache that
  // fails to parse at startup, taking search down entirely.
  const tempJson = `${cachePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempJson, json, "utf8");
  fs.renameSync(tempJson, cachePath);

  const tempGz = `${gzPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempGz, zlib.gzipSync(Buffer.from(json, "utf8")));
  fs.renameSync(tempGz, gzPath);

  return { cachePath, gzPath };
}

// The enrichment fields the published asset must never lose. A patch run that
// drops these is the data-v7 incident repeating, and it is invisible until the
// UI goes blank, so refuse to write rather than trust the eyeball.
function assertEnrichmentIntact(records, before) {
  const dated = records.filter((r) => r.date).length;
  const topiced = records.filter((r) => Array.isArray(r.eurovoc)).length;
  if (dated < before.dated || topiced < before.topiced) {
    throw new Error(
      `refusing to write: enrichment regressed (dates ${before.dated} -> ${dated}, ` +
      `eurovoc ${before.topiced} -> ${topiced}). The cache this ran against is not the enriched one.`,
    );
  }
  return { dated, topiced };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  // This is a JSON cache authoring tool. Never auto-select the runtime SQLite
  // artifact, whose records intentionally omit excerpts and are read-only.
  const store = new JsonLegalCacheStore(undefined, { preferJson: true });
  if (!store.load()) {
    throw new Error(`Failed to load search cache: ${store.loadError}`);
  }

  const records = store.payload.records;
  const before = {
    dated: records.filter((r) => r.date).length,
    topiced: records.filter((r) => Array.isArray(r.eurovoc)).length,
  };
  console.log(`[${LABEL}] loaded ${records.length} records (${before.dated} dated, ${before.topiced} with topics)`);

  const stats = await enrichRecordsWithInForce(records, {
    limit: options.limit,
    log: (message) => console.log(`[${LABEL}] ${message}`),
  });

  console.log(`[${LABEL}] ${stats.withStatus} records with status — ${stats.inForce} in force, ${stats.withStatus - stats.inForce} no longer in force (${stats.fromJournal} from journal, ${stats.fetched} fetched, ${stats.alreadyPresent} already had it)`);

  const after = assertEnrichmentIntact(records, before);
  console.log(`[${LABEL}] enrichment intact: ${after.dated} dated, ${after.topiced} with topics`);

  const { cachePath, gzPath } = writeCache(store);
  console.log(`[${LABEL}] wrote ${cachePath} and ${gzPath}`);
  console.log(`[${LABEL}] next: publish the .gz as the data-vN release asset and bump DATA_RELEASE_TAG in backend/Dockerfile`);
}

main().catch((error) => {
  console.error(`[${LABEL}] fatal:`, error.message);
  process.exit(1);
});
