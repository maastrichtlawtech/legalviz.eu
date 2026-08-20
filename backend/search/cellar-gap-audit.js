// Compare the recent primary-act set in CELLAR with the released search cache.
// The output is an @file-compatible CELEX list for backfill-cache.js.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const {
  DEFAULT_SEARCH_CACHE_PATH,
  harvestPrimaryActs,
} = require("./search-build");

const DEFAULT_LIMIT = 200;
const DEFAULT_MISSING_PATH = path.resolve("missing.txt");

function normalizeCelex(value) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .trim()
    .toUpperCase();
  return normalized || null;
}

function resolveInputPath(inputPath) {
  const candidate = path.resolve(inputPath);
  if (fs.existsSync(candidate)) return candidate;
  const isGzip = candidate.toLowerCase().endsWith(".gz");
  if (!isGzip && fs.existsSync(`${candidate}.gz`)) return `${candidate}.gz`;
  if (isGzip && fs.existsSync(candidate.slice(0, -3))) return candidate.slice(0, -3);
  throw new Error(`Search cache not found at ${inputPath}`);
}

function readCachePayload(inputPath) {
  const cachePath = resolveInputPath(inputPath);
  const raw = fs.readFileSync(cachePath);
  const json = cachePath.toLowerCase().endsWith(".gz") ? zlib.gunzipSync(raw) : raw;
  const payload = JSON.parse(json.toString("utf8"));
  const records = Array.isArray(payload) ? payload : payload?.records;
  if (!Array.isArray(records)) {
    throw new Error(`Search cache at ${cachePath} does not contain a records array`);
  }
  return records;
}

function cacheCelexSet(records) {
  return new Set(records.map((record) => normalizeCelex(record?.celex)).filter(Boolean));
}

function defaultYearRange(now = new Date()) {
  const currentYear = now.getUTCFullYear();
  return { fromYear: currentYear, toYear: currentYear - 1 };
}

async function auditCellarGap({
  cachePath = DEFAULT_SEARCH_CACHE_PATH,
  outPath = DEFAULT_MISSING_PATH,
  fromYear,
  toYear,
  limit = DEFAULT_LIMIT,
  now = new Date(),
  harvestImpl = harvestPrimaryActs,
  runSparqlImpl,
} = {}) {
  const defaults = defaultYearRange(now);
  const resolvedFromYear = Number.parseInt(String(fromYear ?? defaults.fromYear), 10);
  const resolvedToYear = Number.parseInt(String(toYear ?? (fromYear == null ? defaults.toYear : resolvedFromYear - 1)), 10);
  const resolvedLimit = Number.parseInt(String(limit), 10);
  if (!Number.isInteger(resolvedFromYear) || !Number.isInteger(resolvedToYear)) {
    throw new Error("Gap audit requires integer fromYear and toYear");
  }
  if (!Number.isInteger(resolvedLimit) || resolvedLimit <= 0) {
    throw new Error("Gap audit requires a positive integer limit");
  }

  const present = cacheCelexSet(readCachePayload(cachePath));
  const harvestOptions = {
    fromYear: resolvedFromYear,
    toYear: resolvedToYear,
    limit: resolvedLimit,
  };
  if (runSparqlImpl) harvestOptions.runSparqlImpl = runSparqlImpl;
  const harvested = await harvestImpl(harvestOptions);
  const missing = [...new Set((harvested || [])
    .map((record) => normalizeCelex(record?.celex ?? record))
    .filter(Boolean))]
    .filter((celex) => !present.has(celex))
    .sort();

  const outputPath = path.resolve(outPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, missing.length ? `${missing.join("\n")}\n` : "", "utf8");
  return {
    cachePath: resolveInputPath(cachePath),
    outPath: outputPath,
    fromYear: resolvedFromYear,
    toYear: resolvedToYear,
    scanned: new Set((harvested || []).map((record) => normalizeCelex(record?.celex ?? record)).filter(Boolean)).size,
    present: present.size,
    missing,
  };
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await auditCellarGap({
    cachePath: options.cachePath || options.cache || DEFAULT_SEARCH_CACHE_PATH,
    outPath: options.out || options.output || DEFAULT_MISSING_PATH,
    fromYear: options.fromYear ?? options["from-year"],
    toYear: options.toYear ?? options["to-year"],
    limit: options.limit || options.pageSize || DEFAULT_LIMIT,
  });
  console.log(`[cellar-gap-audit] scanned ${result.scanned} acts; missing ${result.missing.length}; wrote ${result.outPath}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_LIMIT,
  DEFAULT_MISSING_PATH,
  auditCellarGap,
  cacheCelexSet,
  defaultYearRange,
  normalizeCelex,
  parseArgs,
  readCachePayload,
  resolveInputPath,
};
