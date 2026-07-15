"use strict";

// Backfills EuroVoc topics into an already-built search cache, for when you
// want topics without paying for a full rebuild.
//
// This is NOT the primary path: both cache builders (search-build.js and
// build-cache-from-corpus.js) run the same enrichment as their last step, so a
// freshly built cache already has topics and you should not need this. It
// exists for the case where the cache is fine but the topics aren't — e.g.
// EuroVoc concepts changed upstream, or a build ran with --no-eurovoc.
//
// Like the builders, it enriches the cache it just read, so the topics can't
// drift from the records they're keyed to.
//
// Usage (from backend/):
//   node --max-old-space-size=8192 search/fetch-eurovoc.js
//   node search/fetch-eurovoc.js --limit 200   # smoke test on a subset
//
// Rewrites the whole (~276 MB) cache, hence the heap flag on a full run.

const fs = require("fs");
const zlib = require("zlib");

const { JsonLegalCacheStore } = require("./legal-cache-store");
const { enrichRecordsWithEurovoc } = require("./eurovoc-enrich");

const LABEL = "eurovoc";

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
// spreads into new objects for store.records — so writing the payload back
// keeps the on-disk shape exactly as the builder wrote it, plus `eurovoc`.
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

async function main() {
  const options = parseArgs(process.argv.slice(2));

  // This is a JSON cache authoring tool. Never auto-select the runtime SQLite
  // artifact, whose records intentionally omit excerpts and are read-only.
  const store = new JsonLegalCacheStore(undefined, { preferJson: true });
  if (!store.load()) {
    throw new Error(`Failed to load search cache: ${store.loadError}`);
  }

  const stats = await enrichRecordsWithEurovoc(store.payload.records, {
    limit: options.limit,
    log: (message) => console.log(`[${LABEL}] ${message}`),
  });

  console.log(`[${LABEL}] ${stats.withLabels} records with topics (${stats.fromJournal} from journal, ${stats.fetched} fetched, ${stats.alreadyPresent} already had them)`);

  const { cachePath, gzPath } = writeCache(store);
  console.log(`[${LABEL}] wrote ${cachePath} and ${gzPath}`);
  console.log(`[${LABEL}] next: publish the .gz as the data-vN release asset and bump DATA_RELEASE_TAG in backend/Dockerfile`);
}

main().catch((error) => {
  console.error(`[${LABEL}] fatal:`, error.message);
  process.exit(1);
});
