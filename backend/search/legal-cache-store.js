const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const Database = require("better-sqlite3");
const MiniSearch = require("minisearch");

const {
  determineMatchReason,
  enrichSearchRecord,
  parseStructuredQuery,
} = require("./search-ranking");

const BUILTIN_SEARCH_CACHE_PATH = path.join(__dirname, "data", "search-cache.json");
const DEFAULT_SEARCH_CACHE_PATH = process.env.SEARCH_CACHE_PATH || BUILTIN_SEARCH_CACHE_PATH;
const DEFAULT_SQLITE_DATA_PATH = path.join(__dirname, "data", "data.sqlite");
const DEFAULT_DEFINITIONS_PATH = path.join(__dirname, "data", "definitions.json");
const DEFAULT_FULLTEXT_SQLITE_PATH = path.join(__dirname, "data", "fulltext.sqlite");
const SQLITE_SCHEMA_VERSION = 4;
// Own copy of the version stamped by fulltext-index-build.js (FULLTEXT_SCHEMA_VERSION
// there) — citation-graph-store.js style: a separate optional artifact keeps its own
// lock-step constant rather than importing across files. Bump both together.
const FULLTEXT_SCHEMA_VERSION = 1;

const SUPPLEMENTAL_RECORDS = [
  {
    celex: "32000L0031",
    title: "Directive 2000/31/EC of the European Parliament and of the Council of 8 June 2000 on certain legal aspects of information society services, in particular electronic commerce, in the Internal Market (Directive on electronic commerce)",
    type: "directive",
    date: "2000-06-08",
    eli: "http://data.europa.eu/eli/dir/2000/31/oj",
    fmxAvailable: false,
    fmxUnavailable: false,
  },
  {
    celex: "32002L0058",
    title: "Directive 2002/58/EC of the European Parliament and of the Council of 12 July 2002 concerning the processing of personal data and the protection of privacy in the electronic communications sector (Directive on privacy and electronic communications)",
    type: "directive",
    date: "2002-07-12",
    eli: "http://data.europa.eu/eli/dir/2002/58/oj",
    fmxAvailable: false,
    fmxUnavailable: false,
  },
];

function mergeSupplementalRecords(records) {
  const merged = Array.isArray(records) ? [...records] : [];
  const seen = new Set(merged.map((record) => normalizeCelexLookupKey(record?.celex)).filter(Boolean));

  for (const record of SUPPLEMENTAL_RECORDS) {
    const celexKey = normalizeCelexLookupKey(record.celex);
    if (celexKey && !seen.has(celexKey)) {
      merged.push(record);
      seen.add(celexKey);
    }
  }

  return merged;
}

function normalizeCelexLookupKey(celex) {
  const normalized = String(celex || "").trim().toUpperCase();
  return normalized || null;
}

