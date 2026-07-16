const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const zlib = require("zlib");
const { promisify } = require("util");
const { Worker } = require("worker_threads");

const {
  celexForCorpusFile,
  filterCorpusFiles,
  isHtmlCorpusFile,
  listAllCorpusFiles,
  stripCompleteUppercaseAnnexes,
  writeArtifactAtomic,
} = require("./citation-graph-build");

const gunzip = promisify(zlib.gunzip);
const INDEX_VERSION = 1;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_WORKER_HEAP_MB = 768;
// Match the established excerpt-extraction ceiling: definition articles live in
// the operative text and many substantive acts exceed 1 MiB without being giant
// tariff-table documents. Above 6 MiB we still try the safe annex-stripping path.
const DEFAULT_MAX_XML_BYTES = 6 * 1024 * 1024;
const DEFAULT_MAX_HTML_BYTES = 4 * 1024 * 1024;
const DEFAULT_CORPUS_DIR = path.join(__dirname, "data", "laws");
const DEFAULT_OUTPUT_PATH = path.join(__dirname, "data", "definitions.json");

function normalizeTerm(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[‘’‛`]/g, "'")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[\s'"“”]+|[\s'"“”.,;:]+$/g, "")
    .toLocaleLowerCase("en");
}

function normalizeDefinition(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[‘’‛`]/g, "'")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim()
    .replace(/[;.]$/, "");
}

function definitionHash(value) {
  return crypto.createHash("sha256").update(normalizeDefinition(value)).digest("hex").slice(0, 20);
}

function dedupeCorpusFiles(files) {
  const byCelex = new Map();
  for (const file of files) {
    const celex = celexForCorpusFile(file);
    if (!celex) continue;
    const current = byCelex.get(celex);
    // FMX is the canonical source. HTML is the fallback corpus for acts that do
    // not have an FMX rendition, so never index both representations.
    if (!current || (isHtmlCorpusFile(current) && !isHtmlCorpusFile(file))) byCelex.set(celex, file);
  }
  return [...byCelex.values()].sort((a, b) => celexForCorpusFile(a).localeCompare(celexForCorpusFile(b), "en", { numeric: true }));
}

function compactOccurrence(celex, parsed, entry) {
  const term = String(entry?.term || "").trim();
  const definition = String(entry?.definition || "").trim();
  const normalizedTerm = normalizeTerm(term);
  if (!term || !definition || !normalizedTerm) return null;
  return {
    celex,
    lang: parsed?.langCode || null,
    sourceArticle: entry?.sourceArticle == null ? null : String(entry.sourceArticle),
    term,
    normalizedTerm,
    definition,
    definitionHash: definitionHash(definition),
  };
}

async function readGzip(file, fsApi = fs) {
  return (await gunzip(await fsApi.readFile(file))).toString("utf8");
}

async function buildDefinitionShard(options = {}) {
  const fsApi = options.fsApi || fs;
  const files = options.files || [];
  const parseXml = options.parseXml || require("../shared/fmx-parser-node").parseFmxXml;
  const wrapXml = options.wrapXml || require("./search-build").wrapForParsing;
  const parseHtml = options.parseHtml || ((html) => require("../shared/eurlex-html-parser").parseEurlexHtmlToCombined(html, "ENG"));
  const readFile = options.readFile || ((file) => readGzip(file, fsApi));
  const maxXmlBytes = options.maxXmlBytes ?? DEFAULT_MAX_XML_BYTES;
  const maxHtmlBytes = options.maxHtmlBytes ?? DEFAULT_MAX_HTML_BYTES;
  const stats = { corpusFiles: files.length, parsedLaws: 0, htmlLaws: 0, definitions: 0, failures: 0, oversizedSkipped: 0 };
  const failures = [];
  const occurrences = [];
  const parserVersions = new Set();

  for (const file of files) {
    const celex = celexForCorpusFile(file);
    try {
      let source = await readFile(file);
      const bytes = Buffer.byteLength(source, "utf8");
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
      stats.parsedLaws += 1;
      if (parsed.parserVersion != null) parserVersions.add(parsed.parserVersion);
      for (const entry of parsed.definitions || []) {
        const occurrence = compactOccurrence(celex, parsed, entry);
        if (occurrence) occurrences.push(occurrence);
      }
    } catch (error) {
      stats.failures += 1;
      if (error?.oversized) stats.oversizedSkipped += 1;
      failures.push({ celex, type: error?.oversized ? "oversized" : "parse", error: String(error?.message || error) });
    }
  }
  occurrences.sort(compareOccurrences);
  stats.definitions = occurrences.length;
  const versions = [...parserVersions].sort();
  return { parserVersion: versions.length === 1 ? versions[0] : (versions.length ? versions : null), stats, failures, occurrences };
}

