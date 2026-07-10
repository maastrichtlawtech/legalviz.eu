const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const { DEFAULT_SEARCH_CACHE_PATH } = require("./search-index");
const { enrichSearchRecord, inferTypeFromCelex } = require("./search-ranking");
const { parseFmxXml } = require("../shared/fmx-parser-node");

const execFileAsync = promisify(execFile);
const SPARQL_ENDPOINT = "https://publications.europa.eu/webapi/rdf/sparql";
const CELLAR_BASE = "http://publications.europa.eu/resource";
const EURLEX_BASE = "https://eur-lex.europa.eu";
const USER_AGENT = "LegalViz API Law Search Builder/0.1";
const SEARCH_CACHE_DIR = path.dirname(DEFAULT_SEARCH_CACHE_PATH);
const DEFAULT_SEARCH_STATE_PATH = path.join(SEARCH_CACHE_DIR, "search-build-state.json");
const GENERIC_OJ_TITLE = "Official Journal of the European Union";
const DEFAULT_CHALLENGE_RETRY_BASE_MS = 2_000;
const DEFAULT_CHALLENGE_RETRY_CAP_MS = 30_000;
// Recitals + Article 1/2 body text, truncated to keep the cache/index size
// bounded. ~3KB is enough prose to carry the conceptual vocabulary of an act
// (recitals restate the act's purpose in plain language; Art. 1/2 give
// subject-matter/scope) without ballooning the ~thousands-of-records cache.
// Article 1/2 is the highest-signal, lowest-boilerplate section, so it goes
// FIRST with a reserved budget: a large act's recitals run to tens of KB and
// would otherwise crowd the subject-matter/scope text out of the truncated
// excerpt entirely — exactly the big laws we most want findable by topic.
// The article text is itself capped so a stray long "scope" article can't eat
// the whole budget; recitals then fill whatever remains.
const EXCERPT_MAX_LENGTH = 3000;
const EXCERPT_ARTICLE_BUDGET = 1200;
const EXCERPT_ARTICLE_NUMBERS = ["1", "2"];

function normalizeTitle(value) {
  const title = String(value || "").trim();
  if (!title || title === GENERIC_OJ_TITLE || title === "CORRELATION TABLE") return null;
  return title;
}

function ensureSearchCacheDir() {
  fs.mkdirSync(SEARCH_CACHE_DIR, { recursive: true });
}

function logProgress(message) {
  console.log(`[search-build] ${message}`);
}

const YEAR_QUERY_ACT_TYPE_MAP = {
  regulation: { celexMarker: "R", eliToken: "reg" },
  directive: { celexMarker: "L", eliToken: "dir" },
  decision: { celexMarker: "D", eliToken: "dec" },
};

function normalizeYearQueryActTypes(actTypes) {
  const values = Array.isArray(actTypes) ? actTypes : ["regulation", "directive", "decision"];
  const normalized = values
    .map((value) => String(value || "").trim().toLowerCase())
    .filter((value) => YEAR_QUERY_ACT_TYPE_MAP[value]);
  return [...new Set(normalized)];
}

function buildYearQuery({ year, limit, offset, actTypes }) {
  const safeYear = Number.parseInt(year, 10);
  const selectedActTypes = normalizeYearQueryActTypes(actTypes);
  const celexMarkers = selectedActTypes.map((type) => YEAR_QUERY_ACT_TYPE_MAP[type].celexMarker).join("");
  const eliTokens = selectedActTypes.map((type) => YEAR_QUERY_ACT_TYPE_MAP[type].eliToken).join("|");
  return `
PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
SELECT DISTINCT ?celex ?title ?date ?eli
WHERE {
  ?cellar
    cdm:resource_legal_id_celex ?celex ;
    cdm:resource_legal_eli ?eli .

  OPTIONAL {
    ?cellar cdm:work_title ?title .
    FILTER(LANG(?title) = "en")
  }
  OPTIONAL { ?cellar cdm:work_date_document ?date . }

  FILTER(REGEX(STR(?celex), "^3${safeYear}[${celexMarkers}]"))
  FILTER(!CONTAINS(?celex, "R("))
  FILTER(REGEX(STR(?eli), "/eli/(${eliTokens})/${safeYear}/[0-9]+/oj$"))
}
ORDER BY ?celex
LIMIT ${limit}
OFFSET ${offset}
`.trim();
}