function normalizeDefinitionTerm(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[‘’‛`]/g, "'")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[\s'"“”]+|[\s'"“”.,;:]+$/g, "")
    .toLocaleLowerCase("en");
}

function readOptionalJson(inputPath) {
  const gzPath = `${inputPath}.gz`;
  const resolved = fs.existsSync(inputPath) ? inputPath : (fs.existsSync(gzPath) ? gzPath : null);
  if (!resolved) return null;
  const raw = resolved.endsWith(".gz")
    ? zlib.gunzipSync(fs.readFileSync(resolved)).toString("utf8")
    : fs.readFileSync(resolved, "utf8");
  return JSON.parse(raw);
}

function normalizeEliLookupKey(eli) {
  const normalized = String(eli || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/^https:/i, "http:")
    .toLowerCase();
  return normalized || null;
}

function normalizeReferenceNumber(value) {
  if (value == null) return null;
  const digits = String(value).trim();
  if (!/^\d+$/.test(digits)) return null;
  return String(Number.parseInt(digits, 10));
}

function normalizeOfficialReferenceLookupKey(reference) {
  const actType = String(reference?.actType || "").trim().toLowerCase();
  const year = String(reference?.year || "").trim();
  const number = normalizeReferenceNumber(reference?.number);

  if (!actType || !year || !number) return null;
  return `${actType}|${year}|${number}`;
}

function buildCanonicalEliFromReference(reference) {
  const actType = String(reference?.actType || "").trim().toLowerCase();
  const year = String(reference?.year || "").trim();
  const number = normalizeReferenceNumber(reference?.number);
  const segmentByType = {
    regulation: "reg",
    directive: "dir",
    decision: "dec",
  };
  const segment = segmentByType[actType];

  if (!segment || !year || !number) return null;
  return `http://data.europa.eu/eli/${segment}/${year}/${number}/oj`;
}

function getDeterministicMatch(index, key) {
  if (!key) return null;
  const matches = index.get(key) || [];
  return matches.length === 1 ? matches[0] : null;
}

// MiniSearch throws on a duplicate id, so a single duplicated CELEX would
// otherwise take down the whole search index. Keep one record per CELEX and
// drop records without a usable CELEX (they can't be indexed). The other
// lookup maps intentionally keep duplicates so they can flag ambiguity.
function dedupeByCelex(records) {
  const seen = new Set();
  const unique = [];
  for (const record of records) {
    const key = normalizeCelexLookupKey(record.celex);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(record);
  }
  return unique;
}

// excerpt (recitals + Art. 1/2 body text, see search-build.js) exists purely
// to add recall for conceptual queries that never hit a title/alias term
// (e.g. "automated decision-making"). It is long, unstructured body text, so
// it gets a boost an order of magnitude below title/aliases: enough to
// surface a law that free text alone would otherwise miss entirely, but not
// enough for body-text noise to outrank a genuine title/alias match.
const EXCERPT_BOOST = 0.3;
const EUROVOC_BOOST = 0.8;
const IN_FORCE_BOOST = 1.08;
const NO_LONGER_IN_FORCE_BOOST = 0.9;
const MAX_CITATION_BOOST = 1.2;
const MAX_GLOBAL_PRIOR = 1.25;
const CITATION_LOG_SCALE = 0.025;
const RRF_K = 20;
const CANDIDATE_LIMIT = 200;
const FULLTEXT_QUERY_MAX_CHARS = 200;
const FULLTEXT_MAX_TERMS = 12;
const FULLTEXT_MIN_STANDALONE_TERM_CHARS = 2;
const FULLTEXT_RESULT_LIMIT = 50;
// Public full-text search deliberately scans a bounded, bm25-ordered window.
// 500 units is large enough to diversify common terms across acts while
// keeping short-prefix queries from walking the entire 382k-unit index.
const FULLTEXT_UNIT_CANDIDATE_CAP = 500;
const FULLTEXT_SNIPPET_START = "\u0002";
const FULLTEXT_SNIPPET_END = "\u0003";
// Title and controlled-vocabulary evidence are co-equal. Body-text matches are
// useful for recall but deliberately weaker because recitals contain many
// incidental concepts. Selected on the development split; see eval/README.md.
// Full-text fusion is disabled by default: the real-data evaluation found no
// measurable ranking benefit. The explicit source wiring remains available for
// controlled re-evaluation; the public body-text search uses the same index
// independently of this ranking weight.
const SOURCE_WEIGHTS = { title: 1.1, eurovoc: 1.1, excerpt: 0.5, fulltext: 0 };
const COVERAGE_EXPONENT = 2;

function citationBoost(count, {
  citationLogScale = CITATION_LOG_SCALE,
  maxCitationBoost = MAX_CITATION_BOOST,
} = {}) {
  const citations = Math.max(0, Number(count) || 0);
  return Math.min(maxCitationBoost, 1 + citationLogScale * Math.log1p(citations));
}

function requestsHistoricalLaw(parsed) {
  return /\b(?:former|historic|historical|old|repealed|repeal|expired|obsolete|superseded|no longer in force)\b/i
    .test(String(parsed.originalQuery || ""));
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// `inForce: false` covers two opposite situations, and only an entry-into-force
// date separates them: an act that has fallen out of force, and one that is
// published but has not entered into force yet. Acts are harvested when
// published, normally before entry into force, so every new act spends its
// first weeks reading `false` — and without this it was ranked, and labelled,
// as though it had expired.
function isNotYetInForce(record, today = todayIso()) {
  return record?.inForce === false
    && typeof record?.entryIntoForce === "string"
    && record.entryIntoForce > today;
}

function buildMiniSearch(records, { includeExcerpt = true, includeEurovoc = true } = {}) {
  const fields = ["title", "aliases"];
  if (includeEurovoc) fields.push("eurovoc");
  if (includeExcerpt) fields.push("excerpt");
  const boost = { aliases: 3, title: 1 };
  if (includeEurovoc) boost.eurovoc = EUROVOC_BOOST;
  if (includeExcerpt) boost.excerpt = EXCERPT_BOOST;
  const miniSearch = new MiniSearch({
    idField: "celex",
    fields,
    storeFields: ["type", "inForce", "notYetInForce"],
    searchOptions: {
      boost,
      fuzzy: 0.2,
      prefix: true,
      combineWith: "AND",
    },
  });

  const today = todayIso();
  miniSearch.addAll(dedupeByCelex(records).map((record) => ({
    celex: record.celex,
    title: record.title || "",
    // Exact CELEX/type aliases are handled by deterministic maps before
    // MiniSearch. Excluding them here avoids ~80k unique CELEX terms and huge
    // low-value postings for the three act-type words, while retaining named
    // aliases/acronyms for fuzzy and prefix matching.
    aliases: searchableAliases(record).join(" "),
    eurovoc: (record.eurovoc || []).join(" "),
    excerpt: record.excerpt || "",
    type: record.type,
    inForce: record.inForce,
    // Resolved once here rather than per query hit: "in the future" is relative
    // to index-build time, which moves when the store is rebuilt.
    notYetInForce: isNotYetInForce(record, today),
  })));

  return miniSearch;
}

function buildEurovocSearch(records) {
  const miniSearch = new MiniSearch({
    idField: "celex",
    fields: ["eurovoc"],
    searchOptions: {
      fuzzy: false,
      prefix: true,
      combineWith: "AND",
    },
  });
  miniSearch.addAll(dedupeByCelex(records).map((record) => ({
    celex: record.celex,
    eurovoc: (record.eurovoc || []).join(" "),
  })));
  return miniSearch;
}

function buildExcerptMiniSearch(records) {
  const miniSearch = new MiniSearch({
    idField: "celex",
    fields: ["excerpt"],
    searchOptions: {
      fuzzy: false,
      prefix: true,
      combineWith: "AND",
    },
  });
  miniSearch.addAll(dedupeByCelex(records).map((record) => ({
    celex: record.celex,
    excerpt: record.excerpt || "",
  })));
  return miniSearch;
}

function searchableAliases(record) {
  const celex = normalizeCelexLookupKey(record.celex)?.toLowerCase() || "";
  const type = String(record.type || "").toLowerCase();
  const structural = new Set([
    celex,
    type,
    `${type} ${celex}`.trim(),
    `${type}${celex}`,
  ]);
  return (record.aliases || []).filter((alias) => !structural.has(alias));
}

// NOTE: this is an explicit whitelist, not a projection — a field added to the
// cache records upstream is dropped here unless it is named below, and nothing
// errors when that happens. enrichSearchRecord spreads `{...record}`, so new
// fields survive *it* and appear to flow through end to end in a JSON-cache dev
// checkout, then silently vanish in production, which loads from SQLite. Add the
// field here and to the result mapping in searchLaws() below, or it will not
// reach the client.
function compactSqliteRecord(record) {
  const enriched = enrichSearchRecord(record);
  if (!enriched.isPrimaryAct) return null;
  return {
    celex: enriched.celex,
    title: enriched.title,
    date: enriched.date || null,
    eli: enriched.eli || null,
    type: enriched.type,
    fmxAvailable: enriched.fmxAvailable,
    fmxUnavailable: enriched.fmxUnavailable,
    enrichError: enriched.enrichError,
    eurovoc: enriched.eurovoc,
    // Passed through undefined-and-all, like eurovoc above: JSON.stringify drops
    // an undefined key, so a record predating the field hydrates identically
    // from JSON and from SQLite. Coercing to null here instead would store an
    // explicit null and break that parity. Normalisation belongs at the wire
    // boundary (searchLaws), not here.
    inForce: enriched.inForce,
    endOfValidity: enriched.endOfValidity,
    entryIntoForce: enriched.entryIntoForce,
    celexYear: enriched.celexYear,
    celexNumber: enriched.celexNumber,
    aliases: enriched.aliases,
  };
}

function buildFtsExpression(terms, operator) {
  return terms
    .filter((term) => /^[a-z0-9]+$/i.test(term))
    .map((term) => `"${term}"*`)
    .join(` ${operator} `);
}

function fulltextSearchParts(query) {
  const value = String(query ?? "").normalize("NFKC").trim();
  const parts = [];
  const searchableTerms = [];
  const addWords = (text, { phrase = false } = {}) => {
    const words = String(text || "").match(/[\p{L}\p{M}\p{N}]+/gu) || [];
    // FTS operators are harmless here because every token is quoted below;
    // keep words such as "or" and "not" searchable as ordinary body text.
    const searchableWords = words;
    if (searchableWords.length === 0) return;
    searchableTerms.push(...searchableWords);
    if (phrase) {
      parts.push({ phrase: true, value: searchableWords.join(" ") });
    } else {
      for (const word of searchableWords) parts.push({ phrase: false, value: word });
    }
  };

  // Quoted segments are retained as one FTS phrase. Text outside quotes is
  // tokenised into independent prefix terms. Unmatched quotes are harmless:
  // the remaining text is still searched as ordinary terms.
  const quoted = /"([^"]*)"/g;
  let lastIndex = 0;
  let match;
  while ((match = quoted.exec(value))) {
    addWords(value.slice(lastIndex, match.index));
    addWords(match[1], { phrase: true });
    lastIndex = match.index + match[0].length;
  }
  addWords(value.slice(lastIndex));
  return { value, parts, terms: searchableTerms };
}

function buildFulltextMatchExpression(query) {
  const parsed = fulltextSearchParts(query);
  if (parsed.value.length > FULLTEXT_QUERY_MAX_CHARS) return "";
  if (parsed.terms.length === 0 || parsed.terms.length > FULLTEXT_MAX_TERMS) return "";
  return parsed.parts.map((part) => {
    // Every token is inside an FTS5 quoted string. Doubling a quote is the
    // FTS5 escape; in practice words are already stripped to tokenizer terms.
    const escaped = part.value.replace(/"/g, "\"\"");
    return part.phrase ? `"${escaped}"` : `"${escaped}"*`;
  }).join(" AND ");
}

function fulltextQueryError(query) {
  const parsed = fulltextSearchParts(query);
  if (!parsed.value) {
    const error = new Error('Query parameter "q" required');
    error.code = "fulltext_query_required";
    return error;
  }
  if (parsed.value.length > FULLTEXT_QUERY_MAX_CHARS) {
    const error = new Error(`Full-text queries are limited to ${FULLTEXT_QUERY_MAX_CHARS} characters`);
    error.code = "fulltext_query_too_long";
    return error;
  }
  if (parsed.terms.length === 0) {
    const error = new Error("Full-text query must contain at least one searchable term");
    error.code = "fulltext_query_empty";
    return error;
  }
  if (parsed.terms.every((term) => Array.from(term).length < FULLTEXT_MIN_STANDALONE_TERM_CHARS)) {
    const error = new Error(`Full-text query must contain a term of at least ${FULLTEXT_MIN_STANDALONE_TERM_CHARS} characters`);
    error.code = "fulltext_query_too_short";
    return error;
  }
  if (parsed.terms.length > FULLTEXT_MAX_TERMS) {
    const error = new Error(`Full-text queries are limited to ${FULLTEXT_MAX_TERMS} searchable terms`);
    error.code = "fulltext_query_too_many_terms";
    return error;
  }
  return null;
}

function validateFulltextQuery(query) {
  return fulltextQueryError(query);
}

function cleanFulltextSnippet(rawSnippet) {
  const ranges = [];
  let text = "";
  let rangeStart = null;
  const raw = String(rawSnippet || "");
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === FULLTEXT_SNIPPET_START) {
      rangeStart = text.length;
      continue;
    }
    if (character === FULLTEXT_SNIPPET_END) {
      if (rangeStart != null && text.length > rangeStart) {
        ranges.push({ start: rangeStart, end: text.length });
      }
      rangeStart = null;
      continue;
    }
    // The indexed source is already plain text. Preserve literal angle
    // brackets and only remove FTS markers or source control bytes.
    const characterCode = character.charCodeAt(0);
    if (characterCode <= 0x1f || (characterCode >= 0x7f && characterCode <= 0x9f)) continue;
    text += character;
  }
  if (rangeStart != null && text.length > rangeStart) ranges.push({ start: rangeStart, end: text.length });
  return { snippet: text, highlightRanges: ranges };
}

