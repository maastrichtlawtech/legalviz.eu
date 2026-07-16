"use strict";

// Offline rebuild of the MiniSearch metadata cache (search-cache.json) from the
// already-downloaded local raw-law corpus (search/data/laws + laws-html).
//
// The normal builder (search-build.js) harvests via SPARQL and fetches every
// act from CELLAR/EUR-Lex. This script does the same enrichment (title +
// excerpt via the shared parsers) but purely from disk — no network at all — so
// it can extend the cache's year coverage back to the start of the corpus.
//
// Strategy:
//   - Reuse the existing 2010-2026 records verbatim (they carry a SPARQL-derived
//     precise date + eli that can't be reconstructed offline).
//   - Build pre-2010 additions from the corpus: title + excerpt from parsing the
//     gzipped source, metadata (celex/type/eli) derived deterministically. The
//     date is the precise work_date_document from the harvest-time sidecar
//     manifest (law-dates.json, written by search-build.js) when available,
//     otherwise null — the raw source on disk doesn't carry the date.
//   - Merge and dedup by CELEX (existing > FMX > HTML).
//
// FMX parsing uses jsdom, which leaks: a single process OOMs around ~500 parses.
// So parsing runs in short-lived child processes (this same file re-invoked with
// --worker), pooled `CONCURRENCY` at a time; each writes a partial JSON that the
// driver merges. `fetch` is hard-blocked in the worker so a corpus miss fails
// loudly instead of silently hitting the network.

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { spawn } = require("child_process");

const { readCorpusDates, normalizeCelexKey } = require("./law-corpus-dates.js");
const { enrichRecordsWithEurovoc } = require("./eurovoc-enrich.js");
const { enrichRecordsWithInForce } = require("./in-force-enrich.js");

const CORPUS_DIR = path.join(__dirname, "data");
const FMX_ROOT = path.join(CORPUS_DIR, "laws");
const HTML_ROOT = path.join(CORPUS_DIR, "laws-html");
const CACHE_PATH = path.join(CORPUS_DIR, "search-cache.json");
const BACKUP_PATH = path.join(CORPUS_DIR, "search-cache.json.bak");

// Stable work dir (not a fresh mkdtemp) so an interrupted run's parsed partials
// survive and are reused on the next run. Resume is keyed by CELEX coverage, not
// batch index, so it stays correct even if batch boundaries shift. Removed only
// after a fully successful build; override for tests/isolation.
const WORK_DIR = process.env.CORPUS_BUILD_WORKDIR || path.join(os.tmpdir(), "corpus-build-work");

// Everything strictly older than this comes from the corpus; this year and
// newer is reused from the existing cache as-is.
const REUSE_FROM_YEAR = 2010;

// Batch sizes chosen from measured RSS growth: FMX (jsdom, ~1.5GB at 300 parses)
// stays well under the ~500-parse OOM cliff; HTML leaks less.
// Env-overridable so a batch that OOMs on a cluster of unusually large docs can
// be retried with smaller batches (the parser's per-doc memory isn't fully
// released between files, so a few large docs in one batch can exceed the heap).
const FMX_BATCH = Number(process.env.CORPUS_BUILD_FMX_BATCH) || 300;
const HTML_BATCH = Number(process.env.CORPUS_BUILD_HTML_BATCH) || 500;
const CONCURRENCY = Number(process.env.CORPUS_BUILD_CONCURRENCY) || 3;
const WORKER_HEAP_MB = 4096;

const ELI_SEGMENT = { regulation: "reg", directive: "dir", decision: "dec" };

// ---------------------------------------------------------------------------
// Worker: parse a batch of corpus files into raw (pre-enrichment) records.
// ---------------------------------------------------------------------------