async function fetchText(url, headers = {}) {
  const response = await fetch(url, {
    headers: {
      Accept: "*/*",
      "User-Agent": USER_AGENT,
      ...headers
    }
  });

  if (response.status === 404) {
    const error = new Error(`HTTP 404 for ${url}`);
    error.statusCode = 404;
    throw error;
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status} for ${url}: ${text.slice(0, 400)}`);
  }

  return response.text();
}

function isChallengeResponse(response) {
  return response.status === 202
    && String(response.headers.get("x-amzn-waf-action") || "").toLowerCase() === "challenge";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getChallengeDelayMs(attempt) {
  const expDelay = DEFAULT_CHALLENGE_RETRY_BASE_MS * (2 ** Math.max(0, attempt - 1));
  const capped = Math.min(DEFAULT_CHALLENGE_RETRY_CAP_MS, expDelay);
  const jitter = Math.floor(Math.random() * 500);
  return capped + jitter;
}

async function fetchTextWithChallengeRetry(url, headers = {}) {
  let attempt = 0;

  while (true) {
    attempt += 1;
    const response = await fetch(url, {
      headers: {
        Accept: "*/*",
        "User-Agent": USER_AGENT,
        ...headers
      }
    });

    if (isChallengeResponse(response)) {
      const delayMs = getChallengeDelayMs(attempt);
      logProgress(`Challenge for ${url} on attempt ${attempt}; retrying in ${delayMs}ms`);
      await sleep(delayMs);
      continue;
    }

    if (response.status === 404) {
      const error = new Error(`HTTP 404 for ${url}`);
      error.statusCode = 404;
      throw error;
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status} for ${url}: ${text.slice(0, 400)}`);
    }

    return response.text();
  }
}

async function runSparql(query) {
  const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&format=application%2Fsparql-results%2Bjson`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/sparql-results+json",
      "User-Agent": USER_AGENT
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SPARQL request failed with HTTP ${response.status}: ${text.slice(0, 400)}`);
  }

  return response.json();
}

function extractUris(rdf) {
  return [...String(rdf || "").matchAll(/rdf:resource="([^"]+)"/g)].map((match) => match[1]);
}

async function findFmx4Uri(celex, lang = "ENG") {
  const rdf = await fetchText(`${CELLAR_BASE}/celex/${celex}`, { "Accept-Language": "eng" });
  const uris = extractUris(rdf);
  const pattern = new RegExp(`\\/oj\\/(JOL_\\d{4}_\\d+_R_\\d+|L_\\d{9})\\.${lang}\\.fmx4$`);

  let fmx4Uri = uris.find((uri) => pattern.test(uri));
  if (!fmx4Uri) {
    const engPattern = /\/oj\/(JOL_\d{4}_\d+_R_\d+|L_\d{9})\.ENG\.fmx4$/;
    const engUri = uris.find((uri) => engPattern.test(uri));
    if (engUri) {
      fmx4Uri = engUri.replace(".ENG.fmx4", `.${lang}.fmx4`);
    }
  }

  if (!fmx4Uri) {
    throw new Error(`No FMX URI found for ${celex}`);
  }

  return fmx4Uri;
}

async function findDownloadUrls(fmx4Uri) {
  const rdf = await fetchText(fmx4Uri, { "Accept-Language": "eng" });
  const uris = extractUris(rdf);
  const zipUrl = uris.find((uri) => uri.endsWith(".zip"));
  if (zipUrl) return { type: "zip", urls: [zipUrl] };

  const allXmlUrls = uris.filter((uri) => uri.match(/\.fmx4\.[^/]+\.xml$/) && !uri.endsWith(".doc.xml"));
  if (allXmlUrls.length) return { type: "xml", urls: allXmlUrls };

  const docXmlUrls = uris.filter((uri) => uri.endsWith(".doc.xml"));
  if (docXmlUrls.length) return { type: "xml", urls: docXmlUrls };

  throw new Error(`No downloadable FMX payload found for ${fmx4Uri}`);
}

