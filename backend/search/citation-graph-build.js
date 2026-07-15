const fs = require("fs/promises");
const path = require("path");
const zlib = require("zlib");
const { promisify } = require("util");
const { Worker } = require("worker_threads");

const gunzip = promisify(zlib.gunzip);
const { GRAPH_VERSION } = require("./citation-graph-store");
// This is intentionally lower than search-build's excerpt guard. A corpus run
// showed that 31993R2454 (2.97 MiB decompressed, 125 annexes) could exhaust a
// 4 GiB heap during full cross-reference parsing before the old 6 MiB guard
// applied. At 1 MiB, annex stripping recovers most large acts while keeping
// both full-DOM and operative-only parses within the empirically safe bound.
const DEFAULT_MAX_XML_BYTES = 1 * 1024 * 1024;
// EUR-Lex HTML renditions carry no annexes to strip, so an oversized one has no
// operative-only fallback — it is simply skipped. The bound is looser than the FMX
// one because the HTML parser builds a single DOM rather than a full Formex tree.
const DEFAULT_MAX_HTML_BYTES = 4 * 1024 * 1024;
const DEFAULT_PROGRESS_INTERVAL = 500;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_WORKER_HEAP_MB = 768;
const DEFAULT_CORPUS_DIR = path.join(__dirname, "data", "laws");
const DEFAULT_CITATION_GRAPH_PATH = process.env.CITATION_GRAPH_PATH || path.join(__dirname, "data", "citation-graph.json");

function clean(value) {
  if (value == null) return null;
  return String(value).trim() || null;
}

function normalizeCelex(value) {
  return clean(value)?.toUpperCase() || null;
}

function edgeKey(edge) {
  return [edge.kind, edge.sourceCelex, edge.sourceUnitType, edge.sourceUnit,
    edge.targetCelex, edge.targetArticle, edge.targetParagraph, edge.targetPoint]
    .map((value) => value == null ? "" : value).join("|");
}

function compareEdges(a, b) {
  return edgeKey(a).localeCompare(edgeKey(b), "en", { numeric: true });
}

async function listCorpusFiles(corpusDir, fsApi = fs) {
  return listTreeFiles(corpusDir, ".xml.gz", fsApi);
}

// The HTML corpus lives beside the FMX one (data/laws -> data/laws-html) and holds
// the acts EUR-Lex never published as Formex (overwhelmingly pre-2000).
function htmlCorpusDirFor(corpusDir) {
  return path.basename(corpusDir) === "laws"
    ? path.join(path.dirname(corpusDir), "laws-html")
    : null;
}

async function listHtmlCorpusFiles(htmlDir, fsApi = fs) {
  return htmlDir ? listTreeFiles(htmlDir, ".html.gz", fsApi) : [];
}

// Both corpora are keyed by CELEX, so one combined, year-filterable list drives the
// build; the per-file handler dispatches on the extension.
async function listAllCorpusFiles(corpusDir, options = {}, fsApi = fs) {
  const fmxFiles = await listCorpusFiles(corpusDir, fsApi);
  if (options.includeHtml === false) return fmxFiles;
  const htmlDir = options.htmlDir || htmlCorpusDirFor(corpusDir);
  return [...fmxFiles, ...await listHtmlCorpusFiles(htmlDir, fsApi)];
}

function isHtmlCorpusFile(file) {
  return /\.html\.gz$/i.test(String(file));
}

function celexForCorpusFile(file) {
  return normalizeCelex(path.basename(file).replace(/\.(?:xml|html)\.gz$/i, ""));
}

async function listTreeFiles(rootDir, suffix, fsApi = fs) {
  const files = [];
  async function visit(dir) {
    const entries = await fsApi.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(fullPath);
    }
  }
  try { await visit(rootDir); } catch (error) { if (error.code !== "ENOENT") throw error; }
  return files;
}