async function runWorker(variant, batchPath, outPath) {
  // Zero-network guarantee: any accidental fetch (e.g. a corpus miss falling
  // back to the network) throws instead of silently scraping EUR-Lex.
  global.fetch = () => {
    throw new Error("NETWORK BLOCKED (offline corpus build)");
  };

  const {
    buildExcerptFromCombined,
    extractOfficialTitleAndExcerpt,
    extractTitleFromEurlexHtml,
  } = require("./search-build.js");
  const { parseEurlexHtmlToCombined } = require("../shared/eurlex-html-parser.js");

  const batch = JSON.parse(fs.readFileSync(batchPath, "utf8"));
  const records = [];

  for (const { celex, file } of batch) {
    let title = null;
    let excerpt = "";
    let ok = false;
    try {
      if (variant === "fmx") {
        // Corpus-first title+excerpt: reads laws/<year>/<celex>.xml.gz from disk,
        // uses the regex title extractor (combined.title is unreliable for FMX).
        const res = await extractOfficialTitleAndExcerpt(celex, {
          corpusDir: CORPUS_DIR,
          useCorpus: true,
        });
        title = res.title || null;
        excerpt = res.excerpt || "";
        ok = true;
      } else {
        const raw = zlib.gunzipSync(fs.readFileSync(file)).toString("utf8");
        const combined = await parseEurlexHtmlToCombined(raw, "ENG");
        title = combined.title || extractTitleFromEurlexHtml(raw) || null;
        excerpt = buildExcerptFromCombined(combined) || "";
        ok = true;
      }
    } catch (error) {
      records.push({
        celex,
        title: null,
        date: null,
        eli: buildPrimaryEli(celex),
        type: inferType(celex),
        fmxAvailable: false,
        fmxUnavailable: variant === "html",
        enrichError: String(error.message || error).slice(0, 300),
        excerpt: "",
      });
      continue;
    }

    records.push({
      celex,
      title,
      date: null,
      eli: buildPrimaryEli(celex),
      type: inferType(celex),
      fmxAvailable: variant === "fmx" && ok,
      fmxUnavailable: variant === "html",
      enrichError: null,
      excerpt,
    });
  }

  // Atomic write: a SIGKILL (e.g. OS memory pressure) mid-write must not leave a
  // truncated partial that a resume would read as valid coverage.
  const tmp = `${outPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records));
  fs.renameSync(tmp, outPath);
}

// All CELEX ids covered by partials already written to the work dir — the resume
// key. Corrupt/half-written partials are ignored (those celexes get redone).
function loadParsedCelexes(workDir) {
  const parsed = new Set();
  if (!fs.existsSync(workDir)) return parsed;
  for (const f of fs.readdirSync(workDir)) {
    if (!/-out-.*\.json$/.test(f)) continue;
    try {
      const arr = JSON.parse(fs.readFileSync(path.join(workDir, f), "utf8"));
      for (const rec of arr) {
        const key = normCelex(rec.celex);
        if (key) parsed.add(key);
      }
    } catch { /* ignore corrupt partial */ }
  }
  return parsed;
}

// Deterministic metadata from the CELEX id (offline substitutes for SPARQL).
function inferType(celex) {
  const marker = String(celex || "")[5];
  if (marker === "R") return "regulation";
  if (marker === "L") return "directive";
  if (marker === "D") return "decision";
  return "unknown";
}

function buildPrimaryEli(celex) {
  const match = String(celex || "").match(/^3(\d{4})([RLD])0*(\d{1,4})/);
  if (!match) return null;
  const type = inferType(celex);
  const segment = ELI_SEGMENT[type];
  if (!segment) return null;
  const year = match[1];
  const number = String(Number.parseInt(match[3], 10));
  return `http://data.europa.eu/eli/${segment}/${year}/${number}/oj`;
}

// ---------------------------------------------------------------------------
// Driver.
// ---------------------------------------------------------------------------

function normCelex(celex) {
  return String(celex || "").trim().toUpperCase();
}

