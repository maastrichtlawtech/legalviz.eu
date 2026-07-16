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
const SQLITE_SCHEMA_VERSION = 2;

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
// Title and controlled-vocabulary evidence are co-equal. Body-text matches are
// useful for recall but deliberately weaker because recitals contain many
// incidental concepts. Selected on the development split; see eval/README.md.
const SOURCE_WEIGHTS = { title: 1.1, eurovoc: 1.1, excerpt: 0.5 };
const COVERAGE_EXPONENT = 2;

function citationBoost(count) {
  const citations = Math.max(0, Number(count) || 0);
  return Math.min(MAX_CITATION_BOOST, 1 + CITATION_LOG_SCALE * Math.log1p(citations));
}

function requestsHistoricalLaw(parsed) {
  return /\b(?:former|historic|historical|old|repealed|repeal|expired|obsolete|superseded|no longer in force)\b/i
    .test(String(parsed.originalQuery || ""));
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
    storeFields: ["type", "inForce"],
    searchOptions: {
      boost,
      fuzzy: 0.2,
      prefix: true,
      combineWith: "AND",
    },
  });

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
        if (historicalIntent && stored?.inForce === false) statusBoost = IN_FORCE_BOOST;
        else if (historicalIntent && stored?.inForce === true) statusBoost = NO_LONGER_IN_FORCE_BOOST;
        else if (stored?.inForce === true) statusBoost = IN_FORCE_BOOST;
        else if (stored?.inForce === false) statusBoost = NO_LONGER_IN_FORCE_BOOST;
      }
      const authorityBoost = useCitationPrior
        ? citationBoost(citationCounts.get(normalizeCelexLookupKey(id)))
        : 1;
      boost *= Math.min(MAX_GLOBAL_PRIOR, statusBoost * authorityBoost);
    }
    return boost;
  };
}

function documentPrior(parsed, law, citationCounts, options) {
  const boost = buildDocumentBoost(parsed, citationCounts, options);
  return boost(law.celex, "", { type: law.type, inForce: law.inForce });
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
    this.rankingProfile = options.rankingProfile === "baseline" ? "baseline" : "revised";
    this.rankingConfig = {
      rrfK: options.rankingConfig?.rrfK ?? RRF_K,
      candidateLimit: options.rankingConfig?.candidateLimit ?? CANDIDATE_LIMIT,
      coverageExponent: options.rankingConfig?.coverageExponent ?? COVERAGE_EXPONENT,
      sourceWeights: { ...SOURCE_WEIGHTS, ...(options.rankingConfig?.sourceWeights || {}) },
      useStatusPrior: options.rankingConfig?.useStatusPrior ?? true,
      useCitationPrior: options.rankingConfig?.useCitationPrior ?? true,
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
    this.citationCounts = new Map(options.citationCounts || []);
    this.source = null;
  }

  load() {
    this.close();
    if (this.sqlitePath && fs.existsSync(this.sqlitePath)) {
      return this.loadFromSqlite();
    }
    if (this.requireSqlite) {
      return this.failLoad(`SQLite data store not found at ${this.sqlitePath}`);
    }
    return this.loadFromJson();
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
    this.eurovocSearch = null;
    this.excerptMiniSearch = null;
    this.source = null;
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
        if (key && !seen.has(key)) records.push(compactSqliteRecord(supplemental));
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
      this.payload = null;
      this.indexRecords(records, { includeExcerpt: false });
      this.source = "sqlite";
      return true;
    } catch (error) {
      this.close();
      return this.failLoad(error.message);
    }
  }

  loadFromJson() {
    try {
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
      this.indexRecords(records, { includeExcerpt: true });
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
      count: this.records.length,
      error: this.loadError,
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
      const retrievalQuery = parsed.terms.join(" ") || parsed.rewrittenQuery;
      const { candidateLimit, coverageExponent, rrfK, sourceWeights } = this.rankingConfig;
      const candidates = new Map();
      const sourceIds = { title: [], eurovoc: [], excerpt: [] };
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

      const ranked = [...candidates.values()]
        .map((candidate) => ({
          ...candidate,
          finalScore: candidate.fusionScore * documentPrior(
            parsed,
            candidate.record,
            this.citationCounts,
            { useStatusPrior: this.rankingConfig.useStatusPrior, useCitationPrior: this.rankingConfig.useCitationPrior }
          ),
        }))
        .sort((left, right) => right.finalScore - left.finalScore || left.ordinal - right.ordinal);
      for (const candidate of ranked) addMatch(candidate.record);

      if (typeof options.onDiagnostics === "function") {
        options.onDiagnostics({
          retrievalQuery,
          sources: sourceIds,
          union: [...candidates.keys()],
          ranked: ranked.map((candidate) => ({
            celex: candidate.record.celex,
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
    if (!this.database) return;
    try {
      this.database.close();
    } catch {
      // Already closed or failed during initialization.
    }
    this.database = null;
    this.excerptSearchStatement = null;
  }
}

module.exports = {
  buildCanonicalEliFromReference,
  DEFAULT_SEARCH_CACHE_PATH,
  DEFAULT_SQLITE_DATA_PATH,
  JsonLegalCacheStore,
  SQLITE_SCHEMA_VERSION,
  containedAliasKeys,
  normalizeCelexLookupKey,
  normalizeEliLookupKey,
  normalizeOfficialReferenceLookupKey,
};