function containedAliasKeys(normalizedQuery) {
  const words = String(normalizedQuery || "").split(" ").filter(Boolean);
  const keys = [];
  const maxWords = Math.min(8, words.length - 1);
  for (let length = maxWords; length >= 2; length -= 1) {
    for (let start = 0; start + length <= words.length; start += 1) {
      const phrase = words.slice(start, start + length).join(" ");
      keys.push(phrase, phrase.replace(/\s+/g, ""));
    }
  }
  return [...new Set(keys)];
}

// Query-dependent and global priors for MiniSearch relevance. This only
// reshuffles the free-text stage: deterministic celex/reference/alias matches
// run first and are unaffected. Type intent remains the strongest prior;
// current status and distinct citing acts are deliberately small and capped.
function buildDocumentBoost(parsed, citationCounts = new Map(), {
  useGlobalPriors = true,
  useStatusPrior = true,
  useCitationPrior = true,
  inForceBoost = IN_FORCE_BOOST,
  noLongerInForceBoost = NO_LONGER_IN_FORCE_BOOST,
  citationLogScale = CITATION_LOG_SCALE,
  maxCitationBoost = MAX_CITATION_BOOST,
  maxGlobalPrior = MAX_GLOBAL_PRIOR,
} = {}) {
  const query = String(parsed.originalQuery || "").toLowerCase();
  const mentionsAct = /\bact\b/.test(query);
  const mentionsDirective = /\bdirective\b/.test(query);
  const mentionsRegulation = /\bregulation\b/.test(query);

  const historicalIntent = requestsHistoricalLaw(parsed);

  return (id, _term, stored) => {
    const type = stored && stored.type;
    let boost = 1;
    if (type === "decision") boost *= mentionsAct ? 0.3 : 0.6;
    else if (type === "directive") boost *= mentionsDirective ? 1.5 : 1.05;
    else if (type === "regulation") boost *= mentionsRegulation ? 1.5 : 1.1;
    if (mentionsDirective && type === "regulation") boost *= 0.7;
    if (mentionsRegulation && type === "directive") boost *= 0.7;
    if (useGlobalPriors) {
      let statusBoost = 1;
      if (useStatusPrior) {
        // An act that has not entered into force yet is neither current nor
        // historical, so it takes neither prior. It reads `inForce: false`, and
        // without this branch a regulation taking effect next week was demoted
        // as though it had expired — during exactly the weeks people search for
        // it. Left neutral rather than boosted: fixing the penalty is this
        // change; promoting upcoming law over current law would be a different
        // one, and needs its own evidence.
        if (stored?.notYetInForce) statusBoost = 1;
        else if (historicalIntent && stored?.inForce === false) statusBoost = inForceBoost;
        else if (historicalIntent && stored?.inForce === true) statusBoost = noLongerInForceBoost;
        else if (stored?.inForce === true) statusBoost = inForceBoost;
        else if (stored?.inForce === false) statusBoost = noLongerInForceBoost;
      }
      const authorityBoost = useCitationPrior
        ? citationBoost(citationCounts.get(normalizeCelexLookupKey(id)), {
          citationLogScale,
          maxCitationBoost,
        })
        : 1;
      boost *= Math.min(maxGlobalPrior, statusBoost * authorityBoost);
    }
    return boost;
  };
}

// The fulltext fusion path builds its own `stored` rather than reading
// MiniSearch's, so notYetInForce has to be recomputed here or upcoming acts
// keep the out-of-force penalty in fulltext results only.
function documentPrior(parsed, law, citationCounts, options) {
  const boost = buildDocumentBoost(parsed, citationCounts, options);
  return boost(law.celex, "", {
    type: law.type,
    inForce: law.inForce,
    notYetInForce: isNotYetInForce(law),
  });
}

class JsonLegalCacheStore {
  constructor(cachePath = DEFAULT_SEARCH_CACHE_PATH, options = {}) {
    this.cachePath = cachePath;
    const explicitSqlitePath = options.sqlitePath || null;
    const environmentSqlitePath = options.preferJson
      ? null
      : (process.env.DATA_SQLITE_PATH || null);
    const configuredSqlitePath = explicitSqlitePath || environmentSqlitePath;
    const hasJsonOverride = Boolean(process.env.SEARCH_CACHE_PATH);
    this.sqlitePath = configuredSqlitePath ||
      (!options.preferJson && !hasJsonOverride && cachePath === BUILTIN_SEARCH_CACHE_PATH
        ? DEFAULT_SQLITE_DATA_PATH
        : null);
    this.requireSqlite = options.requireSqlite ?? Boolean(configuredSqlitePath);
    this.definitionsPath = options.definitionsPath
      || (cachePath === BUILTIN_SEARCH_CACHE_PATH
        ? DEFAULT_DEFINITIONS_PATH
        : path.join(path.dirname(cachePath), "definitions.json"));
    // fulltext.sqlite is a separate, independently optional artifact (not part of
    // the sqlitePath/JSON fallback chain above) — resolved the same way (explicit
    // option, then env, then default), but its absence never affects the rest of
    // load().
    this.fulltextPath = options.fulltextPath || process.env.FULLTEXT_SQLITE_PATH || DEFAULT_FULLTEXT_SQLITE_PATH;
    this.rankingProfile = options.rankingProfile === "baseline" ? "baseline" : "revised";
    this.rankingConfig = {
      rrfK: options.rankingConfig?.rrfK ?? RRF_K,
      candidateLimit: options.rankingConfig?.candidateLimit ?? CANDIDATE_LIMIT,
      coverageExponent: options.rankingConfig?.coverageExponent ?? COVERAGE_EXPONENT,
      sourceWeights: { ...SOURCE_WEIGHTS, ...(options.rankingConfig?.sourceWeights || {}) },
      useStatusPrior: options.rankingConfig?.useStatusPrior ?? true,
      useCitationPrior: options.rankingConfig?.useCitationPrior ?? true,
      inForceBoost: options.rankingConfig?.inForceBoost ?? IN_FORCE_BOOST,
      noLongerInForceBoost: options.rankingConfig?.noLongerInForceBoost ?? NO_LONGER_IN_FORCE_BOOST,
      citationLogScale: options.rankingConfig?.citationLogScale ?? CITATION_LOG_SCALE,
      maxCitationBoost: options.rankingConfig?.maxCitationBoost ?? MAX_CITATION_BOOST,
      maxGlobalPrior: options.rankingConfig?.maxGlobalPrior ?? MAX_GLOBAL_PRIOR,
    };
    this.payload = null;
    this.records = [];
    this.loadedAt = null;
    this.loadError = null;
    this.byCelex = new Map();
    this.byEli = new Map();
    this.byOfficialReference = new Map();
    this.byAlias = new Map();
    this.miniSearch = null;
    this.eurovocSearch = null;
    this.excerptMiniSearch = null;
    this.database = null;
    this.excerptSearchStatement = null;
    this.definitionSearchStatement = null;
    this.definitionOccurrenceStatement = null;
    this.definitionRepresentativeStatement = null;
    this.definitionUsageStatement = null;
    this.definitionTerms = [];
    this.definitionOccurrences = [];
    this.definitionsAvailable = false;
    this.citationCounts = new Map(options.citationCounts || []);
    this.source = null;
    // Build timestamp of the loaded search cache ("when was our dataset last
    // updated"), read from the SQLite `metadata` row / JSON `generatedAt`
    // field written by the builders — never regenerated here.
    this.datasetGeneratedAt = null;
    this.fulltextDatabase = null;
    this.fulltextSearchStatement = null;
    this.fulltextUnitSearchStatement = null;
    this.fulltextUnitScopedSearchStatement = null;
    this.fulltextUnitSnippetStatement = null;
    this.fulltextAvailable = false;
    this.fulltextReason = null;
    this.fulltextStats = { unitCount: 0, actCount: 0, version: null, generatedAt: null };
  }

  load() {
    this.close();
    this.loadFulltext();
    if (this.sqlitePath && fs.existsSync(this.sqlitePath)) {
      return this.loadFromSqlite();
    }
    if (this.requireSqlite) {
      return this.failLoad(`SQLite data store not found at ${this.sqlitePath}`);
    }
    return this.loadFromJson();
  }