function compareOccurrences(a, b) {
  return a.normalizedTerm.localeCompare(b.normalizedTerm, "en")
    || a.celex.localeCompare(b.celex, "en", { numeric: true })
    || String(a.sourceArticle || "").localeCompare(String(b.sourceArticle || ""), "en", { numeric: true });
}

function assembleArtifact(shards, now = () => new Date()) {
  const occurrences = shards.flatMap((shard) => shard.occurrences || []).sort(compareOccurrences);
  const failures = shards.flatMap((shard) => shard.failures || []);
  const parserVersions = new Set(shards.flatMap((shard) => Array.isArray(shard.parserVersion) ? shard.parserVersion : [shard.parserVersion]).filter((value) => value != null));
  const versions = [...parserVersions].sort();
  const stats = { corpusFiles: 0, parsedLaws: 0, htmlLaws: 0, definitions: occurrences.length, failures: failures.length, oversizedSkipped: 0 };
  for (const shard of shards) for (const key of ["corpusFiles", "parsedLaws", "htmlLaws", "oversizedSkipped"]) stats[key] += Number(shard.stats?.[key] || 0);
  return {
    indexVersion: INDEX_VERSION,
    parserVersion: versions.length === 1 ? versions[0] : (versions.length ? versions : null),
    generatedAt: now().toISOString(),
    stats: { ...stats, uniqueTerms: new Set(occurrences.map((entry) => entry.normalizedTerm)).size },
    failures,
    definitions: occurrences,
  };
}

function runDefinitionWorker(files, options = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "definition-index-worker.js"), {
      workerData: { files, maxXmlBytes: options.maxXmlBytes, maxHtmlBytes: options.maxHtmlBytes },
      resourceLimits: { maxOldGenerationSizeMb: options.workerHeapMb || DEFAULT_WORKER_HEAP_MB },
    });
    let settled = false;
    const stop = () => worker.terminate().catch(() => {});
    worker.once("message", (message) => { settled = true; message?.ok ? resolve(message.shard) : reject(new Error(message?.error || "Definition worker failed")); stop(); });
    worker.once("error", (error) => { settled = true; reject(error); stop(); });
    worker.once("exit", (code) => { if (!settled) reject(new Error(`Definition worker exited without a result (${code})`)); });
  });
}

