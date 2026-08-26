// Offline, worker-recycled cross-reference audit for the local raw-law corpus.
//
// Unlike corpus-health.test.js, this command can scan every downloaded FMX and
// EUR-Lex HTML law without accumulating JSDOM objects in one process.
//
// Usage (from backend/):
//   node search/corpus-reference-audit.js
//   node search/corpus-reference-audit.js --maxPerCorpus 1000
//   node search/corpus-reference-audit.js --kind fmx --offset 10000 --limit 5000
//   node search/corpus-reference-audit.js --batchSize 100 --heapMb 2048

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");

const { parseFmxXml } = require("../shared/fmx-parser-node.js");
const { parseEurlexHtmlToCombined } = require("../shared/eurlex-html-parser.js");
const { DEFAULT_PROGRESS_FILE, recordAudit } = require("./corpus-audit-progress.js");
const { listCorpusFiles: listCorpusEntries } = require("./corpus-files");

const DATA_DIR = path.join(__dirname, "data");
const CORPORA = {
  fmx: { root: path.join(DATA_DIR, "laws"), extension: ".xml.gz" },
  html: { root: path.join(DATA_DIR, "laws-html"), extension: ".html.gz" },
};
// Keep aligned with search-build's DOM safety limit. The app intentionally
// leaves these raw FMX blobs available but does not parse them into a DOM.
const MAX_FMX_PARSE_BYTES = 6 * 1024 * 1024;

// Keep this tool independent of search-build: the audit parses raw law files
// directly and must not require optional search-index/database dependencies.
// The wrapper element still has to match search-build's `wrapForParsing`
// exactly — <COMBINED.FMX>, not <FMX.COLLECTION> — or the audit reports a
// different set of annexes than the builders it is auditing (see the comment
// on `wrapForParsing` in search-build.js).
function wrapForParsing(xml) {
  const withoutDecls = String(xml || "").replace(/<\?xml[\s\S]*?\?>/g, "").trim();
  return `<COMBINED.FMX>${withoutDecls}</COMBINED.FMX>`;
}

function hasExtractedText(parsed) {
  return [
    ...(parsed.articles || []).map((article) => article.article_html),
    ...(parsed.recitals || []).map((recital) => recital.recital_html),
    ...(parsed.annexes || []).map((annex) => annex.annex_html),
  ].some((html) => String(html || "").replace(/<[^>]+>/g, "").trim());
}

function listCorpusFiles({ root, extension }) {
  return listCorpusEntries({ root, extension }).map((entry) => entry.file);
}

function evenSample(files, cap) {
  if (!cap || files.length <= cap) return files;
  const step = files.length / cap;
  const sample = [];
  for (let index = 0; sample.length < cap; index += step) sample.push(files[Math.floor(index)]);
  return sample;
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
  return {
    scanned: 0,
    empty: 0,
    oversized: 0,
    errors: 0,
    refs: 0,
    externalInstitutional: 0,
    externalNational: 0,
    externalCaseLaw: 0,
    invalidInternalRefs: 0,
    invalidInternalAnchors: 0,
    explicitUnresolved: 0,
    missingResolvedTargets: 0,
    samples: [],
  };
}

function addSample(stats, text) {
  if (stats.samples.length < 12) stats.samples.push(text);
}