  // Optional artifact, independent of the sqlitePath/JSON chain above. Any
  // failure — missing file, wrong PRAGMA user_version, missing/mismatched
  // fulltext_metadata row, or a thrown error from a corrupt file — leaves
  // fulltextAvailable false with a reason and never propagates (citation-graph
  // precedent: an optional artifact can never take down boot).
  loadFulltext() {
    this.fulltextDatabase = null;
    this.fulltextSearchStatement = null;
    this.fulltextUnitSearchStatement = null;
    this.fulltextUnitScopedSearchStatement = null;
    this.fulltextUnitSnippetStatement = null;
    this.fulltextAvailable = false;
    this.fulltextReason = null;
    this.fulltextStats = { unitCount: 0, actCount: 0, version: null, generatedAt: null };
    if (!this.fulltextPath || !fs.existsSync(this.fulltextPath)) {
      this.fulltextReason = `Full-text index not found at ${this.fulltextPath}`;
      return;
    }
    let database = null;
    try {
      database = new Database(this.fulltextPath, { readonly: true, fileMustExist: true });
      const schemaVersion = database.prepare("PRAGMA user_version").get().user_version;
      if (schemaVersion !== FULLTEXT_SCHEMA_VERSION) {
        this.fulltextReason = `Unsupported full-text index schema ${schemaVersion}; expected ${FULLTEXT_SCHEMA_VERSION}`;
        database.close();
        return;
      }
      const hasMetadataTable = database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fulltext_metadata'"
      ).get();
      if (!hasMetadataTable) {
        this.fulltextReason = "Full-text index has no fulltext_metadata table";
        database.close();
        return;
      }
      const metadata = new Map(
        database.prepare("SELECT key, value FROM fulltext_metadata").all().map((row) => [row.key, row.value])
      );
      const fulltextVersion = metadata.get("fulltext_version");
      if (!metadata.has("fulltext_version") || String(fulltextVersion) !== String(FULLTEXT_SCHEMA_VERSION)) {
        this.fulltextReason = `Unsupported fulltext_version ${fulltextVersion}; expected ${FULLTEXT_SCHEMA_VERSION}`;
        database.close();
        return;
      }
      this.fulltextSearchStatement = database.prepare(`
        SELECT u.celex AS celex
        FROM units_fts
        JOIN units u ON u.id = units_fts.rowid
        WHERE units_fts.text MATCH ?
        ORDER BY rank
        LIMIT 500
      `);
      const snippetStart = FULLTEXT_SNIPPET_START.replace(/'/g, "''");
      const snippetEnd = FULLTEXT_SNIPPET_END.replace(/'/g, "''");
      const snippet = `snippet(units_fts, 1, '${snippetStart}', '${snippetEnd}', ' … ', 40)`;
      this.fulltextUnitSearchStatement = database.prepare(`
        SELECT u.id AS id, u.celex AS celex, u.unit_type AS unitType,
               u.number AS number, u.heading AS heading,
               MIN(units_fts.rank) AS bestRank
        FROM units_fts
        JOIN units u ON u.id = units_fts.rowid
        WHERE units_fts.text MATCH ?
        GROUP BY u.celex
        ORDER BY bestRank, u.id
        LIMIT ${FULLTEXT_UNIT_CANDIDATE_CAP}
      `);
      this.fulltextUnitScopedSearchStatement = database.prepare(`
        SELECT u.id AS id, u.celex AS celex, u.unit_type AS unitType,
               u.number AS number, u.heading AS heading
        FROM units_fts
        JOIN units u ON u.id = units_fts.rowid
        WHERE units_fts.text MATCH ? AND u.celex = ?
        ORDER BY rank, u.id
        LIMIT ${FULLTEXT_UNIT_CANDIDATE_CAP}
      `);
      // Computing snippet() for the whole candidate window makes common-prefix
      // queries needlessly expensive. Rank/diversify first, then render only
      // the handful of units that cross the API boundary.
      const resultSlots = Array(FULLTEXT_RESULT_LIMIT).fill("?").join(", ");
      this.fulltextUnitSnippetStatement = database.prepare(`
        SELECT units_fts.rowid AS id, ${snippet} AS snippet
        FROM units_fts
        WHERE units_fts.rowid IN (${resultSlots}) AND units_fts.text MATCH ?
      `);
      this.fulltextStats = {
        unitCount: Number.parseInt(metadata.get("unit_count"), 10) || 0,
        actCount: Number.parseInt(metadata.get("act_count"), 10) || 0,
        version: fulltextVersion,
        generatedAt: metadata.get("generated_at") || null,
      };
      this.fulltextDatabase = database;
      this.fulltextAvailable = true;
    } catch (error) {
      if (database) {
        try { database.close(); } catch { /* already closed or failed */ }
      }
      this.fulltextDatabase = null;
      this.fulltextSearchStatement = null;
      this.fulltextUnitSearchStatement = null;
      this.fulltextUnitScopedSearchStatement = null;
      this.fulltextUnitSnippetStatement = null;
      this.fulltextAvailable = false;
      this.fulltextReason = error.message;
    }
  }

  // Dedupe to best-rank-per-celex in JS (bm25 can't be deduped in SQL without
  // losing rank order), capped at CANDIDATE_LIMIT for parity with the excerpt
  // source. Returns [] whenever the index isn't loaded — there is deliberately
  // no JSON/MiniSearch fallback for fulltext.
  searchFulltext(expression) {
    if (!this.fulltextAvailable || !this.fulltextSearchStatement || !expression) return [];
    const seen = new Set();
    const hits = [];
    for (const row of this.fulltextSearchStatement.all(expression)) {
      const celex = row.celex;
      if (!celex || seen.has(celex)) continue;
      seen.add(celex);
      hits.push({ celex });
      if (hits.length >= CANDIDATE_LIMIT) break;
    }
    return hits;
  }

  getFulltextStatus() {
    return {
      available: this.fulltextAvailable,
      version: this.fulltextStats.version,
      unitCount: this.fulltextStats.unitCount,
      actCount: this.fulltextStats.actCount,
      generatedAt: this.fulltextAvailable ? this.fulltextStats.generatedAt : null,
      reason: this.fulltextAvailable ? null : this.fulltextReason,
    };
  }

  requireFulltext() {
    if (this.fulltextAvailable) return;
    const error = new Error("Full-text index is not loaded");
    error.code = "fulltext_index_unavailable";
    error.details = this.getFulltextStatus();
    throw error;
  }

  searchFulltextUnits(query, options = {}) {
    this.requireFulltext();
    const queryError = fulltextQueryError(query);
    if (queryError) throw queryError;
    const expression = buildFulltextMatchExpression(query);
    if (!expression) return [];

    const rawLimit = Number.parseInt(options.limit, 10);
    const limit = Math.max(1, Math.min(Number.isFinite(rawLimit) ? rawLimit : 10, FULLTEXT_RESULT_LIMIT));
    const celex = options.celex ? normalizeCelexLookupKey(options.celex) : null;
    const rows = celex
      ? this.fulltextUnitScopedSearchStatement.all(expression, celex)
      : this.fulltextUnitSearchStatement.all(expression);
    const seen = new Set();
    const selected = [];
    for (const row of rows) {
      // Global discovery returns at most one best unit per act. A scoped query
      // intentionally keeps multiple provisions from the requested act.
      if (!celex && seen.has(row.celex)) continue;
      seen.add(row.celex);
      selected.push(row);
      if (selected.length >= limit) break;
    }
    if (selected.length === 0) return [];
    const snippetArgs = selected.map((row) => row.id);
    while (snippetArgs.length < FULLTEXT_RESULT_LIMIT) snippetArgs.push(-1);
    const snippets = new Map(
      this.fulltextUnitSnippetStatement.all(...snippetArgs, expression)
        .map((row) => [Number(row.id), row.snippet])
    );
    const results = [];
    for (const row of selected) {
      const rawSnippet = snippets.get(Number(row.id)) || "";
      const cleaned = cleanFulltextSnippet(rawSnippet);
      const record = this.getByCelex(row.celex);
      results.push({
        celex: normalizeCelexLookupKey(row.celex),
        title: record?.title || null,
        unitType: row.unitType || null,
        number: row.number || null,
        heading: row.heading || null,
        snippet: cleaned.snippet,
        highlightRanges: cleaned.highlightRanges,
      });
    }
    return results;
  }

  resetIndexes() {
    this.payload = null;
    this.records = [];
    this.loadedAt = null;
    this.byCelex = new Map();
    this.byEli = new Map();
    this.byOfficialReference = new Map();
    this.byAlias = new Map();
    this.miniSearch = null;
    this.definitionTerms = [];
    this.definitionOccurrences = [];
    this.definitionsAvailable = false;
    this.eurovocSearch = null;
    this.excerptMiniSearch = null;
    this.source = null;
    this.datasetGeneratedAt = null;
  }

  failLoad(message) {
    this.resetIndexes();
    this.loadError = message;
    return false;
  }

  indexRecords(records, { includeExcerpt }) {
    this.records = records;
    this.byCelex = new Map();
    this.byEli = new Map();
    this.byOfficialReference = new Map();
    this.byAlias = new Map();

    for (const record of records) {
      const celexKey = normalizeCelexLookupKey(record.celex);
      if (celexKey) {
        this.byCelex.set(celexKey, [record]);
      }

      const eliKey = normalizeEliLookupKey(record.eli);
      if (eliKey) {
        const matches = this.byEli.get(eliKey) || [];
        matches.push(record);
        this.byEli.set(eliKey, matches);
      }

      const referenceKey = normalizeOfficialReferenceLookupKey({
        actType: record.type,
        year: record.celexYear,
        number: record.celexNumber,
      });
      if (referenceKey) {
        const matches = this.byOfficialReference.get(referenceKey) || [];
        matches.push(record);
        this.byOfficialReference.set(referenceKey, matches);
      }

      for (const alias of record.aliases || []) {
        const matches = this.byAlias.get(alias) || [];
        matches.push(record);
        this.byAlias.set(alias, matches);
      }
    }

    const revised = this.rankingProfile !== "baseline";
    this.miniSearch = buildMiniSearch(records, {
      includeExcerpt: includeExcerpt && !revised,
      includeEurovoc: false,
    });
    this.eurovocSearch = revised ? buildEurovocSearch(records) : null;
    this.excerptMiniSearch = revised && includeExcerpt ? buildExcerptMiniSearch(records) : null;
    this.loadedAt = new Date().toISOString();
    this.loadError = null;
  }

  loadFromSqlite() {
    try {
      const database = new Database(this.sqlitePath, { readonly: true, fileMustExist: true });
      const schemaVersion = database.prepare("PRAGMA user_version").get().user_version;
      if (schemaVersion !== SQLITE_SCHEMA_VERSION) {
        database.close();
        return this.failLoad(
          `Unsupported SQLite data schema ${schemaVersion}; expected ${SQLITE_SCHEMA_VERSION}`
        );
      }

      const records = [];
      const seen = new Set();
      for (const row of database.prepare("SELECT record_json FROM laws ORDER BY ordinal").iterate()) {
        const record = compactSqliteRecord(JSON.parse(row.record_json));
        if (!record) continue;
        records.push(record);
        const key = normalizeCelexLookupKey(record.celex);
        if (key) seen.add(key);
      }
      for (const supplemental of SUPPLEMENTAL_RECORDS) {
        const key = normalizeCelexLookupKey(supplemental.celex);
        if (!key || seen.has(key)) continue;
        // Same guard as the row loop above: compactSqliteRecord returns null
        // for a record it can't compact, and a null in `records` crashes every
        // consumer that reads `.celex` off it.
        const record = compactSqliteRecord(supplemental);
        if (!record) continue;
        records.push(record);
        seen.add(key);
      }

      this.database = database;
      this.citationCounts = this.rankingProfile === "baseline" ? new Map() : new Map(database.prepare(`
          SELECT target_celex AS celex, COUNT(DISTINCT source_celex) AS count
          FROM citations
          WHERE kind = 'legislation'
          GROUP BY target_celex
        `).all().map((row) => [normalizeCelexLookupKey(row.celex), row.count]));
      this.excerptSearchStatement = database.prepare(`
        SELECT mapping.celex
        FROM law_excerpts
        JOIN law_excerpt_map AS mapping ON mapping.rowid = law_excerpts.rowid
        WHERE law_excerpts MATCH ?
        ORDER BY bm25(law_excerpts), mapping.ordinal
        LIMIT 200
      `);
      this.definitionSearchStatement = database.prepare(`
        SELECT normalized_term, display_term, sample_definition, law_count,
               substantive_law_count, import_count, wording_count
        FROM definition_terms
        WHERE definition_terms MATCH ?
        ORDER BY (normalized_term = ?) DESC, bm25(definition_terms), normalized_term
        LIMIT ?
      `);
      this.definitionOccurrenceStatement = database.prepare(`
        SELECT occurrence_id, normalized_term, term, definition, definition_hash, celex,
               source_article, source_point, classification, classification_reason
        FROM definition_occurrences
        WHERE normalized_term = ?
        ORDER BY celex, source_article, id
      `);
      this.definitionRepresentativeStatement = database.prepare(`
        SELECT occurrence_id, normalized_term, term, definition, definition_hash, celex,
               source_article, source_point, classification, classification_reason
        FROM definition_occurrences
        WHERE normalized_term = ?
        ORDER BY CASE WHEN classification IN ('substantive', 'hybrid') THEN 0 ELSE 1 END,
                 celex, source_article, id
        LIMIT 1
      `);
      this.definitionUsageStatement = database.prepare(`
        SELECT edge_type, source_occurrence_id, target_celex, target_article, target_paragraph,
               target_point, target_occurrence_id, raw, resolution
        FROM definition_usage_edges
        WHERE source_occurrence_id = ?
        ORDER BY id
      `);
      this.definitionsAvailable = database.prepare(
        "SELECT value FROM metadata WHERE key = 'definitions_available'"
      ).get()?.value === "1";
      this.payload = null;
      this.indexRecords(records, { includeExcerpt: false });
      // indexRecords resets only law indexes; preserve the SQLite availability
      // discovered above after it has initialized common store state.
      this.definitionsAvailable = database.prepare(
        "SELECT value FROM metadata WHERE key = 'definitions_available'"
      ).get()?.value === "1";
      this.datasetGeneratedAt = database.prepare(
        "SELECT value FROM metadata WHERE key = 'generated_at'"
      ).get()?.value || null;
      this.source = "sqlite";
      return true;
    } catch (error) {
      this.close();
      return this.failLoad(error.message);
    }
  }

  loadFromJson() {
    try {
      this.definitionTerms = [];
      this.definitionOccurrences = [];
      this.definitionsAvailable = false;
      // The full-corpus cache is far too large to commit, so a fresh deploy
      // fetches search-cache.json.gz as a GitHub Release asset at build time
      // (see backend/Dockerfile). Prefer the raw file when present (a local
      // rebuild writes it), else fall back to the gzipped artifact.
      const gzPath = `${this.cachePath}.gz`;
      const useGz = !fs.existsSync(this.cachePath) && fs.existsSync(gzPath);
      if (!useGz && !fs.existsSync(this.cachePath)) {
        return this.failLoad(`Search cache not found at ${this.cachePath} (or ${gzPath})`);
      }

      const raw = useGz
        ? zlib.gunzipSync(fs.readFileSync(gzPath)).toString("utf8")
        : fs.readFileSync(this.cachePath, "utf8");
      const parsed = JSON.parse(raw);
      const records = Array.isArray(parsed.records)
        ? mergeSupplementalRecords(parsed.records)
          .map((record) => enrichSearchRecord(record))
          .filter((record) => record.isPrimaryAct)
        : [];

      this.payload = parsed;
      this.datasetGeneratedAt = parsed.generatedAt || null;
      this.indexRecords(records, { includeExcerpt: true });
      try {
        const definitions = readOptionalJson(this.definitionsPath);
        if (definitions) {
          this.definitionOccurrences = Array.isArray(definitions.occurrences)
            ? definitions.occurrences : (Array.isArray(definitions.definitions) ? definitions.definitions : []);
          this.definitionTerms = Array.isArray(definitions.terms)
            ? definitions.terms : (Array.isArray(definitions.groups) ? definitions.groups : []);
          if (this.definitionOccurrences.length > 0) {
            this.definitionTerms = this.buildDefinitionTerms(this.definitionOccurrences);
          }
          this.definitionsAvailable = true;
        }
      } catch (error) {
        // A bad optional definitions artifact must not take down ordinary law
        // search. Definition endpoints remain explicitly unavailable instead.
        this.definitionsAvailable = false;
      }
      this.source = "json";
      return true;
    } catch (error) {
      return this.failLoad(error.message);
    }
  }

  loadFromDisk() {
    return this.load();
  }

  isReady() {
    return this.records.length > 0;
  }

  getStatus() {
    return {
      ready: this.isReady(),
      cachePath: this.cachePath,
      loadedAt: this.loadedAt,
      generatedAt: this.datasetGeneratedAt,
      count: this.records.length,
      error: this.loadError,
      fulltext: this.getFulltextStatus(),
    };
  }

  getDefinitionsStatus() {
    return {
      ready: this.definitionsAvailable,
      source: this.source,
      path: this.source === "sqlite" ? this.sqlitePath : this.definitionsPath,
      terms: this.database
        ? (this.definitionsAvailable ? this.database.prepare("SELECT COUNT(*) AS count FROM definition_terms").get().count : 0)
        : this.definitionTerms.length,
    };
  }

  requireDefinitions() {
    if (this.definitionsAvailable) return;
    const error = new Error("Definition index is not loaded");
    error.code = "definition_index_unavailable";
    throw error;
  }

  buildDefinitionTerms(occurrences) {
    const groups = new Map();
    for (const item of occurrences) {
      const normalizedTerm = normalizeDefinitionTerm(item?.normalizedTerm || item?.term);
      if (!normalizedTerm) continue;
      const members = groups.get(normalizedTerm) || [];
      members.push(item);
      groups.set(normalizedTerm, members);
    }
    return [...groups].map(([normalizedTerm, members]) => {
      const substantive = members.filter((item) => {
        const classification = item.classification || "substantive";
        return classification === "substantive" || classification === "hybrid";
      });
      return {
        normalizedTerm,
        displayTerm: members[0]?.term || normalizedTerm,
        sampleDefinition: substantive[0]?.definition || substantive[0]?.text || members[0]?.definition || members[0]?.text || "",
        lawCount: new Set(members.map((item) => normalizeCelexLookupKey(item.celex)).filter(Boolean)).size,
        substantiveLawCount: new Set(substantive.map((item) => normalizeCelexLookupKey(item.celex)).filter(Boolean)).size,
        importCount: members.filter((item) => item.classification === "imported").length,
        wordingCount: new Set(substantive.map((item) => item.definitionHash || item.wordingHash || item.definition)).size,
      };
    });
  }

  definitionOccurrenceRows(normalizedTerm, { representativeOnly = false, includeUsageEdges = true } = {}) {
    let rows;
    if (this.database) {
      const representative = representativeOnly
        ? this.definitionRepresentativeStatement.get(normalizedTerm)
        : null;
      rows = representativeOnly
        ? (representative ? [representative] : [])
        : this.definitionOccurrenceStatement.all(normalizedTerm);
    } else {
      const matching = this.definitionOccurrences.filter((item) => (
        normalizeDefinitionTerm(item?.normalizedTerm || item?.term) === normalizedTerm
      ));
      const selected = representativeOnly
        ? [matching.find((item) => ["substantive", "hybrid"].includes(item.classification || "substantive")) || matching[0]].filter(Boolean)
        : matching;
      rows = selected.map((item) => ({
        normalized_term: normalizedTerm,
        term: item.term,
        definition: item.definition || item.text,
        definition_hash: item.definitionHash || item.wordingHash || null,
        occurrence_id: item.occurrenceId || null,
        celex: normalizeCelexLookupKey(item.celex),
        source_article: item.sourceArticle ?? item.article ?? null,
        source_point: item.sourcePoint ?? item.point ?? null,
        classification: item.classification || "substantive",
        classification_reason: item.classificationReason || null,
      }));
    }
    return rows.map((row) => {
      const law = this.getByCelex(row.celex);
      const referenceEdges = includeUsageEdges
        ? (this.database
          ? (row.occurrence_id ? this.definitionUsageStatement.all(row.occurrence_id) : [])
          : (this.definitionOccurrences.find((item) => item.occurrenceId === row.occurrence_id)?.referenceEdges || []))
        : [];
      return {
        occurrenceId: row.occurrence_id,
        term: row.term,
        definition: row.definition,
        definitionHash: row.definition_hash,
        celex: row.celex,
        sourceArticle: row.source_article,
        sourcePoint: row.source_point,
        classification: row.classification || "substantive",
        classificationReason: row.classification_reason,
        referenceEdges: referenceEdges.map((edge) => ({
          edgeType: edge.edge_type || edge.edgeType,
          sourceOccurrenceId: edge.source_occurrence_id || edge.sourceOccurrenceId,
          targetCelex: edge.target_celex || edge.targetCelex || null,
          targetArticle: edge.target_article || edge.targetArticle || null,
          targetParagraph: edge.target_paragraph || edge.targetParagraph || null,
          targetPoint: edge.target_point || edge.targetPoint || null,
          targetOccurrenceId: edge.target_occurrence_id || edge.targetOccurrenceId || null,
          raw: edge.raw || null,
          resolution: edge.resolution || "unresolved",
        })),
        title: law?.title || null,
        date: law?.date || null,
        type: law?.type || null,
        eli: law?.eli || null,
        inForce: law?.inForce ?? null,
        law: law ? {
          title: law.title,
          date: law.date || null,
          type: law.type || null,
          eli: law.eli || null,
          inForce: law.inForce ?? null,
        } : null,
      };
    });
  }

  searchDefinitions(query, options = {}) {
    this.requireDefinitions();
    const normalized = normalizeDefinitionTerm(query);
    const filter = ["different", "reused"].includes(options.filter) ? options.filter : null;
    if (!normalized && !filter) return [];
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit || "10", 10) || 10, 50));
    let rows;
    if (this.database) {
      if (!normalized) {
        const predicate = filter === "different" ? "wording_count > 1" : "import_count > 0";
        const order = filter === "different"
          ? "wording_count DESC, substantive_law_count DESC, normalized_term"
          : "import_count DESC, law_count DESC, normalized_term";
        rows = this.database.prepare(`
          SELECT normalized_term, display_term, sample_definition, law_count,
                 substantive_law_count, import_count, wording_count
          FROM definition_terms
          WHERE ${predicate}
          ORDER BY ${order}
          LIMIT ?
        `).all(limit);
      } else {
        const tokens = normalized.match(/[\p{L}\p{N}]+/gu) || [];
        if (tokens.length === 0) return [];
        const expression = tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(" AND ");
        if (filter) {
          const predicate = filter === "different" ? "wording_count > 1" : "import_count > 0";
          rows = this.database.prepare(`
            SELECT normalized_term, display_term, sample_definition, law_count,
                   substantive_law_count, import_count, wording_count
            FROM definition_terms
            WHERE definition_terms MATCH ? AND ${predicate}
            ORDER BY (normalized_term = ?) DESC, bm25(definition_terms), normalized_term
            LIMIT ?
          `).all(expression, normalized, limit);
        } else {
          rows = this.definitionSearchStatement.all(expression, normalized, limit);
        }
      }
    } else {
      rows = this.definitionTerms
        .map((item) => ({
          normalized_term: normalizeDefinitionTerm(item.normalizedTerm || item.term || item.displayTerm),
          display_term: item.displayTerm || item.term,
          sample_definition: item.sampleDefinition || item.definition || "",
          law_count: item.lawCount,
          substantive_law_count: item.substantiveLawCount ?? item.lawCount,
          import_count: item.importCount ?? 0,
          wording_count: item.wordingCount,
        }))
        .filter((row) => {
          const matchesQuery = !normalized
            || row.normalized_term.includes(normalized)
            || normalizeDefinitionTerm(row.sample_definition).includes(normalized);
          const matchesFilter = !filter
            || (filter === "different" ? Number(row.wording_count) > 1 : Number(row.import_count) > 0);
          return matchesQuery && matchesFilter;
        })
        .sort((a, b) => normalized
          ? (Number(b.normalized_term === normalized) - Number(a.normalized_term === normalized)
            || a.normalized_term.localeCompare(b.normalized_term))
          : filter === "different"
            ? (Number(b.wording_count) - Number(a.wording_count)
              || Number(b.substantive_law_count) - Number(a.substantive_law_count)
              || a.normalized_term.localeCompare(b.normalized_term))
            : (Number(b.import_count) - Number(a.import_count)
              || Number(b.law_count) - Number(a.law_count)
              || a.normalized_term.localeCompare(b.normalized_term)))
        .slice(0, limit);
    }
    return rows.map((row) => {
      const representativeSource = this.definitionOccurrenceRows(row.normalized_term, {
        representativeOnly: true,
        includeUsageEdges: false,
      })[0] || null;
      return {
      term: row.display_term,
      normalizedTerm: row.normalized_term,
      sampleDefinition: row.sample_definition,
      lawCount: Number(row.law_count) || 0,
      substantiveLawCount: Number(row.substantive_law_count) || 0,
      importCount: Number(row.import_count) || 0,
      wordingCount: Number(row.wording_count) || 0,
      representativeSource,
      };
    });
  }

  compareDefinitions(term) {
    this.requireDefinitions();
    const normalizedTerm = normalizeDefinitionTerm(term);
    const occurrences = this.definitionOccurrenceRows(normalizedTerm);
    const competing = occurrences.filter((occurrence) => occurrence.classification === "substantive" || occurrence.classification === "hybrid");
    const grouped = new Map();
    for (const occurrence of competing) {
      const hash = occurrence.definitionHash || occurrence.definition;
      const group = grouped.get(hash) || { definitionHash: occurrence.definitionHash, definition: occurrence.definition, occurrences: [] };
      group.occurrences.push(occurrence);
      grouped.set(hash, group);
    }
    return {
      term: occurrences[0]?.term || String(term || "").trim(),
      normalizedTerm,
      lawCount: new Set(occurrences.map((item) => item.celex)).size,
      substantiveLawCount: new Set(competing.map((item) => item.celex)).size,
      importCount: occurrences.filter((item) => item.classification === "imported").length,
      wordingCount: grouped.size,
      occurrences,
      wordings: [...grouped.values()],
      usageEdges: occurrences.flatMap((item) => item.referenceEdges || []),
    };
  }

  getRankingSignalStats() {
    const celexes = new Set(this.records.map((record) => normalizeCelexLookupKey(record.celex)).filter(Boolean));
    let citedCelexes = this.citationCounts;
    let excerptRecords = this.records.filter((record) => String(record.excerpt || "").trim()).length;
    if (this.database) {
      citedCelexes = new Map(this.database.prepare(`
        SELECT DISTINCT target_celex AS celex
        FROM citations
        WHERE kind = 'legislation'
      `).all().map((row) => [normalizeCelexLookupKey(row.celex), true]));
      excerptRecords = this.database.prepare(
        "SELECT COUNT(DISTINCT celex) AS count FROM law_excerpt_map"
      ).get().count;
    }
    const countMatching = (predicate) => this.records.filter(predicate).length;
    return {
      records: this.records.length,
      eurovocRecords: countMatching((record) => (record.eurovoc || []).length > 0),
      knownStatusRecords: countMatching((record) => typeof record.inForce === "boolean"),
      inForceRecords: countMatching((record) => record.inForce === true),
      noLongerInForceRecords: countMatching((record) => record.inForce === false),
      excerptRecords,
      citedRecords: [...celexes].filter((celex) => citedCelexes.has(celex)).length,
      fulltextRecords: this.fulltextAvailable ? this.fulltextStats.actCount : 0,
    };
  }

  get activePath() {
    return this.source === "sqlite" ? this.sqlitePath : this.cachePath;
  }

  searchLaws(query, options = {}) {
    if (!this.isReady()) {
      const error = new Error(this.loadError || "Law search cache is not loaded");
      error.code = "search_cache_unavailable";
      throw error;
    }

    const limit = Math.max(1, Math.min(Number.parseInt(options.limit || "10", 10) || 10, 50));
    const disableRewrites = Boolean(options.disableRewrites);
    const parsed = parseStructuredQuery(query, { disableRewrites });

    const seen = new Set();
    const matched = [];
    const addMatch = (record) => {
      if (!record) return;
      const key = normalizeCelexLookupKey(record.celex);
      if (!key || seen.has(key)) return;
      seen.add(key);
      matched.push(record);
    };

    if (parsed.celex) {
      addMatch(getDeterministicMatch(this.byCelex, parsed.celex));
    }

    if (parsed.type && parsed.year && parsed.number) {
      const referenceKey = `${parsed.type}|${parsed.year}|${parsed.number}`;
      addMatch(getDeterministicMatch(this.byOfficialReference, referenceKey));
    }

    for (const key of [parsed.normalized, parsed.compact]) {
      if (!key) continue;
      for (const record of this.byAlias.get(key) || []) {
        addMatch(record);
      }
    }

    // Preserve exact known-law intent when the alias is embedded in a longer
    // natural query (for example "digital services act obligations"). Only
    // multi-word contiguous aliases qualify, avoiding the huge candidate sets
    // produced by broad title OR searches.
    if (!requestsHistoricalLaw(parsed)) {
      for (const key of containedAliasKeys(parsed.normalized)) {
        for (const record of this.byAlias.get(key) || []) addMatch(record);
      }
    }

    if (this.rankingProfile === "baseline" && this.miniSearch) {
      const boostDocument = buildDocumentBoost(parsed, this.citationCounts, {
        useGlobalPriors: false,
      });
      let hits = this.miniSearch.search(parsed.rewrittenQuery, { combineWith: "AND", boostDocument });
      // A broad OR over three or more terms can materialize tens of thousands
      // of title hits (and keep V8's high-water heap resident) before the FTS
      // recall stage gets a chance to answer the conceptual query. SQLite has
      // the bounded FTS fallback for that case; retain the legacy OR behavior
      // for JSON and short queries.
      if (hits.length === 0) {
        if (!this.database || parsed.terms.length < 3) {
          hits = this.miniSearch.search(parsed.rewrittenQuery, { combineWith: "OR", boostDocument });
        }
      }
      for (const hit of hits) {
        addMatch(getDeterministicMatch(this.byCelex, normalizeCelexLookupKey(hit.id)));
      }
    }

    if (this.rankingProfile === "baseline" && this.database) {
      const terms = parsed.terms || [];
      let hits = this.searchExcerpts(buildFtsExpression(terms, "AND"));
      if (hits.length === 0) {
        hits = this.searchExcerpts(buildFtsExpression(terms, "OR"));
      }
      for (const hit of hits) {
        addMatch(getDeterministicMatch(this.byCelex, normalizeCelexLookupKey(hit.celex)));
      }
    }

    if (this.rankingProfile !== "baseline") {
      const deterministic = matched.map((record) => record.celex);
      const retrievalQuery = parsed.terms.join(" ") || parsed.rewrittenQuery;
      const { candidateLimit, coverageExponent, rrfK, sourceWeights } = this.rankingConfig;
      const candidates = new Map();
      const sourceIds = { title: [], eurovoc: [], excerpt: [], fulltext: [] };
      let candidateOrdinal = 0;
      const expandWithOr = (index, hits) => {
        if (parsed.terms.length < 2 || hits.length >= candidateLimit) return hits;
        const seenIds = new Set(hits.map((hit) => normalizeCelexLookupKey(hit.id)));
        const expanded = [...hits];
        for (const hit of index.search(retrievalQuery, { combineWith: "OR" })) {
          const celex = normalizeCelexLookupKey(hit.id);
          if (!celex || seenIds.has(celex)) continue;
          seenIds.add(celex);
          expanded.push(hit);
          if (expanded.length >= candidateLimit) break;
        }
        return expanded;
      };
      const addCandidates = (source, hits, idForHit, coverageForHit = () => 1) => {
        // A source disabled via a zero (or absent) weight must contribute no
        // candidates at all — not merely a zero fusion-score term. Otherwise a
        // candidate matched ONLY by a weight-0 source still occupies a result slot
        // on sparse-result queries, breaking the eval ablation contract (a
        // `no-<source>-source` / `--fulltext-weight 0` run must equal that source
        // fully disabled).
        if (!(sourceWeights[source] > 0)) return;
        const limited = hits.slice(0, candidateLimit);
        let effectiveRank = 0;
        let previousScore = null;
        limited.forEach((hit, index) => {
          // MiniSearch returns a numeric relevance score. Equal-scoring hits
          // should share a rank: otherwise an arbitrary index-order difference
          // can be larger than the deliberately small status/citation prior.
          // SQLite FTS rows carry no score, so they retain ordinal ranks.
          const hitScore = Number.isFinite(hit.score) ? hit.score : null;
          if (hitScore == null || previousScore == null || Math.abs(hitScore - previousScore) > 1e-12) {
            effectiveRank = index + 1;
          }
          previousScore = hitScore;
          const celex = normalizeCelexLookupKey(idForHit(hit));
          const record = getDeterministicMatch(this.byCelex, celex);
          if (!record) return;
          sourceIds[source].push(celex);
          let candidate = candidates.get(celex);
          if (!candidate) {
            candidate = { record, ordinal: candidateOrdinal++, fusionScore: 0, sources: {} };
            candidates.set(celex, candidate);
          }
          const coverage = Math.max(0, Math.min(1, coverageForHit(hit)));
          candidate.sources[source] = { rank: effectiveRank, coverage };
          candidate.fusionScore += sourceWeights[source] * (coverage ** coverageExponent) / (rrfK + effectiveRank);
        });
      };

      if (this.miniSearch && retrievalQuery) {
        let hits = this.miniSearch.search(retrievalQuery, { combineWith: "AND" });
        hits = expandWithOr(this.miniSearch, hits);
        addCandidates("title", hits, (hit) => hit.id, (hit) => {
          const matched = new Set(hit.queryTerms || []).size;
          return parsed.terms.length === 0 ? 1 : matched / parsed.terms.length;
        });
      }

      if (this.eurovocSearch && retrievalQuery) {
        let hits = this.eurovocSearch.search(retrievalQuery, { combineWith: "AND" });
        hits = expandWithOr(this.eurovocSearch, hits);
        addCandidates("eurovoc", hits, (hit) => hit.id, (hit) => {
          const matched = new Set(hit.queryTerms || []).size;
          return parsed.terms.length === 0 ? 1 : matched / parsed.terms.length;
        });
      }

      if (this.database) {
        const terms = parsed.terms || [];
        let hits = this.searchExcerpts(buildFtsExpression(terms, "AND"));
        if (hits.length === 0) hits = this.searchExcerpts(buildFtsExpression(terms, "OR"));
        addCandidates("excerpt", hits, (hit) => hit.celex);
      } else if (this.excerptMiniSearch && retrievalQuery) {
        let hits = this.excerptMiniSearch.search(retrievalQuery, { combineWith: "AND" });
        if (hits.length === 0 && parsed.terms.length < 3) {
          hits = this.excerptMiniSearch.search(retrievalQuery, { combineWith: "OR" });
        }
        addCandidates("excerpt", hits, (hit) => hit.id);
      }

      // No JSON/MiniSearch fallback here, unlike excerpt: fulltext is
      // SQLite-only, and simply skipped when the artifact isn't loaded.
      if (this.fulltextAvailable && sourceWeights.fulltext > 0) {
        const terms = parsed.terms || [];
        let hits = this.searchFulltext(buildFtsExpression(terms, "AND"));
        if (hits.length === 0) hits = this.searchFulltext(buildFtsExpression(terms, "OR"));
        addCandidates("fulltext", hits, (hit) => hit.celex);
      }

      const ranked = [...candidates.values()]
        .map((candidate) => ({
          ...candidate,
          finalScore: candidate.fusionScore * documentPrior(
            parsed,
            candidate.record,
            this.citationCounts,
            this.rankingConfig
          ),
        }))
        .sort((left, right) => right.finalScore - left.finalScore || left.ordinal - right.ordinal);
      for (const candidate of ranked) addMatch(candidate.record);

      if (typeof options.onDiagnostics === "function") {
        options.onDiagnostics({
          retrievalQuery,
          deterministic,
          sources: sourceIds,
          union: [...candidates.keys()],
          ranked: ranked.map((candidate) => ({
            celex: candidate.record.celex,
            ordinal: candidate.ordinal,
            fusionScore: candidate.fusionScore,
            finalScore: candidate.finalScore,
            sources: candidate.sources,
          })),
        });
      }
    }

    // Like compactSqliteRecord, an explicit whitelist: a field not named here
    // never reaches the client, however far it got through the store.
    return matched
      .slice(0, limit)
      .map((law) => ({
        celex: law.celex,
        title: law.title,
        type: law.type,
        date: law.date || null,
        eli: law.eli || null,
        fmxAvailable: Boolean(law.fmxAvailable),
        matchReason: determineMatchReason(law, parsed),
        topics: (law.eurovoc || []).slice(0, 5),
        // Tri-state; `?? null` keeps a real `false` from collapsing to null.
        // null means "unknown", and the client draws no badge for it.
        inForce: law.inForce ?? null,
        endOfValidity: law.endOfValidity || null,
        // Lets the client tell "not yet in force" from "no longer in force";
        // both read `inForce: false`. Absent on records predating the field,
        // and the client falls back to the weaker label when it is missing.
        entryIntoForce: law.entryIntoForce || null,
      }));
  }

  getByCelex(celex) {
    return getDeterministicMatch(this.byCelex, normalizeCelexLookupKey(celex));
  }

  getByEli(eli) {
    return getDeterministicMatch(this.byEli, normalizeEliLookupKey(eli));
  }

  getByOfficialReference(reference) {
    return getDeterministicMatch(this.byOfficialReference, normalizeOfficialReferenceLookupKey(reference));
  }

  // Reference resolution reduced to plain, cloneable data. Consumers that only
  // resolve citations (the citation graph builder's workers) can rebuild these
  // lookups in milliseconds instead of re-reading the cache and re-indexing
  // MiniSearch, which dominates load() and which they never query. Ambiguous keys
  // are dropped here so the index resolves exactly as getDeterministicMatch does.
  exportReferenceIndex() {
    const officialRef = {};
    for (const [key, matches] of this.byOfficialReference) {
      if (matches.length === 1 && matches[0]?.celex) {
        officialRef[key] = String(matches[0].celex).toUpperCase();
      }
    }
    const celexTitle = {};
    for (const [key, matches] of this.byCelex) {
      if (matches.length === 1) celexTitle[key] = matches[0]?.title ?? null;
    }
    return { officialRef, celexTitle };
  }

  searchExcerpts(expression) {
    if (!this.excerptSearchStatement || !expression) return [];
    return this.excerptSearchStatement.all(expression);
  }

  getCaseLawDetails(celexes) {
    if (!this.database) return null;
    const ids = [...new Set((celexes || []).map(normalizeCelexLookupKey).filter(Boolean))];
    if (ids.length === 0) return new Map();
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.database.prepare(
      `SELECT celex, details_json FROM case_law WHERE celex IN (${placeholders})`
    ).all(...ids);
    return new Map(rows.map((row) => [row.celex, JSON.parse(row.details_json)]));
  }

  getCaseLawCacheStats() {
    if (!this.database) return null;
    const stats = this.database.prepare(`
      SELECT COUNT(*) AS total, COALESCE(SUM(is_partial), 0) AS partial
      FROM case_law
    `).get();
    return { total: stats.total, partial: stats.partial, failedRecently: 0 };
  }

  close() {
    if (this.database) {
      try {
        this.database.close();
      } catch {
        // Already closed or failed during initialization.
      }
      this.database = null;
      this.excerptSearchStatement = null;
      this.definitionSearchStatement = null;
      this.definitionOccurrenceStatement = null;
      this.definitionRepresentativeStatement = null;
      this.definitionUsageStatement = null;
    }
    if (this.fulltextDatabase) {
      try {
        this.fulltextDatabase.close();
      } catch {
        // Already closed or failed during initialization.
      }
      this.fulltextDatabase = null;
      this.fulltextSearchStatement = null;
      this.fulltextUnitSearchStatement = null;
      this.fulltextUnitScopedSearchStatement = null;
      this.fulltextUnitSnippetStatement = null;
      this.fulltextAvailable = false;
      this.fulltextReason = "Full-text index is closed";
    }
  }
}

module.exports = {
  buildCanonicalEliFromReference,
  DEFAULT_SEARCH_CACHE_PATH,
  DEFAULT_SQLITE_DATA_PATH,
  DEFAULT_DEFINITIONS_PATH,
  DEFAULT_FULLTEXT_SQLITE_PATH,
  FULLTEXT_SCHEMA_VERSION,
  buildFulltextMatchExpression,
  JsonLegalCacheStore,
  SQLITE_SCHEMA_VERSION,
  isNotYetInForce,
  containedAliasKeys,
  documentPrior,
  normalizeCelexLookupKey,
  normalizeDefinitionTerm,
  normalizeEliLookupKey,
  normalizeOfficialReferenceLookupKey,
  validateFulltextQuery,
};