async function readGzippedXml(filePath, fsApi = fs) {
  return (await gunzip(await fsApi.readFile(filePath))).toString("utf8");
}

function resolveExternalReference(ref, legalCache) {
  if (!ref || ref.type !== "external") return null;
  if (ref.targetCelex || ref.actCelex) return normalizeCelex(ref.targetCelex || ref.actCelex);
  if (!ref.actType || !ref.year || !ref.number || !legalCache) return null;
  return normalizeCelex(legalCache.getByOfficialReference({
    actType: ref.actType, year: ref.year, number: ref.number,
  })?.celex);
}

function sourceUnitTypeFor(unit) {
  const value = String(unit || "").toLowerCase();
  if (value.startsWith("recital_")) return "recital";
  if (value.startsWith("annex_")) return "annex";
  return "article";
}

function stripCompleteUppercaseAnnexes(xml) {
  const source = String(xml);
  let annexElementsOmitted = 0;
  let actDepth = 0;
  let cursor = 0;
  let hasSelfClosingAnnex = false;
  const pieces = [];
  const tokenRe = /<\/?ACT(?:\s[^>]*)?>|<ANNEX(?:\s[^>]*)?>[\s\S]*?<\/ANNEX\s*>/g;
  let match;
  while ((match = tokenRe.exec(source)) !== null) {
    if (match[0].startsWith("<ANNEX")) {
      // A self-closing annex with attributes (<ANNEX ID="1"/>) is consumed by
      // the opening-tag alternation (the "/" falls inside [^>]*), and the lazy
      // body scan then swallows everything up to the NEXT annex's </ANNEX> —
      // silently deleting non-annex content in between. Flag it so the caller
      // rejects the operative-only fallback rather than trust the corrupted text.
      const openTagEnd = match[0].indexOf(">");
      if (openTagEnd > 0 && match[0][openTagEnd - 1] === "/") hasSelfClosingAnnex = true;
      if (actDepth === 0) {
        pieces.push(source.slice(cursor, match.index));
        cursor = match.index + match[0].length;
        annexElementsOmitted += 1;
      }
    } else if (match[0].startsWith("</ACT")) {
      actDepth = Math.max(0, actDepth - 1);
    } else if (!match[0].endsWith("/>")) {
      actDepth += 1;
    }
  }
  pieces.push(source.slice(cursor));
  const operativeXml = pieces.join("");
  const hasAct = /<ACT(?:\s|>)/.test(operativeXml);
  const hasUnmatchedAnnexMarkup = /<\/?ANNEX(?:\s|>)/.test(operativeXml);
  return { operativeXml, annexElementsOmitted, hasAct, hasUnmatchedAnnexMarkup, hasSelfClosingAnnex };
}

function legislationEdgesForLaw(sourceCelex, parsed, legalCache, counters) {
  const edges = [];
  const sourceTitle = clean(legalCache?.getByCelex?.(sourceCelex)?.title || parsed?.title);
  const crossReferences = parsed?.crossReferences || {};
  for (const sourceUnit of Object.keys(crossReferences).sort((a, b) => a.localeCompare(b, "en", { numeric: true }))) {
    for (const ref of Array.isArray(crossReferences[sourceUnit]) ? crossReferences[sourceUnit] : []) {
      if (ref?.type !== "external") continue;
      counters.externalReferences += 1;
      const targetCelex = resolveExternalReference(ref, legalCache);
      if (!targetCelex) { counters.unresolvedReferences += 1; continue; }
      edges.push({
        kind: "legislation", sourceCelex, sourceTitle,
        sourceUnitType: sourceUnitTypeFor(sourceUnit), sourceUnit: clean(sourceUnit), targetCelex,
        targetArticle: clean(ref.articleNumber), targetParagraph: clean(ref.paragraph), targetPoint: clean(ref.point),
        raw: clean(ref.raw),
      });
    }
  }
  return edges;
}

