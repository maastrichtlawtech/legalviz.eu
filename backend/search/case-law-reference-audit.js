// Read-only cross-reference audit for the downloaded case-law corpus.
//
// Uses short-lived workers because JSDOM accumulates memory while parsing old
// EUR-Lex judgment HTML. Unlike case-law-parse, this never writes a cache.
//
// Usage:
//   node search/case-law-reference-audit.js
//   node search/case-law-reference-audit.js --offset 2000 --limit 500
//   node search/case-law-reference-audit.js --output /tmp/case-law-audit.json

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");

const { parseCaseDetailsFromHtml } = require("../shared/law-queries");
const { DEFAULT_PROGRESS_FILE, recordAudit } = require("./corpus-audit-progress.js");
const { listCorpusFiles } = require("./corpus-files");

const CORPUS_DIR = path.join(__dirname, "data", "case-law");

function listCorpusJudgments(corpusDir = CORPUS_DIR) {
  return listCorpusFiles({ root: corpusDir, extension: ".html.gz" }).map((entry) => entry.file);
}

function filterByYears(files, value) {
  if (!value) return files;
  const years = new Set(String(value).split(",").map((year) => year.trim()).filter((year) => /^\d{4}$/.test(year)));
  return files.filter((file) => years.has(path.basename(path.dirname(file))));
}

function requestedYears(value) {
  if (!value) return [];
  return [...new Set(String(value).split(",").map((year) => year.trim()).filter((year) => /^\d{4}$/.test(year)))];
}

function emptyStats() {
  return { scanned: 0, empty: 0, errors: 0, refs: 0, unresolved: 0, contextual: 0, externalConvention: 0, samples: [] };
}

function addSample(stats, sample) {
  if (stats.samples.length < 12) stats.samples.push(sample);
}

function inspect(file, details, stats) {
  stats.scanned += 1;
  if (!details) {
    stats.empty += 1;
    return;
  }
  for (const ref of details.articleRefs || []) {
    stats.refs += 1;
    if (ref.contextual) stats.contextual += 1;
    if (ref.externalConvention) stats.externalConvention += 1;
    if (!ref.actCelex && !ref.contextual && !ref.externalConvention) {
      stats.unresolved += 1;
      addSample(stats, `${path.basename(file)}: ${ref.raw || `Article ${ref.article} of ${ref.act}`}`);
    }
  }
}

function mergeStats(target, source) {
  for (const key of ["scanned", "empty", "errors", "refs", "unresolved", "contextual", "externalConvention"]) target[key] += source[key] || 0;
  for (const sample of source.samples || []) addSample(target, sample);
  return target;
}

function runWorker(listFile, outFile) {
  const stats = emptyStats();
  for (const file of fs.readFileSync(listFile, "utf8").split("\n").filter(Boolean)) {
    try {
      const html = zlib.gunzipSync(fs.readFileSync(file)).toString("utf8");
      inspect(file, parseCaseDetailsFromHtml(html), stats);
    } catch (error) {
      stats.errors += 1;
      addSample(stats, `${path.basename(file)}: ${error.message}`);
    }
  }
  fs.writeFileSync(outFile, JSON.stringify(stats));
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) options[key] = true;
    else { options[key] = next; index += 1; }
  }
  return options;
}

function audit(options = {}) {
  const all = listCorpusJudgments();
  const offset = Math.max(0, Number.parseInt(options.offset, 10) || 0);
  const limit = Math.max(0, Number.parseInt(options.limit, 10) || 0);
  const batchSize = Math.max(1, Number.parseInt(options.batchSize, 10) || 50);
  const heapMb = Math.max(256, Number.parseInt(options.heapMb, 10) || 2048);
  const eligible = filterByYears(all, options.year);
  const files = eligible.slice(offset, limit ? offset + limit : undefined);
  const years = [...new Set(files.map((file) => path.basename(path.dirname(file))))];
  const presentYears = new Set(eligible.map((file) => path.basename(path.dirname(file))));
  const emptyYears = requestedYears(options.year).filter((year) => !presentYears.has(year));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "case-law-reference-audit-"));
  const stats = emptyStats();
  try {
    for (let start = 0; start < files.length; start += batchSize) {
      const listFile = path.join(tmpDir, `${start}.list`);
      const outFile = path.join(tmpDir, `${start}.json`);
      fs.writeFileSync(listFile, files.slice(start, start + batchSize).join("\n"));
      execFileSync(process.execPath, [`--max-old-space-size=${heapMb}`, __filename, "--worker", "--listFile", listFile, "--outFile", outFile], { stdio: "ignore" });
      mergeStats(stats, JSON.parse(fs.readFileSync(outFile, "utf8")));
      console.log(`[case-law-reference-audit] ${offset + Math.min(start + batchSize, files.length)}/${eligible.length}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  const result = { ...stats, available: all.length, eligible: eligible.length, selected: files.length, offset };
  recordAudit({
    file: options.progressFile || DEFAULT_PROGRESS_FILE,
    kind: "caseLaw",
    available: all.length,
    offset,
    selected: files.length,
    stats,
    years,
    emptyYears,
    rangeStable: !options.year,
  });
  if (options.output) fs.writeFileSync(options.output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  if (options.worker) runWorker(options.listFile, options.outFile);
  else audit(options);
}

module.exports = { audit, inspect, listCorpusJudgments };