async function readCheckpoint(checkpointPath, fsApi = fs) {
  try {
    const checkpoint = JSON.parse(await fsApi.readFile(checkpointPath, "utf8"));
    return checkpoint.indexVersion === INDEX_VERSION ? checkpoint : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function buildDefinitionIndex(options = {}) {
  const fsApi = options.fsApi || fs;
  const corpusDir = options.corpusDir || DEFAULT_CORPUS_DIR;
  const allFiles = options.files || await listAllCorpusFiles(corpusDir, options, fsApi);
  const files = dedupeCorpusFiles(filterCorpusFiles(allFiles, options));
  const outputPath = options.outputPath === undefined ? DEFAULT_OUTPUT_PATH : options.outputPath;
  const checkpointPath = options.checkpointPath || (outputPath ? `${outputPath}.checkpoint` : null);
  const checkpoint = checkpointPath ? await readCheckpoint(checkpointPath, fsApi) : null;
  const processed = new Set(checkpoint?.processedCelex || []);
  const shards = [...(checkpoint?.shards || [])];
  const pending = files.filter((file) => !processed.has(celexForCorpusFile(file)));
  const batchSize = options.batchSize || DEFAULT_BATCH_SIZE;
  const workerRunner = options.workerRunner || runDefinitionWorker;
  const log = options.progress ? (options.log || console.log) : null;

  async function processBatch(batch) {
    try {
      const shard = await workerRunner(batch, options);
      shards.push(shard);
      for (const file of batch) processed.add(celexForCorpusFile(file));
      if (checkpointPath) await writeArtifactAtomic(checkpointPath, { indexVersion: INDEX_VERSION, processedCelex: [...processed], shards }, fsApi);
      if (log) log(`[definitions] ${processed.size}/${files.length} laws completed; definitions=${shards.reduce((sum, item) => sum + Number(item.stats?.definitions || 0), 0)}`);
    } catch (error) {
      if (batch.length > 1) {
        const middle = Math.floor(batch.length / 2);
        await processBatch(batch.slice(0, middle));
        await processBatch(batch.slice(middle));
        return;
      }
      const celex = celexForCorpusFile(batch[0]);
      shards.push({ parserVersion: null, stats: { corpusFiles: 1, failures: 1 }, failures: [{ celex, type: "worker_failure", error: String(error?.message || error) }], occurrences: [] });
      processed.add(celex);
      if (checkpointPath) await writeArtifactAtomic(checkpointPath, { indexVersion: INDEX_VERSION, processedCelex: [...processed], shards }, fsApi);
    }
  }

  for (let index = 0; index < pending.length; index += batchSize) await processBatch(pending.slice(index, index + batchSize));
  const artifact = assembleArtifact(shards, options.now);
  if (outputPath) await writeArtifactAtomic(outputPath, artifact, fsApi);
  if (checkpointPath) await fsApi.unlink(checkpointPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  return artifact;
}

function parseCliArgs(argv) {
  const options = {};
  const valueFlags = new Set(["--corpusDir", "--htmlDir", "--out", "--limit", "--fromYear", "--toYear", "--maxXmlBytes", "--maxHtmlBytes", "--batchSize", "--workerHeapMb"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--noHtml") { options.includeHtml = false; continue; }
    if (!valueFlags.has(flag)) throw new Error(`Unknown argument: ${flag}`);
    const value = argv[index += 1];
    if (value == null) throw new Error(`Missing value for ${flag}`);
    if (["--corpusDir", "--htmlDir", "--out"].includes(flag)) options[{ "--corpusDir": "corpusDir", "--htmlDir": "htmlDir", "--out": "outputPath" }[flag]] = value;
    else {
      const number = Number.parseInt(value, 10);
      if (!Number.isInteger(number) || number < 0 || (["--limit", "--maxXmlBytes", "--maxHtmlBytes", "--batchSize", "--workerHeapMb"].includes(flag) && number === 0)) throw new Error(`Invalid value for ${flag}: ${value}`);
      options[{ "--limit": "limit", "--fromYear": "fromYear", "--toYear": "toYear", "--maxXmlBytes": "maxXmlBytes", "--maxHtmlBytes": "maxHtmlBytes", "--batchSize": "batchSize", "--workerHeapMb": "workerHeapMb" }[flag]] = number;
    }
  }
  return options;
}

if (require.main === module) {
  const options = parseCliArgs(process.argv.slice(2));
  buildDefinitionIndex({ ...options, progress: true })
    .then((artifact) => console.log(`Definition index: ${artifact.stats.definitions} definitions across ${artifact.stats.uniqueTerms} terms`))
    .catch((error) => { console.error(error); process.exitCode = 1; });
}

module.exports = {
  DEFAULT_OUTPUT_PATH, INDEX_VERSION, assembleArtifact, buildDefinitionIndex, buildDefinitionShard,
  compactOccurrence, dedupeCorpusFiles, definitionHash, normalizeDefinition, normalizeTerm,
  parseCliArgs, runDefinitionWorker,
};