function caseLawEdges(cache) {
  const edges = [];
  for (const [caseCelex, judgment] of Object.entries(cache && typeof cache === "object" ? cache : {})
    .sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))) {
    for (const ref of Array.isArray(judgment?.articleRefs) ? judgment.articleRefs : []) {
      const targetCelex = normalizeCelex(ref?.actCelex);
      if (!targetCelex) continue;
      edges.push({
        kind: "judgment", sourceCelex: normalizeCelex(caseCelex), sourceTitle: clean(judgment?.name),
        sourceUnitType: "judgment", sourceUnit: normalizeCelex(caseCelex), targetCelex,
        targetArticle: clean(ref.article), targetParagraph: clean(ref.paragraph), targetPoint: clean(ref.point),
        raw: clean(ref.raw),
      });
    }
  }
  return edges;
}

async function readCaseLawCache(cachePath, fsApi = fs) {
  if (!cachePath) return null;
  try { return JSON.parse(await fsApi.readFile(cachePath, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function writeArtifactAtomic(outputPath, artifact, fsApi = fs) {
  await fsApi.mkdir(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  await fsApi.writeFile(temporary, JSON.stringify(artifact), "utf8");
  await fsApi.rename(temporary, outputPath);
}

function parseCliArgs(argv) {
  const options = {};
  const valueFlags = ["--corpusDir", "--htmlDir", "--out", "--limit", "--fromYear", "--toYear",
    "--maxXmlBytes", "--maxHtmlBytes", "--batchSize"];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    // --noHtml is the one boolean: it restores the FMX-only graph (and reports the
    // HTML tree as skipped) for a faster build that ignores the pre-2000 corpus.
    if (flag === "--noHtml") { options.includeHtml = false; continue; }
    if (!valueFlags.includes(flag)) {
      throw new Error(`Unknown argument: ${flag}`);
    }
    const value = argv[index += 1];
    if (value == null) throw new Error(`Missing value for ${flag}`);
    if (flag === "--corpusDir") options.corpusDir = value;
    else if (flag === "--htmlDir") options.htmlDir = value;
    else if (flag === "--out") options.outputPath = value;
    else {
      const number = Number.parseInt(value, 10);
      if (!Number.isInteger(number) || number < 0
        || (["--limit", "--maxXmlBytes", "--maxHtmlBytes", "--batchSize"].includes(flag) && number === 0)) {
        throw new Error(`Invalid value for ${flag}: ${value}`);
      }
      if (flag === "--limit") options.limit = number;
      if (flag === "--fromYear") options.fromYear = number;
      if (flag === "--toYear") options.toYear = number;
      if (flag === "--maxXmlBytes") options.maxXmlBytes = number;
      if (flag === "--maxHtmlBytes") options.maxHtmlBytes = number;
      if (flag === "--batchSize") options.batchSize = number;
    }
  }
  return options;
}

async function buildCitationGraph(options = {}) {
  const fsApi = options.fsApi || fs;
  const corpusDir = options.corpusDir || DEFAULT_CORPUS_DIR;
  const files = filterCorpusFiles(
    options.files || await listAllCorpusFiles(corpusDir, options, fsApi), options);
  // The HTML tree is only "skipped" when HTML parsing is disabled; otherwise its laws
  // are in `files` above and counted like any other. An explicit htmlTreeSkipped stays
  // authoritative either way — shard workers pass 0 and let the merge set the total.
  const htmlTreeSkipped = options.includeHtml === false
    ? await countHtmlTreeSkipped(corpusDir, options)
    : (options.htmlTreeSkipped ?? 0);
  const legalCache = options.legalCache || (() => {
    const { JsonLegalCacheStore } = require("./legal-cache-store");
    return new JsonLegalCacheStore(options.searchCachePath);
  })();
  if (typeof legalCache.load === "function" && !legalCache.isReady?.()) legalCache.load();
  if (typeof legalCache.isReady === "function" && !legalCache.isReady()) {
    throw new Error(`Legal search cache is unavailable: ${legalCache.getStatus?.().error || "not loaded"}`);
  }
  const parseXml = options.parseXml || require("../shared/fmx-parser-node").parseFmxXml;
  const wrapXml = options.wrapXml || require("./search-build").wrapForParsing;
  const readXml = options.readXml || ((file) => readGzippedXml(file, fsApi));
  // Lazily required: pulling in the HTML parser (and jsdom) costs real startup time,
  // so builds that never touch the HTML corpus shouldn't pay for it.
  const parseHtml = options.parseHtml
    || ((html) => require("../shared/eurlex-html-parser").parseEurlexHtmlToCombined(html, "ENG"));
  const readHtml = options.readHtml || ((file) => readGzippedXml(file, fsApi));
  const maxXmlBytes = options.maxXmlBytes ?? DEFAULT_MAX_XML_BYTES;
  const maxHtmlBytes = options.maxHtmlBytes ?? DEFAULT_MAX_HTML_BYTES;
  const progressInterval = options.progressInterval || DEFAULT_PROGRESS_INTERVAL;
  const progressLog = options.progress ? (options.log || console.log) : null;
  const counters = {
    corpusFiles: files.length, parsedLaws: 0, parseFailures: 0,
    oversizedLawsSkipped: 0, oversizedLawsOperativeOnly: 0, annexElementsOmitted: 0,
    htmlLaws: 0, oversizedHtmlSkipped: 0,
    externalReferences: 0, unresolvedReferences: 0,
  };
  const failures = [], edges = [], parserVersions = new Set();

  // The HTML renditions carry no <REF.DOC.OJ> markup, so their cross-references come
  // from the parser's prose grammar instead; the resulting `parsed` shape is the same,
  // which is why both corpora share legislationEdgesForLaw below.
  async function collectHtmlLaw(file, sourceCelex) {
    const html = await readHtml(file);
    const htmlBytes = Buffer.byteLength(String(html), "utf8");
    if (htmlBytes > maxHtmlBytes) {
      counters.oversizedHtmlSkipped += 1;
      failures.push({
        celex: sourceCelex, type: "oversized-html", htmlBytes, maxHtmlBytes,
        error: `Decompressed HTML exceeds ${maxHtmlBytes} bytes`,
      });
      return;
    }
    const parsed = await parseHtml(html);
    if (!parsed) {
      counters.parseFailures += 1;
      failures.push({ celex: sourceCelex, type: "html", error: "HTML parser returned no document" });
      return;
    }
    counters.parsedLaws += 1;
    counters.htmlLaws += 1;
    if (parsed?.parserVersion != null) parserVersions.add(parsed.parserVersion);
    edges.push(...legislationEdgesForLaw(sourceCelex, parsed, legalCache, counters));
  }

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const sourceCelex = celexForCorpusFile(file);
    try {
      if (isHtmlCorpusFile(file)) {
        await collectHtmlLaw(file, sourceCelex);
        const done = index + 1;
        if (progressLog && (done % progressInterval === 0 || done === files.length)) {
          progressLog(`[citation-graph] ${done}/${files.length} laws; current=${sourceCelex}; parsed=${counters.parsedLaws}; failed=${counters.parseFailures}; html=${counters.htmlLaws}; oversized-html-skipped=${counters.oversizedHtmlSkipped}`);
        }
        continue;
      }
      const xml = await readXml(file);
      const xmlBytes = Buffer.byteLength(String(xml), "utf8");
      if (xmlBytes > maxXmlBytes) {
        const stripped = stripCompleteUppercaseAnnexes(xml);
        const operativeXmlBytes = Buffer.byteLength(stripped.operativeXml, "utf8");
        if (stripped.annexElementsOmitted > 0 && stripped.hasAct
          && !stripped.hasUnmatchedAnnexMarkup && !stripped.hasSelfClosingAnnex
          && operativeXmlBytes <= maxXmlBytes) {
          try {
            const parsed = await parseXml(wrapXml(stripped.operativeXml));
            counters.parsedLaws += 1;
            counters.oversizedLawsOperativeOnly += 1;
            counters.annexElementsOmitted += stripped.annexElementsOmitted;
            if (parsed?.parserVersion != null) parserVersions.add(parsed.parserVersion);
            edges.push(...legislationEdgesForLaw(sourceCelex, parsed, legalCache, counters));
          } catch (error) {
            counters.oversizedLawsSkipped += 1;
            failures.push({
              celex: sourceCelex,
              type: "oversized",
              xmlBytes,
              maxXmlBytes,
              error: `Operative-only fallback could not be parsed: ${String(error?.message || error)}`,
            });
          }
        } else {
          counters.oversizedLawsSkipped += 1;
          failures.push({
            celex: sourceCelex,
            type: "oversized",
            xmlBytes,
            maxXmlBytes,
            error: `Decompressed FMX exceeds ${maxXmlBytes} bytes and has no safe operative-only fallback`,
          });
        }
      } else {
        const parsed = await parseXml(wrapXml(xml));
        counters.parsedLaws += 1;
        if (parsed?.parserVersion != null) parserVersions.add(parsed.parserVersion);
        edges.push(...legislationEdgesForLaw(sourceCelex, parsed, legalCache, counters));
      }
    } catch (error) {
      counters.parseFailures += 1;
      failures.push({ celex: sourceCelex, error: String(error?.message || error) });
    }
    const processed = index + 1;
    if (progressLog && (processed % progressInterval === 0 || processed === files.length)) {
      progressLog(`[citation-graph] ${processed}/${files.length} laws; current=${sourceCelex}; parsed=${counters.parsedLaws}; failed=${counters.parseFailures}; oversized-skipped=${counters.oversizedLawsSkipped}; operative-only=${counters.oversizedLawsOperativeOnly}`);
    }
  }
  const caseData = options.caseLawData !== undefined ? options.caseLawData
    : await readCaseLawCache(options.caseLawCachePath, fsApi);
  const artifact = assembleArtifact({
    counters, failures, edges, parserVersions, htmlTreeSkipped, maxXmlBytes, maxHtmlBytes,
    caseData, now: options.now,
  });
  const outputPath = options.outputPath === undefined ? DEFAULT_CITATION_GRAPH_PATH : options.outputPath;
  if (outputPath) await writeArtifactAtomic(outputPath, artifact, fsApi);
  return artifact;
}

function filterCorpusFiles(files, options = {}) {
  let selected = [...files].filter((file) => {
    const match = /^\d(\d{4})/.exec(path.basename(file));
    const year = match ? Number(match[1]) : null;
    return (options.fromYear == null || (year != null && year >= options.fromYear))
      && (options.toYear == null || (year != null && year <= options.toYear));
  });
  if (options.limit != null) selected = selected.slice(0, options.limit);
  return selected;
}

async function countHtmlTreeSkipped(corpusDir, options = {}) {
  if (options.htmlTreeSkipped != null) return options.htmlTreeSkipped;
  if (options.files) return 0;
  if (path.basename(corpusDir) !== "laws") return 0;
  const htmlDir = path.join(path.dirname(corpusDir), "laws-html");
  const fsApi = options.fsApi || fs;
  return (options.countHtmlFiles || (async (dir) => (await listTreeFiles(dir, ".html.gz", fsApi)).length))(htmlDir);
}

// Assemble the final artifact from accumulated counters/edges. Shared by the
// single-process builder and the batched shard merge so their output stays
// byte-identical (JSON.stringify key order is asserted by the tests). Case-law
// edges are folded in here (before dedup) so both callers get them once.
function assembleArtifact({ counters, failures, edges, parserVersions, htmlTreeSkipped, maxXmlBytes, maxHtmlBytes, caseData, now }) {
  const allEdges = [...edges, ...caseLawEdges(caseData)];
  const deduped = [...new Map(allEdges.map((edge) => [edgeKey(edge), edge])).values()].sort(compareEdges);
  const versions = [...parserVersions].sort();
  return {
    graphVersion: GRAPH_VERSION,
    parserVersion: versions.length === 1 ? versions[0] : (versions.length ? versions : null),
    generatedAt: (now || (() => new Date()))().toISOString(),
    coverage: {
      legislation: {
        status: "corpus", corpusFiles: counters.corpusFiles, parsedLaws: counters.parsedLaws,
        htmlTreeSkipped, oversizedLawsSkipped: counters.oversizedLawsSkipped, maxXmlBytes,
        oversizedLawsOperativeOnly: counters.oversizedLawsOperativeOnly,
        annexElementsOmitted: counters.annexElementsOmitted,
        annexCoverage: counters.oversizedLawsOperativeOnly > 0 ? "partial-operative-only" : "full-for-parsed-fmx",
        htmlLaws: counters.htmlLaws || 0,
        oversizedHtmlSkipped: counters.oversizedHtmlSkipped || 0,
        maxHtmlBytes: maxHtmlBytes ?? DEFAULT_MAX_HTML_BYTES,
      },
      caseLaw: { status: caseData ? "partial-cache" : "not-included", judgments: caseData ? Object.keys(caseData).length : 0 },
    },
    stats: {
      ...counters, failures: failures.length,
      resolvedReferences: counters.externalReferences - counters.unresolvedReferences,
      legislationEdges: deduped.filter((edge) => edge.kind === "legislation").length,
      judgmentEdges: deduped.filter((edge) => edge.kind === "judgment").length,
      edges: deduped.length,
    },
    failures, edges: deduped,
  };
}

function runCitationGraphWorker(files, options = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "citation-graph-worker.js"), {
      workerData: {
        files,
        maxXmlBytes: options.maxXmlBytes,
        searchCachePath: options.searchCachePath,
      },
      resourceLimits: { maxOldGenerationSizeMb: options.workerHeapMb || DEFAULT_WORKER_HEAP_MB },
    });
    let settled = false;
    // Once the worker has delivered its result (message or error), tear it down
    // explicitly so a future handle leak in worker code can't keep the thread —
    // and thus the build — alive. terminate() returns a promise; fire-and-forget.
    const stop = () => { worker.terminate().catch(() => {}); };
    worker.once("message", (message) => {
      settled = true;
      if (message?.ok) resolve(message.artifact);
      else reject(new Error(message?.error || "Citation graph worker failed"));
      stop();
    });
    worker.once("error", (error) => { settled = true; reject(error); stop(); });
    worker.once("exit", (code) => {
      if (!settled && code !== 0) reject(new Error(`Citation graph worker exited with code ${code}`));
      else if (!settled) reject(new Error("Citation graph worker exited without a result"));
    });
  });
}

