// Offline pass: parse the harvested judgment HTML corpus
// (search/data/case-law/<year>/<CELEX>.html.gz) into structured details
// (name + operative declarations + article citations) and merge them into the
// case-law cache (law-cache/case-law-cache-v5.json). NO NETWORK — this reuses
// exactly the same parser the live enrichment uses (parseCaseDetailsFromHtml in
// shared/law-queries.js), just fed from local files.
//
// JSDOM leaks memory, so parsing runs in recycled child WORKER processes (a few
// hundred judgments each) rather than one long-lived process that would OOM
// around ~500 parses. Resumable + incremental: the cache is saved after every
// batch, and judgments already parsed at the current CITATION_PARSER_VERSION are
// skipped, so a re-run only does new/stale work.
//
// Usage (from backend/):
//   node search/case-law-parse.js                 # parse whatever's new/stale
//   node search/case-law-parse.js --force         # re-parse the whole corpus
//   node search/case-law-parse.js --batchSize 300 --heapMb 4096

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const os = require("os");
const { execFileSync } = require("child_process");

const {
  parseCaseDetailsFromHtml,
  loadCaseLawCache,
  saveCaseLawCache,
  CITATION_PARSER_VERSION,
} = require("../shared/law-queries");

const DATA_DIR = path.join(__dirname, "data");
const CASE_LAW_CORPUS = path.join(DATA_DIR, "case-law");
const DEFAULT_CACHE_DIR = path.join(__dirname, "..", "law-cache");

function celexFromFile(file) {
  return path.basename(file).replace(/\.html\.gz$/i, "");
}

// Walk case-law/<year>/*.html.gz -> [{ celex, file }].
function listCorpusJudgments(corpusDir = CASE_LAW_CORPUS) {
  const out = [];
  if (!fs.existsSync(corpusDir)) return out;
  for (const year of fs.readdirSync(corpusDir).filter((d) => /^\d{4}$/.test(d)).sort()) {
    const yearDir = path.join(corpusDir, year);
    for (const f of fs.readdirSync(yearDir)) {
      if (f.endsWith(".html.gz")) out.push({ celex: celexFromFile(f), file: path.join(yearDir, f) });
    }
  }
  return out;
}

function needsParse(entry, force) {
  if (force) return true;
  return !entry || entry.citationParserVersion !== CITATION_PARSER_VERSION;
}

// An unparseable/too-short file still gets a versioned stub so it is not retried
// on every run.
function emptyEntry() {
  return {
    name: null,
    declarations: [],
    articlesCited: [],
    articleRefs: [],
    citationParserVersion: CITATION_PARSER_VERSION,
  };
}

// ---- worker mode: parse a batch of files, write {celex: details|null} JSON ----
function runWorker(listFile, outFile) {
  const files = fs.readFileSync(listFile, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  const result = {};
  for (const file of files) {
    const celex = celexFromFile(file);
    try {
      const html = zlib.gunzipSync(fs.readFileSync(file)).toString("utf8");
      result[celex] = parseCaseDetailsFromHtml(html); // may be null
    } catch (err) {
      result[celex] = { __error: String(err && err.message || err).slice(0, 200) };
    }
  }
  fs.writeFileSync(outFile, JSON.stringify(result), "utf8");
}

// ---- orchestrator mode ----
async function parseCaseLawCorpus(options = {}) {
  const force = Boolean(options.force);
  const batchSize = Number.parseInt(options.batchSize, 10) > 0 ? Number.parseInt(options.batchSize, 10) : 400;
  const heapMb = Number.parseInt(options.heapMb, 10) > 0 ? Number.parseInt(options.heapMb, 10) : 4096;
  const cacheDir = options.cacheDir || DEFAULT_CACHE_DIR;
  const corpusDir = options.corpusDir || CASE_LAW_CORPUS;
  const log = (m) => console.log(`[case-law-parse] ${m}`);

  const all = listCorpusJudgments(corpusDir);
  if (all.length === 0) {
    log(`no judgment corpus at ${corpusDir} — run the harvest first`);
    return { total: 0, parsed: 0, withRefs: 0, empty: 0, errors: 0, skipped: 0 };
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  const cache = loadCaseLawCache(cacheDir);

  const todo = all.filter(({ celex }) => needsParse(cache[celex], force));
  const skipped = all.length - todo.length;
  log(`corpus ${all.length} judgments; ${todo.length} to parse, ${skipped} already at v${CITATION_PARSER_VERSION}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "caselaw-parse-"));
  const stats = { total: all.length, parsed: 0, withRefs: 0, empty: 0, errors: 0, skipped };
  const errorSamples = [];

  try {
    for (let start = 0; start < todo.length; start += batchSize) {
      const batch = todo.slice(start, start + batchSize);
      const listFile = path.join(tmpDir, `batch-${start}.list`);
      const outFile = path.join(tmpDir, `batch-${start}.json`);
      fs.writeFileSync(listFile, batch.map((b) => b.file).join("\n"), "utf8");

      // Recycled child process so JSDOM's leak is bounded per batch.
      execFileSync(
        process.execPath,
        [`--max-old-space-size=${heapMb}`, __filename, "--worker", "--listFile", listFile, "--outFile", outFile],
        { stdio: ["ignore", "ignore", "inherit"] },
      );

      const parsed = JSON.parse(fs.readFileSync(outFile, "utf8"));
      for (const [celex, details] of Object.entries(parsed)) {
        if (details && details.__error) {
          stats.errors += 1;
          if (errorSamples.length < 10) errorSamples.push(`${celex}: ${details.__error}`);
          continue;
        }
        if (!details) {
          cache[celex] = { ...(cache[celex] || {}), ...emptyEntry() };
          stats.empty += 1;
          continue;
        }
        cache[celex] = { ...(cache[celex] || {}), ...details };
        stats.parsed += 1;
        if (Array.isArray(details.articleRefs) && details.articleRefs.length > 0) stats.withRefs += 1;
      }

      // Persist after every batch: resumable + crash-safe.
      saveCaseLawCache(cacheDir, cache);
      fs.rmSync(listFile, { force: true });
      fs.rmSync(outFile, { force: true });
      log(`${Math.min(start + batchSize, todo.length)}/${todo.length}  parsed=${stats.parsed} withRefs=${stats.withRefs} empty=${stats.empty} errors=${stats.errors}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  log(`Done: ${stats.parsed} parsed (${stats.withRefs} with article refs), ${stats.empty} empty, ${stats.errors} errors, ${stats.skipped} skipped`);
  if (errorSamples.length) log(`error samples: ${errorSamples.join(" | ")}`);
  return stats;
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) { options[key] = true; }
    else { options[key] = next; i += 1; }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.worker) {
    runWorker(options.listFile, options.outFile);
    return;
  }
  await parseCaseLawCorpus(options);
}

if (require.main === module) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { parseCaseLawCorpus, listCorpusJudgments, celexFromFile, needsParse };
