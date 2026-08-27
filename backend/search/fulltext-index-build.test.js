const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { EventEmitter } = require("node:events");

const {
  buildFulltextIndex,
  buildFulltextShard,
  openFulltextDatabase,
  parseCliArgs,
  runPool,
  writeManifest,
  DEFAULT_RECYCLE_BATCHES,
  FULLTEXT_SCHEMA_VERSION,
} = require("./fulltext-index-build");
const { getCurrentParserVersion } = require("./parser-stamp");

const FIXTURE_DIR = path.join(__dirname, "..", "shared", "__fixtures__", "corpus");

// buildFulltextIndex has no DI hook for parseXml/parseHtml (its worker pool
// always requires the real fulltext-index-worker.js, which in turn calls
// buildFulltextShard with only {files}), so DB-level integration tests below
// drive it with real, frozen corpus fixtures from
// shared/__fixtures__/corpus/ (the same ones corpus-fixtures.test.js parses)
// copied into a temp corpus tree under their CELEX-based filename —
// celexForCorpusFile derives the celex from the basename, so the fixture's
// own `<kind>-<era>-<CELEX>.<ext>` name has to be renamed first.
async function seedCorpusFile(dir, fixtureFile, celex, ext) {
  const destDir = path.join(dir, "laws");
  await fs.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, `${celex}.${ext}.gz`);
  await fs.copyFile(path.join(FIXTURE_DIR, fixtureFile), dest);
  return dest;
}

test("buildFulltextShard extracts article and recital units, skips annexes and empty text", async () => {
  const shard = await buildFulltextShard({
    files: ["/laws/2024/32024R0001.xml.gz"],
    readFile: async () => "<ACT />",
    wrapXml: (value) => value,
    parseXml: async () => ({
      parserVersion: 9,
      articles: [
        { article_number: "1", article_title: "<TI>Subject matter</TI>", article_html: "<P>This Regulation applies to widgets.</P>" },
        { article_number: "2", article_title: "", article_html: "" },
      ],
      recitals: [
        { recital_number: "1", recital_text: "Widgets are important for the internal market." },
        { recital_number: "2", recital_text: "" },
      ],
      annexes: [
        { annex_html: "<P>Annex content that must never be indexed.</P>" },
      ],
    }),
  });

  assert.equal(shard.stats.parsed, 1);
  assert.equal(shard.failures.length, 0);
  assert.equal(shard.units.length, 2);

  const article = shard.units.find((unit) => unit.unit_type === "article");
  assert.deepEqual(article, {
    celex: "32024R0001",
    unit_type: "article",
    number: "1",
    heading: "Subject matter",
    text: "This Regulation applies to widgets.",
  });

  const recital = shard.units.find((unit) => unit.unit_type === "recital");
  assert.deepEqual(recital, {
    celex: "32024R0001",
    unit_type: "recital",
    number: "1",
    heading: "",
    text: "Widgets are important for the internal market.",
  });

  // The empty-title/empty-html article and the empty-text recital produced no
  // rows; annex text is not routed into a unit at all.
  assert.equal(shard.units.some((unit) => unit.text.includes("Annex content")), false);
  assert.equal(shard.parserVersion, 9);
});

test("buildFulltextShard routes .html.gz files through parseHtml with the same unit shape", async () => {
  const shard = await buildFulltextShard({
    files: ["/laws-html/1998/31998L0001.html.gz"],
    readFile: async () => "<html>irrelevant, parseHtml is faked below</html>",
    parseXml: async () => { throw new Error("parseXml must not be called for an HTML corpus file"); },
    parseHtml: async () => ({
      parserVersion: 3,
      articles: [
        { article_number: "1", article_title: "Scope", article_html: "<p>Applies to legacy widgets.</p>" },
      ],
      recitals: [
        { recital_number: "1", recital_html: "<p>Recital body from HTML law.</p>" },
      ],
    }),
  });

  assert.equal(shard.stats.htmlLaws, 1);
  assert.equal(shard.failures.length, 0);
  assert.equal(shard.units.length, 2);
  assert.deepEqual(shard.units[0], {
    celex: "31998L0001",
    unit_type: "article",
    number: "1",
    heading: "Scope",
    text: "Applies to legacy widgets.",
  });
  assert.deepEqual(shard.units[1], {
    celex: "31998L0001",
    unit_type: "recital",
    number: "1",
    heading: "",
    text: "Recital body from HTML law.",
  });
});