function mergeCitationGraphShards(shards, options = {}) {
  const counterNames = [
    "corpusFiles", "parsedLaws", "parseFailures", "oversizedLawsSkipped",
    "oversizedLawsOperativeOnly", "annexElementsOmitted", "htmlLaws", "oversizedHtmlSkipped",
    "externalReferences", "unresolvedReferences",
  ];
  const counters = Object.fromEntries(counterNames.map((name) => [name, 0]));
  const failures = [];
  const edges = [];
  const parserVersions = new Set();
  for (const shard of shards) {
    for (const name of counterNames) counters[name] += Number(shard?.stats?.[name] || 0);
    failures.push(...(Array.isArray(shard?.failures) ? shard.failures : []));
    edges.push(...(Array.isArray(shard?.edges) ? shard.edges : []));
    const versions = Array.isArray(shard?.parserVersion) ? shard.parserVersion : [shard?.parserVersion];
    for (const version of versions) if (version != null) parserVersions.add(version);
  }
  return assembleArtifact({
    counters, failures, edges, parserVersions,
    htmlTreeSkipped: options.htmlTreeSkipped || 0,
    maxXmlBytes: options.maxXmlBytes ?? DEFAULT_MAX_XML_BYTES,
    maxHtmlBytes: options.maxHtmlBytes ?? DEFAULT_MAX_HTML_BYTES,
    caseData: options.caseLawData, now: options.now,
  });
}

