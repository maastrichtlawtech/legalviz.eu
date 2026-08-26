// Full-text index builder: article + recital body text over the primary-act
// corpus, indexed as an external-content FTS5 table (units_fts). This is a
// separate SQLite file from data.sqlite (own FULLTEXT_SCHEMA_VERSION —
// legal-cache-store.js keeps a lock-step copy of the constant, citation-graph
// style) so a missing or stale artifact degrades to "fulltext unavailable"
// without touching the rest of the search store.
//
// Structurally this clones definition-index-build.js (DI'd shard function,
// worker pool with a heap cap, batch-bisect on worker death, CLI flags,
// invoked as an npm script rather than through the `eurlex` CLI). Its pool is
// the shared worker-pool implementation: persistent per-worker processes that
// receive many batches over their lifetime, rather than one worker per batch —
// a worker crash (OOM on a giant act) splits the in-flight batch and respawns a
// replacement.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { promisify } = require("util");
const {
  celexForCorpusFile,
  filterCorpusFiles,
  isHtmlCorpusFile,
  listAllCorpusFiles,
  stripCompleteUppercaseAnnexes,
  writeArtifactAtomic,
} = require("./citation-graph-build");
const { dedupeCorpusFiles } = require("./definition-index-build");
const { readJsonAsset, sha256File } = require("./build-sqlite-data");
const { DEFAULT_SEARCH_CACHE_PATH } = require("./search-index");
const { stripXmlTags, wrapForParsing } = require("./search-build");
const { normalizeParserStamp } = require("./parser-stamp");
const { WorkerLossError, runPool: runWorkerPool } = require("../shared/worker-pool");

const gunzip = promisify(zlib.gunzip);

// Bumped whenever the schema below (or what gets stamped into
// fulltext_metadata) changes shape. legal-cache-store.js checks this against
// PRAGMA user_version before trusting the artifact — keep the two in
// lock-step, there is deliberately no shared module to import it from (same
// reasoning as GRAPH_VERSION in citation-graph-store.js).
const FULLTEXT_SCHEMA_VERSION = 1;

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_POOL_SIZE = 2;
const DEFAULT_WORKER_HEAP_MB = 640;
// Same ceiling as the definition/citation-graph builders: definitions and
// citations live in the operative text, and full-text units are extracted
// from the very same parsed document, so oversized inputs need the same
// annex-stripping fallback and failure accounting.
const DEFAULT_MAX_XML_BYTES = 6 * 1024 * 1024;
const DEFAULT_MAX_HTML_BYTES = 4 * 1024 * 1024;
const DEFAULT_CORPUS_DIR = path.join(__dirname, "data", "laws");
const DEFAULT_OUTPUT_PATH = path.join(__dirname, "data", "fulltext.sqlite");

function resolveBetterSqlite3() {
  // better-sqlite3 is hoisted to the repo-root node_modules by the package
  // manager; plain require() already resolves it via Node's normal
  // parent-directory walk (legal-cache-store.js and build-sqlite-data.js do
  // the same bare require).
  return require("better-sqlite3");
}

async function readGzip(file, fsApi = fs.promises) {
  return (await gunzip(await fsApi.readFile(file))).toString("utf8");
}