test("oversized XML falls back to the stripped operative text when the fallback is safe", async () => {
  // No ANNEX markup at all: annexElementsOmitted stays 0, so the safety check
  // in buildFulltextShard rejects the fallback and records an oversized
  // failure — independent of what stripCompleteUppercaseAnnexes returns.
  const oversizedNoAnnex = "<ACT>" + "x".repeat(500) + "</ACT>";
  const rejected = await buildFulltextShard({
    files: ["/laws/2024/32024R0002.xml.gz"],
    readFile: async () => oversizedNoAnnex,
    maxXmlBytes: 50,
    parseXml: async () => { throw new Error("must not attempt to parse an unsafe fallback"); },
  });
  assert.equal(rejected.units.length, 0);
  assert.equal(rejected.failures.length, 1);
  assert.equal(rejected.failures[0].type, "oversized");
  assert.equal(rejected.stats.oversized, 1);

  // With a self-contained uppercase ANNEX as a sibling of <ACT> (the real FMX
  // shape — stripCompleteUppercaseAnnexes only strips annexes at actDepth 0,
  // i.e. outside the <ACT> element), stripping it away brings the operative
  // text safely under the byte cap, so the fallback is attempted and parsing
  // succeeds.
  const oversizedWithAnnex = "<ACT><ARTICLE>short body</ARTICLE></ACT><ANNEX>" + "y".repeat(500) + "</ANNEX>";
  const accepted = await buildFulltextShard({
    files: ["/laws/2024/32024R0003.xml.gz"],
    readFile: async () => oversizedWithAnnex,
    maxXmlBytes: 50,
    wrapXml: (value) => value,
    parseXml: async (wrapped) => {
      assert.equal(wrapped.includes("ANNEX"), false);
      return {
        parserVersion: 1,
        articles: [{ article_number: "1", article_title: "", article_html: "<P>Recovered operative text.</P>" }],
        recitals: [],
      };
    },
  });
  assert.equal(accepted.failures.length, 0);
  assert.equal(accepted.units.length, 1);
  assert.equal(accepted.units[0].text, "Recovered operative text.");
});