async function buildCitationGraphBatched(options = {}) {
  const fsApi = options.fsApi || fs;
  const corpusDir = options.corpusDir || DEFAULT_CORPUS_DIR;
  const allFiles = options.files || await listAllCorpusFiles(corpusDir, options, fsApi);
  const files = filterCorpusFiles(allFiles, options);
  const htmlTreeSkipped = options.includeHtml === false
    ? await countHtmlTreeSkipped(corpusDir, options)
    : (options.htmlTreeSkipped ?? 0);
  const maxXmlBytes = options.maxXmlBytes ?? DEFAULT_MAX_XML_BYTES;
  const maxHtmlBytes = options.maxHtmlBytes ?? DEFAULT_MAX_HTML_BYTES;
  const batchSize = options.batchSize || DEFAULT_BATCH_SIZE;
  const workerRunner = options.workerRunner || runCitationGraphWorker;
  const shards = [];
  let processed = 0;
  const progressLog = options.progress ? (options.log || console.log) : null;

  async function processBatch(batch) {
    try {
      const shard = await workerRunner(batch, {
        maxXmlBytes, maxHtmlBytes, searchCachePath: options.searchCachePath,
        workerHeapMb: options.workerHeapMb,
      });
      shards.push(shard);
      processed += batch.length;
      if (progressLog) progressLog(`[citation-graph] ${processed}/${files.length} laws completed in isolated workers; last=${celexForCorpusFile(batch[batch.length - 1])}`);
    } catch (error) {
      if (batch.length > 1) {
        const middle = Math.floor(batch.length / 2);
        await processBatch(batch.slice(0, middle));
        await processBatch(batch.slice(middle));
        return;
      }
      const celex = celexForCorpusFile(batch[0]);
      shards.push({
        parserVersion: null,
        stats: { corpusFiles: 1, parseFailures: 1 },
        failures: [{ celex, type: "worker_failure", error: String(error?.message || error) }],
        edges: [],
      });
      processed += 1;
      if (progressLog) progressLog(`[citation-graph] ${processed}/${files.length} laws; skipped worker-failing law ${celex}`);
    }
  }

  for (let index = 0; index < files.length; index += batchSize) {
    await processBatch(files.slice(index, index + batchSize));
  }
  const caseData = options.caseLawData !== undefined ? options.caseLawData
    : await readCaseLawCache(options.caseLawCachePath, fsApi);
  const artifact = mergeCitationGraphShards(shards, {
    caseLawData: caseData, htmlTreeSkipped, maxXmlBytes, maxHtmlBytes, now: options.now,
  });
  const outputPath = options.outputPath === undefined ? DEFAULT_CITATION_GRAPH_PATH : options.outputPath;
  if (outputPath) await writeArtifactAtomic(outputPath, artifact, fsApi);
  return artifact;
}