function inspectParsedLaw(parsed, file, stats, knownCelex) {
  const validArticles = new Set((parsed.articles || []).map((article) => String(article.article_number)));
  if (!hasExtractedText(parsed)) {
    stats.empty += 1;
    addSample(stats, `${path.basename(file)}: no searchable extracted text`);
  }

  for (const [location, refs] of Object.entries(parsed.crossReferences || {})) {
    for (const ref of refs || []) {
      stats.refs += 1;
      if (ref.type === "article" && !validArticles.has(String(ref.target))) {
        stats.invalidInternalRefs += 1;
        addSample(stats, `${path.basename(file)} ${location}: invalid Article ${ref.target}`);
      }
      if (ref.type === "external" && (ref.externalInstitutional || ref.externalNational || ref.nationalLaw || ref.externalCaseLaw || ref.treaty || ref.protocol)) {
        if (ref.externalInstitutional) stats.externalInstitutional += 1;
        if (ref.externalNational || ref.nationalLaw) stats.externalNational += 1;
        if (ref.externalCaseLaw) stats.externalCaseLaw += 1;
      } else if (ref.type === "external" && !ref.actCelex && !ref.contextual) {
        stats.explicitUnresolved += 1;
        addSample(stats, `${path.basename(file)} ${location}: unresolved ${ref.raw || ref.target || "external reference"}`);
      } else if (ref.type === "external" && ref.actCelex && /^3\d{4}[A-Z]\d{4}$/i.test(ref.actCelex) && !knownCelex.has(ref.actCelex)) {
        stats.missingResolvedTargets += 1;
        addSample(stats, `${path.basename(file)} ${location}: target absent from corpus ${ref.actCelex} (${ref.raw || ref.target})`);
      }
    }
  }

  const htmlBlocks = [
    ...(parsed.articles || []).map((article) => article.article_html),
    ...(parsed.recitals || []).map((recital) => recital.recital_html),
    ...(parsed.annexes || []).map((annex) => annex.annex_html),
  ];
  for (const html of htmlBlocks) {
    for (const match of String(html || "").matchAll(/<a\b(?=[^>]*\bclass="cross-ref")(?=[^>]*\bdata-ref-article="([^"]+)")[^>]*>/gi)) {
      if (!validArticles.has(match[1])) {
        stats.invalidInternalAnchors += 1;
        addSample(stats, `${path.basename(file)}: invalid Article ${match[1]} anchor`);
      }
    }
  }
}

async function auditFiles(kind, files, knownCelex = new Set()) {
  const stats = emptyStats();
  for (const file of files) {
    try {
      const raw = zlib.gunzipSync(fs.readFileSync(file)).toString("utf8");
      if (kind === "fmx" && raw.length > MAX_FMX_PARSE_BYTES) {
        stats.oversized += 1;
        addSample(stats, `${path.basename(file)}: skipped ${raw.length} byte FMX blob`);
        continue;
      }
      const parsed = kind === "fmx"
        ? await parseFmxXml(wrapForParsing(raw))
        : await parseEurlexHtmlToCombined(raw, "ENG");
      stats.scanned += 1;
      inspectParsedLaw(parsed, file, stats, knownCelex);
    } catch (error) {
      stats.errors += 1;
      addSample(stats, `${path.basename(file)}: ${error.message}`);
    }
  }
  return stats;
}