test("openFulltextDatabase creates the units/units_fts/fulltext_metadata schema", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fulltext-db-"));
  const outputPath = path.join(dir, "fulltext.sqlite");
  const db = openFulltextDatabase(outputPath);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((row) => row.name);
    assert.equal(tables.includes("units"), true);
    assert.equal(tables.includes("units_fts"), true);
    assert.equal(tables.includes("fulltext_metadata"), true);
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("openFulltextDatabase refuses to resume onto a file stamped with a different schema version", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fulltext-db-stale-"));
  const outputPath = path.join(dir, "fulltext.sqlite");
  const first = openFulltextDatabase(outputPath);
  first.pragma(`user_version = ${FULLTEXT_SCHEMA_VERSION + 1}`);
  first.close();

  try {
    assert.throws(() => openFulltextDatabase(outputPath), /schema version/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("openFulltextDatabase resumes onto a file whose user_version is still 0 (interrupted pre-stamp build)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fulltext-db-interrupted-"));
  const outputPath = path.join(dir, "fulltext.sqlite");
  const first = openFulltextDatabase(outputPath);
  first.close();

  const db = openFulltextDatabase(outputPath);
  try {
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 0);
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("buildFulltextIndex (real fixture, real worker pool) populates units + units_fts and stamps metadata/user_version on completion", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fulltext-build-"));
  const outputPath = path.join(dir, "fulltext.sqlite");
  const file = await seedCorpusFile(dir, "fmx-v4-2009-32009L0004.xml.gz", "32009L0004", "xml");

  const summary = await buildFulltextIndex({
    outputPath,
    files: [file],
    universe: new Set(["32009L0004"]),
    batchSize: 10,
    pool: 1,
    workerHeapMb: 256,
  });

  // Matches the fixture's frozen floor in corpus-fixtures.test.js
  // (minArticles: 4, minRecitals: 6).
  assert.ok(summary.articleCount >= 4);
  assert.ok(summary.recitalCount >= 6);
  assert.equal(summary.unitCount, summary.articleCount + summary.recitalCount);
  assert.equal(summary.actCount, 1);
  assert.equal(summary.failures, 0);

  const db = openFulltextDatabase(outputPath);
  try {
    const unitRows = db.prepare("SELECT * FROM units ORDER BY id").all();
    assert.equal(unitRows.length, summary.unitCount);
    for (const row of unitRows) {
      assert.equal(row.celex, "32009L0004");
      assert.equal(row.char_count, row.text.length);
      assert.ok(row.char_count > 0);
    }
    assert.equal(db.prepare("SELECT COUNT(*) n FROM units_fts").get().n, summary.unitCount);

    assert.equal(db.prepare("PRAGMA user_version").get().user_version, FULLTEXT_SCHEMA_VERSION);
    const metadata = new Map(db.prepare("SELECT key, value FROM fulltext_metadata").all().map((row) => [row.key, row.value]));
    assert.equal(metadata.get("fulltext_version"), String(FULLTEXT_SCHEMA_VERSION));
    assert.equal(metadata.get("unit_count"), String(summary.unitCount));
    assert.equal(metadata.get("act_count"), "1");
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("buildFulltextIndex resumes across two real invocations sharing a celex, without duplicating rows", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fulltext-resume-"));
  const outputPath = path.join(dir, "fulltext.sqlite");
  const first = await seedCorpusFile(dir, "fmx-v4-2009-32009L0004.xml.gz", "32009L0004", "xml");
  const second = await seedCorpusFile(dir, "fmx-v6-2024-32024D0190.xml.gz", "32024D0190", "xml");

  const firstSummary = await buildFulltextIndex({
    outputPath,
    files: [first],
    universe: new Set(["32009L0004"]),
    batchSize: 10,
    pool: 1,
    workerHeapMb: 256,
  });
  assert.equal(firstSummary.actCount, 1);
  assert.equal(firstSummary.newlyParsed, 1);

  const stampDb = openFulltextDatabase(outputPath);
  stampDb.prepare("UPDATE fulltext_metadata SET value = '21' WHERE key = 'parser_version'").run();
  stampDb.close();

  // Re-run over the superset [first, second]: first is already indexed and
  // must be skipped (row count for its celex stays the same, and the worker
  // pool never sees it as "newly parsed"), while second is newly ingested.
  const secondSummary = await buildFulltextIndex({
    outputPath,
    files: [first, second],
    universe: new Set(["32009L0004", "32024D0190"]),
    batchSize: 10,
    pool: 1,
    workerHeapMb: 256,
  });
  assert.equal(secondSummary.newlyParsed, 1, "the already-indexed act must not be re-parsed");
  assert.equal(secondSummary.actCount, 2);
  assert.equal(secondSummary.parserVersion, `21,${await getCurrentParserVersion()}`);

  const db = openFulltextDatabase(outputPath);
  try {
    const counts = db.prepare("SELECT celex, COUNT(*) n FROM units GROUP BY celex ORDER BY celex").all();
    assert.deepEqual(counts.map((row) => row.celex), ["32009L0004", "32024D0190"]);
    const firstCount = counts.find((row) => row.celex === "32009L0004").n;
    assert.equal(firstCount, firstSummary.unitCount, "resumed build must not duplicate the already-indexed act's units");
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("parseCliArgs accepts valid flags and rejects unknown/missing/invalid values", () => {
  assert.deepEqual(
    parseCliArgs(["--corpusDir", "/data/laws", "--out", "/tmp/fulltext.sqlite", "--limit", "5", "--fromYear", "2010", "--toYear", "2020", "--batchSize", "10", "--pool", "3", "--workerHeapMb", "512"]),
    {
      corpusDir: "/data/laws",
      outputPath: "/tmp/fulltext.sqlite",
      limit: 5,
      fromYear: 2010,
      toYear: 2020,
      batchSize: 10,
      pool: 3,
      workerHeapMb: 512,
    }
  );
  assert.throws(() => parseCliArgs(["--bogus"]), /Unknown argument/);
  assert.throws(() => parseCliArgs(["--limit"]), /Missing value/);
  assert.throws(() => parseCliArgs(["--batchSize", "0"]), /Invalid value/);
  assert.throws(() => parseCliArgs(["--pool", "-1"]), /Invalid value/);
  assert.throws(() => parseCliArgs(["--limit", "abc"]), /Invalid value/);
  // fromYear/toYear are allowed to be 0 (no "must be positive" carve-out for
  // those two flags), unlike limit/batchSize/pool/workerHeapMb.
  assert.deepEqual(parseCliArgs(["--fromYear", "0"]), { fromYear: 0 });
});

test("writeManifest writes sha256 + counts alongside the sqlite file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fulltext-manifest-"));
  const outputPath = path.join(dir, "fulltext.sqlite");
  const db = openFulltextDatabase(outputPath);
  db.close();

  const summary = {
    parserVersion: 5,
    generatedAt: "2026-01-01T00:00:00.000Z",
    unitCount: 4,
    articleCount: 2,
    recitalCount: 2,
    actCount: 2,
  };
  const manifestPath = path.join(dir, "fulltext.sqlite.manifest.json");
  const manifest = await writeManifest(outputPath, summary, manifestPath);

  assert.equal(manifest.fulltextVersion, FULLTEXT_SCHEMA_VERSION);
  assert.equal(manifest.parserVersion, 5);
  assert.equal(manifest.unitCount, 4);
  assert.equal(manifest.actCount, 2);
  assert.equal(typeof manifest.sha256, "string");
  assert.equal(manifest.sha256.length, 64);
  assert.equal(typeof manifest.bytes, "number");
  assert.ok(manifest.bytes > 0);

  const onDisk = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.deepEqual(onDisk, manifest);

  await fs.rm(dir, { recursive: true, force: true });
});

// The build decays badly within a dispatch and recovers across one (2,400 ->
// 32 acts/min over five hours, reset by a restart, on acts that got *smaller*
// -- run 32574996152). Whole-machine memory sampling cannot tell the two
// leading causes apart: a worker approaching its resourceLimits cap full-GCs
// on every batch while its RSS sits flat at the ceiling, and an unbounded WAL
// is likewise invisible in RSS. Both are per-dispatch state that a restart
// clears. So the progress line carries the worker's own isolate heap against
// its cap, and the WAL size beside it -- one dispatch then distinguishes them.
test("progress line reports the worker's isolate heap against its cap, the WAL size, and the parse/insert split", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fulltext-heaplog-"));
  const outputPath = path.join(dir, "fulltext.sqlite");
  const file = await seedCorpusFile(dir, "fmx-v4-2009-32009L0004.xml.gz", "32009L0004", "xml");
  const lines = [];

  try {
    await buildFulltextIndex({
      outputPath,
      files: [file],
      universe: new Set(["32009L0004"]),
      batchSize: 10,
      pool: 1,
      workerHeapMb: 256,
      progress: true,
      log: (line) => lines.push(String(line)),
    });

    const progress = lines.filter((line) => /\d+\/\d+ acts/.test(line));
    assert.ok(progress.length > 0, "expected at least one progress line");

    const match = /worker heap (\d+)\/(\d+) MB \(peak (\d+)\), wal (\d+) MB/.exec(progress.at(-1));
    assert.ok(match, `progress line lacks heap/wal figures: ${progress.at(-1)}`);

    const [, heapUsed, cap, peak, wal] = match.map(Number);
    // A real isolate always reports a non-zero heap; 0 would mean the worker
    // stopped sending the figure and the trace is silently useless.
    assert.ok(heapUsed > 0, "worker heap should be reported as non-zero");
    assert.equal(cap, 256, "cap should echo the configured workerHeapMb");
    assert.ok(peak >= heapUsed, "peak should be at least the latest sample");
    assert.ok(Number.isInteger(wal) && wal >= 0, "WAL size should be a non-negative integer");

    // The parse/insert split is the whole point of the line: without it a
    // decaying build cannot be attributed to the parallel half or to the
    // parent's serialized insert.
    const timing = /parse ([\d.]+)s insert ([\d.]+)s \(last (\d+)\/(\d+) ms\)/.exec(progress.at(-1));
    assert.ok(timing, `progress line lacks the parse/insert split: ${progress.at(-1)}`);
    const [, parseS, insertS, lastParse, lastInsert] = timing.map(Number);
    // Parsing a real corpus file is never instantaneous, so a zero here means
    // the worker stopped reporting parseMs rather than that it was fast.
    assert.ok(parseS > 0, "cumulative parse time should be non-zero");
    assert.ok(lastParse > 0, "last-batch parse time should be non-zero");
    assert.ok(insertS >= 0 && lastInsert >= 0, "insert timings should be non-negative");

    // MB/s is what separates "the acts got bigger" from "the process got
    // slower"; a zero here means the byte counter stopped being fed.
    const throughput = /(\d+) MB at (\d+) KB\/s/.exec(progress.at(-1));
    assert.ok(throughput, `progress line lacks parse throughput: ${progress.at(-1)}`);
    const [, totalMb, kbps] = throughput.map(Number);
    assert.ok(Number.isInteger(totalMb) && totalMb >= 0, "cumulative MB should be a non-negative integer");
    assert.ok(kbps > 0, "parse throughput should be positive");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// A worker that streams the whole corpus accumulates the HTML parser's
// per-act JSDOM retention, so this builder retires its workers periodically.
// d6f0062 had exactly that and 7766856 removed it on the mistaken premise
// that fmx-parser-node.js's shared-window recycling covered the HTML path;
// these two tests are the guard against a third round of that.
class RecycleFakeWorker extends EventEmitter {
  constructor(onPostMessage) {
    super();
    this.onPostMessage = onPostMessage;
    this.terminated = false;
    this.posts = 0;
  }

  postMessage(payload) {
    this.posts += 1;
    this.onPostMessage(payload);
  }

  terminate() {
    this.terminated = true;
    return Promise.resolve(0);
  }
}

function countWorkersOverBatches(batches, options) {
  const workers = [];
  const spawnWorker = () => {
    const worker = new RecycleFakeWorker(() => queueMicrotask(() => {
      worker.emit("message", { units: [], failures: [], stats: { parsed: 1, files: 1 } });
    }));
    workers.push(worker);
    return worker;
  };
  return runPool(batches, () => {}, { poolSize: 1, spawnWorker, ...options })
    .then(() => workers);
}

test("the fulltext builder recycles its workers by default", async () => {
  assert.ok(
    Number.isInteger(DEFAULT_RECYCLE_BATCHES) && DEFAULT_RECYCLE_BATCHES > 0,
    "recycling must stay on by default: this builder only runs as a full-corpus job",
  );

  // No recycleAfter passed: the adapter has to supply its own default, which
  // is the half 7766856 dropped.
  const long = Array.from({ length: DEFAULT_RECYCLE_BATCHES * 2 + 1 }, (_, index) => [`file-${index}`]);
  const defaulted = await countWorkersOverBatches(long, {});
  assert.equal(defaulted.length, 3, "two replacements across two full recycle intervals");
  assert.deepEqual(
    defaulted.map((worker) => worker.posts),
    [DEFAULT_RECYCLE_BATCHES, DEFAULT_RECYCLE_BATCHES, 1],
  );

  const batches = Array.from({ length: 6 }, (_, index) => [`file-${index}`]);
  const workers = await countWorkersOverBatches(batches, { recycleAfter: 2 });
  assert.equal(workers.length, 3, "one replacement per two completed batches");
  assert.deepEqual(workers.map((worker) => worker.posts), [2, 2, 2]);
  assert.deepEqual(workers.slice(0, -1).map((worker) => worker.terminated), [true, true]);
});

test("an explicit recycleBatches of 0 disables recycling rather than restoring the default", async () => {
  const batches = Array.from({ length: 6 }, (_, index) => [`file-${index}`]);
  const workers = await countWorkersOverBatches(batches, { recycleAfter: 0 });
  assert.equal(workers.length, 1, "zero means off, not 'use the default'");
  assert.equal(workers[0].posts, 6);

  assert.deepEqual(parseCliArgs(["--recycleBatches", "0"]), { recycleBatches: 0 });
  assert.deepEqual(parseCliArgs(["--recycleBatches", "10"]), { recycleBatches: 10 });
  assert.throws(() => parseCliArgs(["--recycleBatches", "-1"]), /Invalid value/);
});