function citationSourceKey(edge) {
  return [edge.kind, edge.sourceCelex, edge.sourceUnitType, edge.sourceUnit].join("|");
}

function rankedTargets(edges, keyForEdge, limit) {
  const targets = new Map();
  for (const edge of edges) {
    const key = keyForEdge(edge);
    if (!key) continue;
    const sources = targets.get(key) || new Set();
    sources.add(citationSourceKey(edge));
    targets.set(key, sources);
  }
  return [...targets.entries()]
    .map(([target, sources]) => ({ target, count: sources.size }))
    .sort((a, b) => b.count - a.count || a.target.localeCompare(b.target, "en", { numeric: true }))
    .slice(0, limit);
}

function summarizeArtifact(artifact) {
  return {
    topArticles: rankedTargets(
      artifact.edges,
      (edge) => edge.targetArticle == null ? null : `${edge.targetCelex} Article ${edge.targetArticle}`,
      20
    ),
    topActs: rankedTargets(artifact.edges, (edge) => edge.targetCelex || null, 10),
  };
}

function formatSummaryReport(artifact) {
  const summary = summarizeArtifact(artifact);
  const lines = [
    `Citation graph: ${artifact.stats.edges} edges (${artifact.stats.legislationEdges} legislation, ${artifact.stats.judgmentEdges} judgments)`,
    `Corpus: ${artifact.stats.parsedLaws}/${artifact.stats.corpusFiles} laws parsed; ${artifact.stats.parseFailures} failed; ${artifact.stats.oversizedLawsSkipped} oversized skipped; ${artifact.stats.oversizedLawsOperativeOnly} operative-only (${artifact.stats.annexElementsOmitted} annexes omitted); ${artifact.coverage.legislation.htmlTreeSkipped} HTML laws skipped`,
    `HTML corpus: ${artifact.coverage.legislation.htmlLaws} laws parsed from prose; ${artifact.coverage.legislation.oversizedHtmlSkipped} oversized skipped`,
    `References: ${artifact.stats.resolvedReferences} resolved; ${artifact.stats.unresolvedReferences} unresolved`,
    "Top cited articles:",
    ...summary.topArticles.map((entry, index) => `  ${index + 1}. ${entry.target} — ${entry.count}`),
    "Top cited acts:",
    ...summary.topActs.map((entry, index) => `  ${index + 1}. ${entry.target} — ${entry.count}`),
  ];
  return lines.join("\n");
}