function listCorpusFiles(root, ext, maxYearExclusive) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const year of fs.readdirSync(root).filter((d) => /^\d{4}$/.test(d)).sort()) {
    if (Number(year) >= maxYearExclusive) continue;
    for (const f of fs.readdirSync(path.join(root, year))) {
      if (!f.endsWith(ext)) continue;
      out.push({ celex: f.slice(0, -ext.length), file: path.join(root, year, f) });
    }
  }
  return out;
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function spawnWorker(variant, batchPath, outPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [`--max-old-space-size=${WORKER_HEAP_MB}`, __filename, "--worker", variant, batchPath, outPath],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`worker exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

async function runPool(jobs, concurrency) {
  let next = 0;
  let done = 0;
  const failed = [];
  const total = jobs.length;
  async function worker() {
    while (next < jobs.length) {
      const i = next++;
      try {
        await jobs[i].run();
      } catch (error) {
        failed.push({ job: jobs[i].label, error: error.message });
        console.error(`[corpus-build] FAILED ${jobs[i].label}: ${error.message}`);
      }
      done++;
      if (done % 10 === 0 || done === total) {
        console.log(`[corpus-build] ${done}/${total} batches complete`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return failed;
}

async function driver({ noEurovoc = false, noInForce = false } = {}) {
  const t0 = Date.now();
  const { enrichSearchRecord } = require("./search-ranking.js");

  if (!fs.existsSync(CACHE_PATH)) throw new Error(`Existing cache not found at ${CACHE_PATH}`);
  const existing = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  const existingRecords = Array.isArray(existing.records) ? existing.records : [];
  const seen = new Set(existingRecords.map((r) => normCelex(r.celex)).filter(Boolean));
  console.log(`[corpus-build] Existing cache: ${existingRecords.length} records`);

  // Resume: reuse partials from a previous (possibly interrupted) run. Keyed by
  // CELEX coverage so it's correct regardless of how batches are chunked.
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const alreadyParsed = loadParsedCelexes(WORK_DIR);
  if (alreadyParsed.size) {
    console.log(`[corpus-build] Resume: ${alreadyParsed.size} records already parsed in ${WORK_DIR}`);
  }

  // FMX first (preferred), then HTML only for celexes not covered by FMX.
  const fmxAll = listCorpusFiles(FMX_ROOT, ".xml.gz", REUSE_FROM_YEAR);
  const fmxJobs = [];
  const fmxSeen = new Set();
  for (const item of fmxAll) {
    const key = normCelex(item.celex);
    if (seen.has(key) || fmxSeen.has(key) || alreadyParsed.has(key)) continue;
    fmxSeen.add(key);
    fmxJobs.push(item);
  }

  const htmlAll = listCorpusFiles(HTML_ROOT, ".html.gz", REUSE_FROM_YEAR);
  const htmlJobs = [];
  const htmlSeen = new Set();
  for (const item of htmlAll) {
    const key = normCelex(item.celex);
    if (seen.has(key) || fmxSeen.has(key) || htmlSeen.has(key) || alreadyParsed.has(key)) continue;
    htmlSeen.add(key);
    htmlJobs.push(item);
  }

  console.log(`[corpus-build] Pre-${REUSE_FROM_YEAR} still to build: FMX=${fmxJobs.length} HTML=${htmlJobs.length}`);

  // This run's partials go into the shared WORK_DIR under a unique run id so they
  // never collide with partials carried over from an earlier interrupted run.
  const runId = Date.now().toString(36);
  const jobs = [];

  const fmxBatches = chunk(fmxJobs, FMX_BATCH);
  fmxBatches.forEach((batch, idx) => {
    const batchPath = path.join(WORK_DIR, `fmx-batch-${runId}-${idx}.json`);
    const outPath = path.join(WORK_DIR, `fmx-out-${runId}-${idx}.json`);
    fs.writeFileSync(batchPath, JSON.stringify(batch));
    jobs.push({ label: `fmx#${idx}`, run: () => spawnWorker("fmx", batchPath, outPath) });
  });

  const htmlBatches = chunk(htmlJobs, HTML_BATCH);
  htmlBatches.forEach((batch, idx) => {
    const batchPath = path.join(WORK_DIR, `html-batch-${runId}-${idx}.json`);
    const outPath = path.join(WORK_DIR, `html-out-${runId}-${idx}.json`);
    fs.writeFileSync(batchPath, JSON.stringify(batch));
    jobs.push({ label: `html#${idx}`, run: () => spawnWorker("html", batchPath, outPath) });
  });

  console.log(`[corpus-build] Spawning ${jobs.length} worker batches, concurrency=${CONCURRENCY}`);
  const failed = await runPool(jobs, CONCURRENCY);

  // Precise dates harvested from SPARQL (work_date_document), persisted by
  // search-build.js at harvest time. Overlay them onto the corpus records (the
  // offline worker has no date). A CELEX missing from the manifest keeps its
  // null date until the next harvest populates it.
  const corpusDates = readCorpusDates(CORPUS_DIR);
  let preciseDates = 0;

  // Collect ALL partials in the work dir (this run + any carried over from an
  // interrupted run), enrich to the canonical record shape. Dedup by CELEX
  // happens in the merge below, so overlap between partials is harmless.
  const newRecords = [];
  for (const f of fs.readdirSync(WORK_DIR)) {
    if (!/-out-.*\.json$/.test(f)) continue;
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(WORK_DIR, f), "utf8")); }
    catch { continue; } // skip a corrupt/half-written partial
    for (const rec of raw) {
      const enriched = enrichSearchRecord(rec);
      const precise = corpusDates[normalizeCelexKey(enriched.celex)];
      if (precise) {
        enriched.date = precise;
        preciseDates += 1;
      }
      newRecords.push(enriched);
    }
  }
  console.log(`[corpus-build] Parsed ${newRecords.length} corpus records (${preciseDates} with precise SPARQL dates, ${failed.length} batches failed this run)`);

  // Merge: existing (as-is) + new, dedup by CELEX (existing wins), primary only.
  const merged = [];
  const mergedSeen = new Set();
  const push = (rec) => {
    const key = normCelex(rec.celex);
    if (!key || mergedSeen.has(key)) return;
    mergedSeen.add(key);
    merged.push(rec);
  };
  for (const rec of existingRecords) push(rec);
  for (const rec of newRecords) {
    if (!rec.isPrimaryAct) continue;
    push(rec);
  }

  // Same ordering as buildSearchCache: newest first, records without a date
  // (corpus acts missing from the manifest) last.
  merged.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));

  const years = merged.map((r) => Number(r.celexYear)).filter((y) => Number.isFinite(y));
  const payload = {
    generatedAt: new Date().toISOString(),
    fromYear: years.length ? Math.max(...years) : existing.fromYear,
    toYear: years.length ? Math.min(...years) : existing.toYear,
    count: merged.length,
    records: merged,
  };

  // EuroVoc topics and in-force status are SPARQL metadata, so — like the dates
  // overlaid above — they can't be reconstructed from disk. These are the only
  // network calls in an otherwise offline build, and they run *here in the
  // driver*: the workers keep their hard `fetch` block, so a corpus miss still
  // fails loudly instead of silently scraping. Skip them with --no-eurovoc /
  // --no-in-force for a genuinely offline run.
  //
  // It runs as part of the build rather than as a follow-up pass because a
  // CELEX-keyed sidecar bolted on afterwards strands every record it never saw,
  // silently (see eurovoc-enrich.js). Best-effort: topics never fail a build.
  if (noEurovoc) {
    console.log("[corpus-build] EuroVoc enrichment skipped (--no-eurovoc)");
  } else {
    try {
      const stats = await enrichRecordsWithEurovoc(payload.records, {
        log: (message) => console.log(`[corpus-build] [eurovoc] ${message}`),
      });
      console.log(`[corpus-build] EuroVoc: ${stats.withLabels} records with topics (${stats.fromJournal} from journal, ${stats.fetched} fetched)`);
    } catch (error) {
      console.log(`[corpus-build] EuroVoc enrichment failed, cache ships without topics: ${error.message}`);
    }
  }

  if (noInForce) {
    console.log("[corpus-build] In-force enrichment skipped (--no-in-force)");
  } else {
    try {
      const stats = await enrichRecordsWithInForce(payload.records, {
        log: (message) => console.log(`[corpus-build] [in-force] ${message}`),
      });
      console.log(`[corpus-build] In-force: ${stats.withStatus} records with status, ${stats.inForce} in force (${stats.fromJournal} from journal, ${stats.fetched} fetched)`);
    } catch (error) {
      console.log(`[corpus-build] In-force enrichment failed, cache ships without status: ${error.message}`);
    }
  }

  // Back up the old cache, then write the new one atomically.
  if (fs.existsSync(CACHE_PATH) && !fs.existsSync(BACKUP_PATH)) {
    fs.copyFileSync(CACHE_PATH, BACKUP_PATH);
    console.log(`[corpus-build] Backed up existing cache -> ${BACKUP_PATH}`);
  }
  const tmpCache = `${CACHE_PATH}.tmp`;
  fs.writeFileSync(tmpCache, `${JSON.stringify(payload, null, 2)}\n`);
  fs.renameSync(tmpCache, CACHE_PATH);

  // Keep the work dir if anything failed this run, so a re-run resumes and
  // retries only the still-missing celexes; clear it only on a clean build.
  if (failed.length === 0) {
    await fsp.rm(WORK_DIR, { recursive: true, force: true });
  } else {
    console.log(`[corpus-build] Kept ${WORK_DIR} for resume (${failed.length} batches failed)`);
  }

  const withExcerpt = merged.filter((r) => r.excerpt && r.excerpt.length > 0).length;
  const dt = ((Date.now() - t0) / 1000).toFixed(0);
  console.log("[corpus-build] DONE");
  console.log(`  records:      ${payload.count}`);
  console.log(`  with excerpt: ${withExcerpt} (${((withExcerpt / payload.count) * 100).toFixed(1)}%)`);
  console.log(`  year range:   ${payload.toYear}-${payload.fromYear}`);
  console.log(`  runtime:      ${dt}s`);
  if (failed.length) console.log(`  failed batches: ${failed.length}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--worker") {
    const [, variant, batchPath, outPath] = args;
    await runWorker(variant, batchPath, outPath);
    return;
  }
  await driver({
    noEurovoc: args.includes("--no-eurovoc"),
    noInForce: args.includes("--no-in-force"),
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { buildPrimaryEli, inferType, listCorpusFiles };