function stripXmlTags(value) {
  return decodeHtmlEntities(String(value || ""))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value) {
  const namedEntities = {
    nbsp: " ",
    rsquo: "'",
    lsquo: "'",
    rdquo: "\"",
    ldquo: "\"",
    ndash: "-",
    mdash: "-",
    hellip: "...",
  };

  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&([a-z]+);/gi, (match, name) => namedEntities[name.toLowerCase()] ?? match)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractHtmlAttribute(tag, attributeName) {
  const escapedName = String(attributeName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const doubleQuoted = new RegExp(`\\b${escapedName}="([^"]*)"`, "i").exec(String(tag || ""));
  if (doubleQuoted?.[1] != null) return doubleQuoted[1];

  const singleQuoted = new RegExp(`\\b${escapedName}='([^']*)'`, "i").exec(String(tag || ""));
  return singleQuoted?.[1] || null;
}

function extractTitleFromEurlexHtml(html) {
  const metaTags = String(html || "").match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metaTags) {
    if (extractHtmlAttribute(tag, "name") !== "WT.z_docTitle") continue;
    const content = extractHtmlAttribute(tag, "content");
    const title = normalizeTitle(decodeHtmlEntities(content));
    if (title) return title;
  }

  for (const elementId of ["englishTitle", "title", "originalTitle"]) {
    const match = new RegExp(`<[^>]+id=["']${elementId}["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, "i").exec(String(html || ""));
    if (!match) continue;
    const title = normalizeTitle(stripXmlTags(match[1]));
    if (title) return title;
  }

  return null;
}

function extractTitleFromXml(xml) {
  const titleBlocks = [...String(xml || "").matchAll(/<TITLE\b[\s\S]*?<\/TITLE>/gi)].map((match) => match[0]);
  const candidates = titleBlocks
    .map((titleBlock) => {
      const tiBlocks = [...titleBlock.matchAll(/<TI\b[^>]*>([\s\S]*?)<\/TI>/gi)].map((match) => stripXmlTags(match[1]));
      const title = tiBlocks.length ? tiBlocks.join(" ").trim() : stripXmlTags(titleBlock);
      if (!title || title === GENERIC_OJ_TITLE || title === "CORRELATION TABLE") return null;
      let score = 0;
      if (/\b(regulation|directive|decision)\b/i.test(title)) score += 100;
      if (/\b\d{4}\/\d+\b/.test(title)) score += 30;
      if (/\([^)]+\)/.test(title)) score += 15;
      score += Math.min(title.length, 200) / 10;
      return { title, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  return candidates[0]?.title || null;
}

// Builds the searchable excerpt from the shared FMX parser's combined output:
// recitals (plain text, already stripped of tags) plus the body text of
// Article 1 and Article 2 (typically "subject matter" and "scope"), which are
// the highest-signal, lowest-boilerplate sections for conceptual queries.
function buildExcerptFromCombined(combined) {
  const recitalsText = (combined?.recitals || [])
    .map((recital) => recital?.recital_text || "")
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  const articleText = EXCERPT_ARTICLE_NUMBERS
    .map((number) => (combined?.articles || []).find((article) => article?.article_number === number))
    .filter(Boolean)
    .map((article) => stripXmlTags(article.article_html || ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, EXCERPT_ARTICLE_BUDGET);

  // Article 1/2 first, so it always survives truncation; recitals fill the rest.
  const separatorLength = articleText && recitalsText ? 1 : 0;
  const recitalBudget = EXCERPT_MAX_LENGTH - articleText.length - separatorLength;
  const trimmedRecitals = recitalBudget > 0 ? recitalsText.slice(0, recitalBudget) : "";

  return [articleText, trimmedRecitals]
    .filter(Boolean)
    .join(" ")
    .slice(0, EXCERPT_MAX_LENGTH);
}

// Extraction must degrade gracefully: a malformed/unexpected FMX shape must
// never take down the title extraction that the rest of the build depends on.
async function extractExcerptFromXml(xml) {
  try {
    const combined = await parseFmxXml(xml);
    return buildExcerptFromCombined(combined);
  } catch (error) {
    logProgress(`Excerpt extraction failed: ${error.message}`);
    return "";
  }
}

async function downloadToTempFile(url) {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Download failed with HTTP ${response.status}: ${text.slice(0, 400)}`);
  }
  const tempPath = path.join(os.tmpdir(), `legalviz-search-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fsp.writeFile(tempPath, buffer);
  return tempPath;
}

async function extractXmlFromZip(zipPath) {
  const { stdout: listing } = await execFileAsync("unzip", ["-Z1", zipPath]);
  const entries = listing.split("\n").map((line) => line.trim()).filter(Boolean);

  let docEntry = entries.find((entry) => entry.endsWith(".doc.fmx.xml"));
  const isOldFormat = !docEntry;
  if (!docEntry) {
    docEntry = entries.find((entry) => entry.endsWith(".doc.xml"));
  }
  if (!docEntry) {
    throw new Error(`No manifest XML entry found in ${zipPath}`);
  }

  const { stdout: manifest } = await execFileAsync("unzip", ["-p", zipPath, docEntry], {
    maxBuffer: 50 * 1024 * 1024
  });

  const refPattern = /FILE="([^"]+)"/g;
  const refs = [];
  let match;
  while ((match = refPattern.exec(manifest)) !== null) {
    const ref = match[1];
    const isDataFile = isOldFormat
      ? ref.endsWith(".xml") && !ref.endsWith(".doc.xml")
      : ref.endsWith(".fmx.xml");
    if (isDataFile && ref !== docEntry && entries.includes(ref)) {
      refs.push(ref);
    }
  }

  if (!refs.length) {
    const ext = isOldFormat ? ".xml" : ".fmx.xml";
    for (const entry of entries) {
      if (entry.endsWith(ext) && entry !== docEntry && !entry.endsWith(".doc.xml")) {
        refs.push(entry);
      }
    }
  }

  const parts = [];
  for (const ref of refs) {
    const { stdout } = await execFileAsync("unzip", ["-p", zipPath, ref], {
      maxBuffer: 50 * 1024 * 1024
    });
    parts.push(stdout.replace(/<\?xml[^?]*\?>/, "").trim());
  }

  return parts.join("\n");
}

// Returns { title, excerpt }. Title extraction (regex-based) and excerpt
// extraction (shared FMX parser) are independent: a title miss must not
// suppress an excerpt hit, and vice versa.
async function extractOfficialTitleAndExcerpt(celex) {
  const fmx4Uri = await findFmx4Uri(celex, "ENG");
  const download = await findDownloadUrls(fmx4Uri);

  if (download.type === "xml") {
    for (const url of download.urls) {
      const xml = await fetchText(url);
      const title = extractTitleFromXml(xml);
      if (title) return { title, excerpt: await extractExcerptFromXml(xml) };
    }
    return { title: null, excerpt: "" };
  }

  const zipPath = await downloadToTempFile(download.urls[0]);
  try {
    const xml = await extractXmlFromZip(zipPath);
    const title = extractTitleFromXml(xml);
    const excerpt = await extractExcerptFromXml(xml);
    return { title, excerpt };
  } finally {
    await fsp.rm(zipPath, { force: true });
  }
}

async function extractOfficialTitleFromEurlexHtml(celex) {
  const html = await fetchTextWithChallengeRetry(`${EURLEX_BASE}/legal-content/EN/TXT/?uri=CELEX:${encodeURIComponent(celex)}`, {
    "Accept-Language": "en"
  });

  return extractTitleFromEurlexHtml(html);
}

async function extractOfficialTitleWithFallback(celex) {
  let fmxError = null;
  let excerpt = "";

  try {
    const result = await extractOfficialTitleAndExcerpt(celex);
    excerpt = result.excerpt || "";
    if (result.title) return { title: result.title, source: "fmx", fmxError: null, excerpt };
    fmxError = new Error(`No title extracted from FMX for ${celex}`);
  } catch (error) {
    fmxError = error;
  }

  const title = await extractOfficialTitleFromEurlexHtml(celex);
  if (title) {
    // The HTML fallback path has no FMX XML to pull recitals/articles from,
    // but a partially-successful FMX fetch above may still have yielded one.
    return { title, source: "html", fmxError, excerpt };
  }

  if (fmxError) throw fmxError;
  return { title: null, source: null, fmxError: null, excerpt };
}

function toRecord(binding) {
  const celex = binding.celex?.value;
  return {
    celex,
    title: normalizeTitle(binding.title?.value || null),
    date: binding.date?.value || null,
    eli: binding.eli?.value || null,
    type: inferTypeFromCelex(celex),
    fmxAvailable: false,
    fmxUnavailable: false,
    enrichError: null
  };
}

async function harvestPrimaryActs({ fromYear, toYear, limit, runSparqlImpl = runSparql }) {
  const records = new Map();
  for (let year = fromYear; year >= toYear; year -= 1) {
    let offset = 0;
    let yearCount = 0;
    while (true) {
      logProgress(`Harvesting year ${year}, offset ${offset}`);
      const data = await runSparqlImpl(buildYearQuery({ year, limit, offset }));
      const bindings = data.results?.bindings || [];
      const incoming = bindings.map(toRecord);
      for (const record of incoming) {
        records.set(record.celex, record);
      }
      yearCount += incoming.length;
      if (bindings.length < limit) break;
      offset += limit;
    }
    logProgress(`Harvested ${yearCount} records for ${year}`);
  }
  return [...records.values()].filter((record) => record.celex && record.eli);
}

function ensurePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function writeJsonAtomically(filePath, payload) {
  ensureSearchCacheDir();
  const tempPath = `${filePath}.tmp`;
  await fsp.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fsp.rename(tempPath, filePath);
}

async function writeStateAtomically(statePath, payload) {
  await writeJsonAtomically(statePath, payload);
}

function readState(statePath) {
  if (!fs.existsSync(statePath)) return null;
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

function readCachePayload(cachePath) {
  if (!fs.existsSync(cachePath)) {
    throw new Error(`Search cache not found at ${cachePath}`);
  }

  return JSON.parse(fs.readFileSync(cachePath, "utf8"));
}

function createStatePayload({
  cachePath,
  concurrency,
  fromYear,
  harvestedCount,
  lastCompletedAt,
  maxRecords,
  nextIndex,
  processed,
  records,
  startedAt,
  statePath,
  phase,
  toYear,
  limit,
  finished,
}) {
  const enriched = records.filter((record) => record.fmxAvailable).length;
  const failed = records.filter((record) => record.enrichError && !record.fmxAvailable).length;
  return {
    cachePath,
    concurrency,
    finished: Boolean(finished),
    fromYear,
    harvestedCount,
    lastCompletedAt: lastCompletedAt || null,
    limit,
    maxRecords: maxRecords || null,
    nextIndex,
    phase,
    processed,
    enriched,
    failed,
    records,
    startedAt,
    statePath,
    toYear,
  };
}

async function enrichRecords(records, options = {}) {
  const concurrency = ensurePositiveInt(options.concurrency, 6);
  const startIndex = ensurePositiveInt(options.startIndex, 0) - 1 >= 0
    ? ensurePositiveInt(options.startIndex, 0)
    : 0;
  const maxRecords = options.maxRecords ? ensurePositiveInt(options.maxRecords, 0) : 0;
  const shouldProcess = typeof options.shouldProcess === "function"
    ? options.shouldProcess
    : () => true;
  const eligibleIndices = [];

  for (let index = startIndex; index < records.length; index += 1) {
    if (!shouldProcess(records[index], index)) continue;
    eligibleIndices.push(index);
    if (maxRecords && eligibleIndices.length >= maxRecords) break;
  }

  let processed = 0;
  let enriched = 0;
  let failed = 0;

  for (let batchStart = 0; batchStart < eligibleIndices.length; batchStart += concurrency) {
    const batchIndices = eligibleIndices.slice(batchStart, batchStart + concurrency);
    const batchEnd = batchStart + batchIndices.length;
    const batchResults = await Promise.all(batchIndices.map(async (index) => {
      const current = records[index];
      const next = { ...current };
      try {
        const titleResult = await extractOfficialTitleWithFallback(current.celex);
        if (titleResult.title) next.title = normalizeTitle(titleResult.title);
        next.excerpt = titleResult.excerpt || "";
        next.fmxAvailable = titleResult.source === "fmx";
        next.fmxUnavailable = Boolean(titleResult.fmxError)
          && String(titleResult.fmxError.message || titleResult.fmxError).includes("No FMX URI found");
        next.enrichError = titleResult.source === "html"
          ? (titleResult.fmxError?.message || null)
          : null;
      } catch (error) {
        next.excerpt = next.excerpt || "";
        next.fmxAvailable = false;
        next.fmxUnavailable = String(error.message || error).includes("No FMX URI found");
        next.enrichError = error.message;
      }
      return { index, record: enrichSearchRecord(next) };
    }));

    for (const result of batchResults) {
      records[result.index] = result.record;
      processed += 1;
      if (result.record.fmxAvailable) {
        enriched += 1;
      } else {
        failed += 1;
      }
    }

    if (typeof options.onBatchComplete === "function") {
      await options.onBatchComplete({
        batchEnd,
        batchStart,
        endExclusive: eligibleIndices.length,
        enriched,
        failed,
        processed,
        total: eligibleIndices.length,
      });
    }

    const logInterval = Math.max(concurrency * 25, 100);
    if (batchEnd === eligibleIndices.length || batchEnd % logInterval === 0) {
      logProgress(
        `Enriched ${batchEnd}/${eligibleIndices.length} eligible records in this pass (${processed} processed, ${enriched} with FMX, ${failed} failed)`
      );
    }
  }

  return {
    records,
    nextIndex: eligibleIndices.length ? (eligibleIndices[eligibleIndices.length - 1] + 1) : startIndex,
    processed,
    enriched,
    failed,
    complete: true,
  };
}

async function reEnrichCurrentCache(options = {}) {
  const cachePath = options.cachePath || DEFAULT_SEARCH_CACHE_PATH;
  const concurrency = ensurePositiveInt(options.concurrency, 6);
  const maxRecords = options.maxRecords ? ensurePositiveInt(options.maxRecords, 0) : 0;
  const onlyMissingTitles = options.onlyMissingTitles !== false;
  const primaryActsOnly = options.primaryActsOnly !== false;
  const payload = readCachePayload(cachePath);
  const records = Array.isArray(payload.records)
    ? payload.records.map((record) => enrichSearchRecord(record))
    : [];

  const eligibleCount = records.filter((record) => (
    (!primaryActsOnly || record.isPrimaryAct)
    && (
    !onlyMissingTitles || !normalizeTitle(record.title)
    )
  )).length;

  logProgress(`Loaded ${records.length} records from existing cache at ${cachePath}`);
  logProgress(
    `${primaryActsOnly ? "Primary-act" : "All-record"} cache refresh targeting ${eligibleCount} records`
  );

  const enrichResult = await enrichRecords(records, {
    concurrency,
    maxRecords,
    shouldProcess(record) {
      if (primaryActsOnly && !record.isPrimaryAct) return false;
      return onlyMissingTitles ? !normalizeTitle(record.title) : true;
    }
  });

  const nextPayload = {
    ...payload,
    generatedAt: new Date().toISOString(),
    records: enrichResult.records
  };
  nextPayload.count = nextPayload.records.length;

  await writeCacheAtomically(cachePath, nextPayload);
  return nextPayload;
}

async function writeCacheAtomically(cachePath, payload) {
  await writeJsonAtomically(cachePath, payload);
}

async function buildSearchCache(options = {}) {
  if (options.existingCacheOnly) {
    return reEnrichCurrentCache(options);
  }

  const fromYear = Number.parseInt(options.fromYear || String(new Date().getUTCFullYear()), 10);
  const toYear = Number.parseInt(options.toYear || "2010", 10);
  const limit = Number.parseInt(options.limit || "200", 10);
  const cachePath = options.cachePath || DEFAULT_SEARCH_CACHE_PATH;
  const statePath = options.statePath || DEFAULT_SEARCH_STATE_PATH;
  const concurrency = ensurePositiveInt(options.concurrency, 6);
  const maxRecords = options.maxRecords ? ensurePositiveInt(options.maxRecords, 0) : 0;
  const shouldResume = Boolean(options.resume);

  let records;
  let startedAt;
  let nextIndex = 0;
  let phase = "harvest";

  if (shouldResume) {
    const state = readState(statePath);
    if (!state) {
      throw new Error(`No build state found at ${statePath}`);
    }
    records = Array.isArray(state.records) ? state.records : [];
    startedAt = state.startedAt || new Date().toISOString();
    nextIndex = ensurePositiveInt(state.nextIndex, 0);
    phase = state.phase || "enrich";
    logProgress(`Resuming from ${statePath} at index ${nextIndex}/${records.length}`);
  } else {
    startedAt = new Date().toISOString();
    records = (await harvestPrimaryActs({ fromYear, toYear, limit })).map((record) => enrichSearchRecord(record));
    phase = "enrich";
    await writeStateAtomically(statePath, createStatePayload({
      cachePath,
      concurrency,
      fromYear,
      harvestedCount: records.length,
      lastCompletedAt: null,
      limit,
      maxRecords,
      nextIndex: 0,
      phase,
      processed: 0,
      records,
      startedAt,
      statePath,
      toYear,
      finished: false,
    }));
    logProgress(`Harvest complete with ${records.length} records`);
  }

  const enrichResult = await enrichRecords(records, {
    concurrency,
    maxRecords,
    startIndex: nextIndex,
    async onBatchComplete(batch) {
      await writeStateAtomically(statePath, createStatePayload({
        cachePath,
        concurrency,
        fromYear,
        harvestedCount: records.length,
        lastCompletedAt: new Date().toISOString(),
        limit,
        maxRecords,
        nextIndex: batch.batchEnd,
        phase,
        processed: batch.batchEnd,
        records,
        startedAt,
        statePath,
        toYear,
        finished: false,
      }));
    },
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    fromYear,
    toYear,
    records: enrichResult.records
      .filter((record) => record.isPrimaryAct)
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))
  };
  payload.count = payload.records.length;

  await writeCacheAtomically(cachePath, payload);
  await writeStateAtomically(statePath, createStatePayload({
    cachePath,
    concurrency,
    fromYear,
    harvestedCount: enrichResult.records.length,
    lastCompletedAt: new Date().toISOString(),
    limit,
    maxRecords,
    nextIndex: enrichResult.nextIndex,
    phase: enrichResult.complete ? "complete" : "enrich",
    processed: enrichResult.nextIndex,
    records: enrichResult.records,
    startedAt,
    statePath,
    toYear,
    finished: enrichResult.complete,
  }));
  return payload;
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }

  const payload = await buildSearchCache(options);
  console.log(`Built law search cache with ${payload.count} records at ${options.cachePath || DEFAULT_SEARCH_CACHE_PATH}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_SEARCH_CACHE_PATH,
  DEFAULT_SEARCH_STATE_PATH,
  EXCERPT_MAX_LENGTH,
  buildExcerptFromCombined,
  buildSearchCache,
  extractExcerptFromXml,
  harvestPrimaryActs,
  buildYearQuery,
  ensurePositiveInt,
  extractTitleFromEurlexHtml,
  extractOfficialTitleWithFallback,
  findFmx4Uri,
  logProgress,
  normalizeYearQueryActTypes,
  reEnrichCurrentCache,
  runSparql
};