// DI'd shard function: parses a batch of corpus files into unit rows. Kept
// free of worker_threads/db concerns so it is directly unit-testable, same
// split as buildDefinitionShard/buildFulltextIndex.
async function buildFulltextShard(options = {}) {
  const fsApi = options.fsApi || fs.promises;
  const files = options.files || [];
  const parseXml = options.parseXml || require("../shared/fmx-parser-node").parseFmxXml;
  const wrapXml = options.wrapXml || wrapForParsing;
  const parseHtml = options.parseHtml || ((html) => require("../shared/eurlex-html-parser").parseEurlexHtmlToCombined(html, "ENG"));
  const readFile = options.readFile || ((file) => readGzip(file, fsApi));
  const maxXmlBytes = options.maxXmlBytes ?? DEFAULT_MAX_XML_BYTES;
  const maxHtmlBytes = options.maxHtmlBytes ?? DEFAULT_MAX_HTML_BYTES;
  // bytes is the decompressed input this shard actually fed to a parser.
  // Divided into parseMs it gives MB/s, which separates the two ways a build
  // can slow down: acts that are simply larger hold MB/s flat while ms/batch
  // climbs, whereas a process degrading over its own uptime drags MB/s down.
  const stats = { corpusFiles: files.length, parsed: 0, htmlLaws: 0, oversized: 0, files: files.length, bytes: 0 };
  const failures = [];
  const units = [];
  const parserVersions = new Set();

  for (const file of files) {
    const celex = celexForCorpusFile(file);
    try {
      let source = await readFile(file);
      const bytes = Buffer.byteLength(source, "utf8");
      stats.bytes += bytes;
      let parsed;
      if (isHtmlCorpusFile(file)) {
        if (bytes > maxHtmlBytes) throw Object.assign(new Error(`Decompressed HTML exceeds ${maxHtmlBytes} bytes`), { oversized: true });
        parsed = await parseHtml(source);
        stats.htmlLaws += 1;
      } else {
        if (bytes > maxXmlBytes) {
          const stripped = stripCompleteUppercaseAnnexes(source);
          const strippedBytes = Buffer.byteLength(stripped.operativeXml, "utf8");
          if (!stripped.annexElementsOmitted || !stripped.hasAct || stripped.hasUnmatchedAnnexMarkup
            || stripped.hasSelfClosingAnnex || strippedBytes > maxXmlBytes) {
            throw Object.assign(new Error(`Decompressed FMX exceeds ${maxXmlBytes} bytes and has no safe operative-only fallback`), { oversized: true });
          }
          source = stripped.operativeXml;
        }
        parsed = await parseXml(wrapXml(source));
      }
      if (!parsed) throw new Error("Parser returned no document");
      stats.parsed += 1;
      if (parsed.parserVersion != null) parserVersions.add(parsed.parserVersion);

      // Articles and recitals only — annexes are deliberately excluded (D2).
      for (const article of parsed.articles || []) {
        const text = stripXmlTags(article.article_html || "");
        if (!text) continue;
        units.push({
          celex,
          unit_type: "article",
          number: String(article.article_number || ""),
          heading: stripXmlTags(article.article_title || ""),
          text,
        });
      }
      for (const recital of parsed.recitals || []) {
        const text = stripXmlTags(recital.recital_text || recital.recital_html || "");
        if (!text) continue;
        units.push({
          celex,
          unit_type: "recital",
          number: String(recital.recital_number || ""),
          heading: "",
          text,
        });
      }
    } catch (error) {
      stats.oversized += error?.oversized ? 1 : 0;
      failures.push({ celex, type: error?.oversized ? "oversized" : "parse", error: String(error?.message || error) });
    }
  }
  const versions = [...parserVersions].sort();
  return { parserVersion: versions.length === 1 ? versions[0] : (versions.length ? versions : null), stats, failures, units };
}

