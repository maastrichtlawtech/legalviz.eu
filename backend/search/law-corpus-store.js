// On-disk store for the raw, combined FMX XML of each law we harvest.
//
// The search-cache build fetches every act's FMX XML purely to extract a title
// and a short excerpt, then throws the XML away. That means (a) we never keep a
// local copy of the underlying law data, and (b) any future re-run (a new
// excerpt heuristic, a parser fix, a wider year range) has to re-scrape EUR-Lex
// from scratch — expensive and a good way to get rate-limited/WAF-challenged.
//
// This module keeps a gzipped copy of each law's combined XML keyed by CELEX so
// the harvest can run offline-first: read from disk when present, only hit the
// network on a genuine miss. It doubles as the "local corpus of all laws" that
// later parser work can iterate against without touching the network.
//
// Layout: <dataDir>/laws/<celexYear>/<CELEX>.xml.gz  (sharded by the 4-digit
// year embedded in the CELEX so no single directory holds tens of thousands of
// files). celexYear is the 4 digits after the leading sector digit, e.g.
// "32024R1234" -> "2024".

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const zlib = require("zlib");
const { promisify } = require("util");

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

function celexShard(celex) {
  const match = /^\d(\d{4})/.exec(String(celex || ""));
  return match ? match[1] : "unknown";
}

function sanitizeCelex(celex) {
  // CELEX ids are alphanumeric with occasional parentheses (e.g. 32016R0679);
  // keep only filesystem-safe characters so a malformed id can't escape the dir.
  return String(celex || "").replace(/[^A-Za-z0-9()_-]/g, "_");
}

// The corpus holds two kinds of raw law source, in parallel trees:
//   FMX XML   -> laws/<year>/<CELEX>.xml.gz     (from CELLAR, most acts >= ~2000)
//   EUR-Lex HTML -> laws-html/<year>/<CELEX>.html.gz  (fallback for FMX-less acts)
// Both are gzipped, sharded by CELEX year, written atomically.
const VARIANTS = {
  xml: { subdir: "laws", ext: "xml" },
  html: { subdir: "laws-html", ext: "html" },
};

function corpusPathForVariant(dataDir, celex, variant) {
  const { subdir, ext } = VARIANTS[variant];
  const safe = sanitizeCelex(celex);
  return path.join(dataDir, subdir, celexShard(safe), `${safe}.${ext}.gz`);
}

async function readCorpusVariant(dataDir, celex, variant) {
  const filePath = corpusPathForVariant(dataDir, celex, variant);
  try {
    const buffer = await fsp.readFile(filePath);
    const text = (await gunzip(buffer)).toString("utf8");
    return text || null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    // A corrupt/half-written file should behave like a cache miss, not crash
    // the whole harvest.
    return null;
  }
}

async function writeCorpusVariant(dataDir, celex, variant, text) {
  if (!text) return false;
  const filePath = corpusPathForVariant(dataDir, celex, variant);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const compressed = await gzip(Buffer.from(String(text), "utf8"));
  // Write atomically so an interrupted run never leaves a truncated file that
  // would later read back as an empty/garbage law.
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tempPath, compressed);
  await fsp.rename(tempPath, filePath);
  return true;
}

function hasCorpusVariant(dataDir, celex, variant) {
  return fs.existsSync(corpusPathForVariant(dataDir, celex, variant));
}

// FMX XML corpus (kept as the original 2-arg API for existing callers).
const corpusPathFor = (dataDir, celex) => corpusPathForVariant(dataDir, celex, "xml");
const readCorpusXml = (dataDir, celex) => readCorpusVariant(dataDir, celex, "xml");
const writeCorpusXml = (dataDir, celex, xml) => writeCorpusVariant(dataDir, celex, "xml", xml);
const hasCorpusXml = (dataDir, celex) => hasCorpusVariant(dataDir, celex, "xml");

// EUR-Lex HTML corpus (fallback source for FMX-less acts).
const corpusHtmlPathFor = (dataDir, celex) => corpusPathForVariant(dataDir, celex, "html");
const readCorpusHtml = (dataDir, celex) => readCorpusVariant(dataDir, celex, "html");
const writeCorpusHtml = (dataDir, celex, html) => writeCorpusVariant(dataDir, celex, "html", html);
const hasCorpusHtml = (dataDir, celex) => hasCorpusVariant(dataDir, celex, "html");

module.exports = {
  celexShard,
  corpusPathFor,
  corpusHtmlPathFor,
  hasCorpusXml,
  hasCorpusHtml,
  readCorpusXml,
  readCorpusHtml,
  sanitizeCelex,
  writeCorpusXml,
  writeCorpusHtml,
};