function defaultCaseLawCachePath() {
  // Derive from the single source of truth in law-queries so bumping
  // CASE_LAW_CACHE_FILE (per the cache-version table) doesn't silently leave
  // this builder reading a stale/missing file and dropping every judgment edge.
  const { CASE_LAW_CACHE_FILE } = require("../shared/law-queries");
  const cacheDir = process.env.CACHE_DIR || process.env.FMX_DIR || path.join(__dirname, "..", "law-cache");
  return path.join(cacheDir, CASE_LAW_CACHE_FILE);
}

if (require.main === module) {
  const cliOptions = parseCliArgs(process.argv.slice(2));
  const outputPath = cliOptions.outputPath || DEFAULT_CITATION_GRAPH_PATH;
  buildCitationGraphBatched({ ...cliOptions, progress: true, caseLawCachePath: process.env.CASE_LAW_CACHE_PATH || defaultCaseLawCachePath() })
    .then((artifact) => console.log(`${formatSummaryReport(artifact)}\nWrote ${outputPath}`))
    .catch((error) => { console.error(error); process.exitCode = 1; });
}

module.exports = { DEFAULT_BATCH_SIZE, DEFAULT_CITATION_GRAPH_PATH, DEFAULT_CORPUS_DIR, DEFAULT_MAX_XML_BYTES,
  DEFAULT_MAX_HTML_BYTES, GRAPH_VERSION, buildCitationGraph, buildCitationGraphBatched, celexForCorpusFile,
  countHtmlTreeSkipped, filterCorpusFiles, htmlCorpusDirFor, isHtmlCorpusFile,
  caseLawEdges, edgeKey, formatSummaryReport, legislationEdgesForLaw, listAllCorpusFiles, listCorpusFiles,
  listHtmlCorpusFiles, listTreeFiles,
  mergeCitationGraphShards, parseCliArgs, rankedTargets, resolveExternalReference, runCitationGraphWorker,
  sourceUnitTypeFor, stripCompleteUppercaseAnnexes,
  summarizeArtifact, writeArtifactAtomic };