function mergeStats(target, source) {
  for (const key of ["scanned", "empty", "oversized", "errors", "refs", "externalInstitutional", "externalNational", "externalCaseLaw", "invalidInternalRefs", "invalidInternalAnchors", "explicitUnresolved", "missingResolvedTargets"]) {
    target[key] += source[key] || 0;
  }
  for (const sample of source.samples || []) addSample(target, sample);
  return target;
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

async function runWorker(options) {
  const files = JSON.parse(fs.readFileSync(options.listFile, "utf8"));
  const knownCelex = new Set(JSON.parse(fs.readFileSync(options.knownCelexFile, "utf8")));
  const stats = await auditFiles(options.kind, files, knownCelex);
  fs.writeFileSync(options.outFile, JSON.stringify(stats));
}

function runBatch(kind, files, { heapMb, tmpDir, index, knownCelex }) {
  const listFile = path.join(tmpDir, `${kind}-${index}.json`);
  const outFile = path.join(tmpDir, `${kind}-${index}.out.json`);
  const knownCelexFile = path.join(tmpDir, "known-celex.json");
  fs.writeFileSync(listFile, JSON.stringify(files));
  if (!fs.existsSync(knownCelexFile)) fs.writeFileSync(knownCelexFile, JSON.stringify([...knownCelex]));
  execFileSync(process.execPath, [
    `--max-old-space-size=${heapMb}`,
    __filename,
    "--worker",
    "--kind", kind,
    "--listFile", listFile,
    "--outFile", outFile,
    "--knownCelexFile", knownCelexFile,
  // Workers are intentionally retried in smaller batches after an OOM. Keep
  // their V8 diagnostics out of the parent stream; the audit reports the
  // affected file concisely if it still fails alone.
  ], { stdio: ["ignore", "ignore", "pipe"] });
  return JSON.parse(fs.readFileSync(outFile, "utf8"));
}

function runBatchWithFallback(kind, files, options) {
  try {
    return runBatch(kind, files, options);
  } catch (error) {
    // A few historical HTML documents are exceptionally large. Retry smaller
    // batches in fresh workers so one such document cannot abandon an
    // otherwise exhaustive audit. A lone failing document is reported as an
    // audit error rather than silently skipped.
    if (files.length === 1) {
      const stats = emptyStats();
      stats.errors = 1;
      addSample(stats, `${path.basename(files[0])}: worker failed: ${error.message.split("\n")[0]}`);
      return stats;
    }
    const midpoint = Math.ceil(files.length / 2);
    const left = runBatchWithFallback(kind, files.slice(0, midpoint), {
      ...options,
      index: `${options.index}-a`,
    });
    const right = runBatchWithFallback(kind, files.slice(midpoint), {
      ...options,
      index: `${options.index}-b`,
    });
    return mergeStats(left, right);
  }
}

async function auditCorpus(options = {}) {
  const batchSize = Number.parseInt(options.batchSize, 10) || 50;
  const heapMb = Number.parseInt(options.heapMb, 10) || 4096;
  const maxPerCorpus = Number.parseInt(options.maxPerCorpus, 10) || 0;
  const offset = Math.max(0, Number.parseInt(options.offset, 10) || 0);
  const limit = Math.max(0, Number.parseInt(options.limit, 10) || 0);
  const progressFile = options.progressFile || DEFAULT_PROGRESS_FILE;
  const requestedKinds = options.kind
    ? new Set(String(options.kind).split(",").map((kind) => kind.trim()).filter(Boolean))
    : null;
  const corpora = Object.entries(CORPORA).filter(([kind]) => !requestedKinds || requestedKinds.has(kind));
  if (!corpora.length || (requestedKinds && [...requestedKinds].some((kind) => !CORPORA[kind]))) {
    throw new Error("--kind must name fmx, html, or a comma-separated combination of both");
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-reference-audit-"));
  // A resolved sector-3 target should normally be present in at least one
  // downloaded-law representation. Keep this index separate from the slice
  // being audited so references to older/newer acts remain checkable.
  const knownCelex = new Set(Object.values(CORPORA)
    .flatMap((corpus) => listCorpusFiles(corpus))
    .map((file) => path.basename(file).replace(/\.(?:xml|html)\.gz$/i, "")));
  const result = {};
  try {
    for (const [kind, corpus] of corpora) {
      const allFiles = listCorpusFiles(corpus);
      const availableFiles = evenSample(filterByYears(allFiles, options.year), maxPerCorpus);
      const files = availableFiles.slice(offset, limit ? offset + limit : undefined);
      const years = [...new Set(files.map((file) => path.basename(path.dirname(file))))];
      const presentYears = new Set(availableFiles.map((file) => path.basename(path.dirname(file))));
      const emptyYears = requestedYears(options.year).filter((year) => !presentYears.has(year));
      const stats = emptyStats();
      for (let start = 0; start < files.length; start += batchSize) {
        mergeStats(stats, runBatchWithFallback(kind, files.slice(start, start + batchSize), {
          heapMb,
          tmpDir,
          index: start,
          knownCelex,
        }));
        console.log(`[corpus-reference-audit] ${kind} ${offset + Math.min(start + batchSize, files.length)}/${availableFiles.length}`);
      }
      result[kind] = { ...stats, available: allFiles.length, eligible: availableFiles.length, selected: files.length, offset };
      recordAudit({
        file: progressFile,
        kind,
        available: allFiles.length,
        offset,
        selected: files.length,
        stats,
        years,
        emptyYears,
        rangeStable: !options.year && !maxPerCorpus,
      });
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.worker) return runWorker(options);
  const result = await auditCorpus(options);
  const failures = Object.values(result).some((stats) => stats.invalidInternalRefs || stats.invalidInternalAnchors || stats.errors);
  if (failures) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}

module.exports = { auditCorpus, evenSample, filterByYears, listCorpusFiles, requestedYears };