function openFulltextDatabase(outputPath) {
  const Database = resolveBetterSqlite3();
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const fresh = !fs.existsSync(outputPath);
  const db = new Database(outputPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  if (fresh) {
    db.exec(`
      CREATE TABLE units (
        id INTEGER PRIMARY KEY,
        celex TEXT,
        unit_type TEXT,
        number TEXT,
        heading TEXT,
        char_count INTEGER,
        text TEXT
      );
      CREATE VIRTUAL TABLE units_fts USING fts5(
        heading, text,
        content='units', content_rowid='id', detail='full',
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TABLE fulltext_metadata (key TEXT PRIMARY KEY, value TEXT);
    `);
  } else {
    // An existing file is only ever resumed onto, never re-created — so its
    // schema must match what this build is about to write. `user_version` is
    // 0 until the very last step of a successful build stamps it (see the
    // comment above that pragma write below), so 0 means "an interrupted
    // build of whatever schema is current" and is safe to resume. Anything
    // else that isn't FULLTEXT_SCHEMA_VERSION is a completed build from a
    // schema that has since changed shape; resuming onto it would insert
    // current-shape rows alongside old ones and then stamp the whole file as
    // current, same failure mode definition-index-build.js's readCheckpoint
    // guards against for its JSON checkpoint. Unlike that checkpoint, this is
    // the artifact itself with no separate "discard and start clean" path, so
    // this throws rather than silently deleting or ignoring an on-disk file.
    const existingVersion = db.pragma("user_version", { simple: true });
    if (existingVersion !== 0 && existingVersion !== FULLTEXT_SCHEMA_VERSION) {
      db.close();
      throw new Error(
        `${outputPath} has schema version ${existingVersion}, but this build writes version ${FULLTEXT_SCHEMA_VERSION}. `
        + "Resuming would stamp stale rows as current. Delete the file and rebuild from scratch."
      );
    }
  }
  return db;
}

// Size of the write-ahead log beside the index, in MB. The build never
// checkpoints the WAL itself (the workflow does, once, before uploading the
// artifact), so an unbounded WAL is the other way this build could decay
// within a dispatch and recover across one. Reported beside the worker heap
// so a single run distinguishes the two.
// Parse throughput for one batch, in KB/s. A batch is around a megabyte, so
// MB/s would round to one significant figure and hide exactly the trend this
// exists to show. Zero elapsed time reports 0 rather than Infinity so the
// progress line stays parseable.
function kbPerSecond(bytes, ms) {
  if (!ms) return 0;
  return Math.round((bytes / 1024) / (ms / 1000));
}

function walSizeMb(outputPath) {
  try {
    return Math.round(fs.statSync(`${outputPath}-wal`).size / (1024 * 1024));
  } catch {
    return 0;
  }
}

// Keep the builder's exported runPool contract (including its progress
// totals) as a thin adapter over the shared queue/lifecycle implementation.
// The build supplies its own accounting below so schema-specific stats stay
// here, while callers that used runPool directly retain the old defaults.
function runPool(initialBatches, onResult, options = {}) {
  const poolSize = options.poolSize || DEFAULT_POOL_SIZE;
  const workerHeapMb = options.workerHeapMb || DEFAULT_WORKER_HEAP_MB;
  const defaults = {
    initialTotals: {
      parsed: 0, htmlLaws: 0, oversized: 0, files: 0, failures: 0, filesDone: 0, batchesDone: 0,
      workerHeapMb: 0, peakWorkerHeapMb: 0,
      parseMs: 0, insertMs: 0, lastParseMs: 0, lastInsertMs: 0, bytes: 0, lastBytes: 0,
    },
    accumulate: (running, shard, { callbackMs }) => {
      running.lastInsertMs = callbackMs;
      running.insertMs += callbackMs;
      if (shard.parseMs != null) {
        running.lastParseMs = shard.parseMs;
        running.parseMs += shard.parseMs;
      }
      running.lastBytes = shard.stats?.bytes || 0;
      for (const key of ["parsed", "htmlLaws", "oversized", "files", "bytes"]) running[key] += shard.stats?.[key] || 0;
      running.failures += shard.failures?.length || 0;
      running.filesDone += shard.stats?.files || 0;
      running.batchesDone += 1;
      if (shard.heapUsedMb != null) {
        running.workerHeapMb = shard.heapUsedMb;
        running.peakWorkerHeapMb = Math.max(running.peakWorkerHeapMb, shard.heapUsedMb);
      }
    },
    onWorkerFailure: (running, batch, error) => {
      if (!(error instanceof WorkerLossError)) throw error;
      onResult({
        units: [],
        failures: [{ celex: celexForCorpusFile(batch[0]), type: "worker_failure", error: String(error?.message || error) }],
        stats: { parsed: 0, htmlLaws: 0, oversized: 1, files: 1 },
      });
      running.failures += 1;
      running.filesDone += 1;
      running.batchesDone += 1;
    },
  };
  return runWorkerPool(initialBatches, onResult, {
    ...defaults,
    ...options,
    // The old adapter treated zero as "use the default"; retain that
    // behavior even though the shared runner accepts explicit sizes.
    poolSize,
    workerHeapMb,
    workerPath: options.workerPath || path.join(__dirname, "fulltext-index-worker.js"),
  });
}

// Universe = the acts present in the search cache (JSON or its .gz release
// asset) — the same gz-fallback read used across backend/search (e.g.
// build-sqlite-data.js's readJsonAsset, which this reuses directly).
function loadUniverseCelex(searchCachePath) {
  const asset = readJsonAsset(searchCachePath);
  const records = Array.isArray(asset.payload?.records) ? asset.payload.records : [];
  return new Set(records.map((record) => String(record.celex || "").trim().toUpperCase()).filter(Boolean));
}

async function buildFulltextIndex(options = {}) {
  const corpusDir = options.corpusDir || DEFAULT_CORPUS_DIR;
  const outputPath = options.outputPath === undefined ? DEFAULT_OUTPUT_PATH : options.outputPath;
  const searchCachePath = options.searchCachePath || DEFAULT_SEARCH_CACHE_PATH;
  const batchSize = options.batchSize || DEFAULT_BATCH_SIZE;
  const poolSize = options.pool || DEFAULT_POOL_SIZE;
  const workerHeapMb = options.workerHeapMb || DEFAULT_WORKER_HEAP_MB;
  const log = options.progress ? (options.log || console.log) : null;

  const universe = options.universe || loadUniverseCelex(searchCachePath);
  const allFiles = options.files || await listAllCorpusFiles(corpusDir, options);
  const files = dedupeCorpusFiles(filterCorpusFiles(allFiles, options))
    .filter((file) => universe.has(celexForCorpusFile(file)));
  if (log) log(`[fulltext] universe=${universe.size} acts; ${files.length} corpus files matched`);

  const db = openFulltextDatabase(outputPath);
  try {
    const doneCelex = new Set(db.prepare("SELECT DISTINCT celex FROM units").all().map((row) => row.celex));
    if (log && doneCelex.size) log(`[fulltext] resuming: ${doneCelex.size} acts already indexed, skipping them`);
    const pending = files.filter((file) => !doneCelex.has(celexForCorpusFile(file)));
    const batches = [];
    for (let i = 0; i < pending.length; i += batchSize) batches.push(pending.slice(i, i + batchSize));
    if (log) log(`[fulltext] ${pending.length} remaining acts in ${batches.length} batches, pool=${poolSize}`);

    const insertUnit = db.prepare("INSERT INTO units (celex, unit_type, number, heading, char_count, text) VALUES (?,?,?,?,?,?)");
    const insertFts = db.prepare("INSERT INTO units_fts (rowid, heading, text) VALUES (?,?,?)");
    const insertMany = db.transaction((units) => {
      for (const unit of units) {
        const info = insertUnit.run(unit.celex, unit.unit_type, unit.number, unit.heading, unit.text.length, unit.text);
        insertFts.run(info.lastInsertRowid, unit.heading, unit.text);
      }
    });

    const allFailures = [];
    const existingParserVersion = db.prepare(
      "SELECT value FROM fulltext_metadata WHERE key = 'parser_version'"
    ).get()?.value;
    // Units have no parser-version column, and doneCelex intentionally skips
    // existing acts. Preserve the metadata stamp for those rows before adding
    // versions from newly parsed shards; otherwise an incremental build lies
    // about the parser versions represented in the database.
    const parserVersions = new Set(normalizeParserStamp(existingParserVersion));
    const totals = await runPool(batches, (shard) => {
      insertMany(shard.units || []);
      for (const failure of shard.failures || []) allFailures.push(failure);
      if (shard.parserVersion != null) {
        for (const version of Array.isArray(shard.parserVersion) ? shard.parserVersion : [shard.parserVersion]) parserVersions.add(version);
      }
    }, {
      poolSize,
      workerHeapMb,
      onProgress: log ? (running) => log(
        `[fulltext] ${running.filesDone}/${pending.length} acts, ${running.parsed} parsed, ${running.failures} failures`
        + `, worker heap ${running.workerHeapMb}/${workerHeapMb} MB (peak ${running.peakWorkerHeapMb})`
        + `, wal ${walSizeMb(outputPath)} MB`
        + `, parse ${(running.parseMs / 1000).toFixed(1)}s insert ${(running.insertMs / 1000).toFixed(1)}s`
        + ` (last ${running.lastParseMs}/${running.lastInsertMs} ms)`
        + `, ${(running.bytes / 1048576).toFixed(0)} MB at ${kbPerSecond(running.lastBytes, running.lastParseMs)} KB/s`
      ) : undefined,
    });

    const unitCount = db.prepare("SELECT COUNT(*) n FROM units").get().n;
    const articleCount = db.prepare("SELECT COUNT(*) n FROM units WHERE unit_type='article'").get().n;
    const recitalCount = db.prepare("SELECT COUNT(*) n FROM units WHERE unit_type='recital'").get().n;
    const actCount = db.prepare("SELECT COUNT(DISTINCT celex) n FROM units").get().n;
    const versions = [...parserVersions].sort();
    const parserVersion = versions.length === 1 ? versions[0] : (versions.length ? versions.join(",") : null);
    const generatedAt = (options.now || (() => new Date()))().toISOString();

    // Metadata + PRAGMA user_version are written only here, as the very last
    // step after the pool has fully drained. An interrupted build (process
    // killed mid-run) never reaches this point, so legal-cache-store.js's
    // "metadata row missing" check correctly reports the artifact as
    // unavailable rather than serving a partial index; re-running the build
    // resumes via the doneCelex check above.
    const writeMetadata = db.transaction(() => {
      const upsert = db.prepare("INSERT INTO fulltext_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
      upsert.run("fulltext_version", String(FULLTEXT_SCHEMA_VERSION));
      upsert.run("parser_version", String(parserVersion));
      upsert.run("generated_at", generatedAt);
      upsert.run("unit_count", String(unitCount));
      upsert.run("article_count", String(articleCount));
      upsert.run("recital_count", String(recitalCount));
      upsert.run("act_count", String(actCount));
    });
    writeMetadata();
    db.pragma(`user_version = ${FULLTEXT_SCHEMA_VERSION}`);

    const summary = {
      unitCount, articleCount, recitalCount, actCount,
      parserVersion, generatedAt,
      newlyParsed: totals.parsed, failures: allFailures.length,
    };
    if (log) log(`[fulltext] done: ${unitCount} units (${articleCount} articles, ${recitalCount} recitals) across ${actCount} acts; ${allFailures.length} failures`);
    return summary;
  } finally {
    db.close();
  }
}

async function writeManifest(outputPath, summary, manifestPath = `${outputPath}.manifest.json`) {
  const stat = fs.statSync(outputPath);
  const manifest = {
    fulltextVersion: FULLTEXT_SCHEMA_VERSION,
    parserVersion: summary.parserVersion,
    generatedAt: summary.generatedAt,
    unitCount: summary.unitCount,
    articleCount: summary.articleCount,
    recitalCount: summary.recitalCount,
    actCount: summary.actCount,
    bytes: stat.size,
    sha256: sha256File(outputPath),
  };
  await writeArtifactAtomic(manifestPath, manifest);
  return manifest;
}

async function run(options = {}) {
  const outputPath = options.outputPath === undefined ? DEFAULT_OUTPUT_PATH : options.outputPath;
  const summary = await buildFulltextIndex(options);
  if (outputPath && options.writeManifest !== false) {
    summary.manifest = await writeManifest(outputPath, summary, options.manifestPath);
  }
  return summary;
}

function parseCliArgs(argv) {
  const options = {};
  const valueFlags = new Set(["--corpusDir", "--out", "--limit", "--fromYear", "--toYear", "--batchSize", "--pool", "--workerHeapMb"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!valueFlags.has(flag)) throw new Error(`Unknown argument: ${flag}`);
    const value = argv[index += 1];
    if (value == null) throw new Error(`Missing value for ${flag}`);
    if (flag === "--corpusDir") { options.corpusDir = value; continue; }
    if (flag === "--out") { options.outputPath = value; continue; }
    const number = Number.parseInt(value, 10);
    if (!Number.isInteger(number) || number < 0 || (["--limit", "--batchSize", "--pool", "--workerHeapMb"].includes(flag) && number === 0)) {
      throw new Error(`Invalid value for ${flag}: ${value}`);
    }
    options[{ "--limit": "limit", "--fromYear": "fromYear", "--toYear": "toYear", "--batchSize": "batchSize", "--pool": "pool", "--workerHeapMb": "workerHeapMb" }[flag]] = number;
  }
  return options;
}

if (require.main === module) {
  const options = parseCliArgs(process.argv.slice(2));
  run({ ...options, progress: true })
    .then((summary) => console.log(`Fulltext index: ${summary.unitCount} units across ${summary.actCount} acts`))
    .catch((error) => { console.error(error); process.exitCode = 1; });
}

module.exports = {
  DEFAULT_CORPUS_DIR,
  DEFAULT_OUTPUT_PATH,
  FULLTEXT_SCHEMA_VERSION,
  buildFulltextIndex,
  buildFulltextShard,
  loadUniverseCelex,
  openFulltextDatabase,
  parseCliArgs,
  run,
  runPool,
  writeManifest,
};
