const fs = require("fs");
const path = require("path");
const MiniSearch = require("minisearch");

const {
  determineMatchReason,
  enrichSearchRecord,
  parseStructuredQuery,
} = require("./search-ranking");

const DEFAULT_SEARCH_CACHE_PATH = process.env.SEARCH_CACHE_PATH ||
  path.join(__dirname, "data", "search-cache.json");

const DEFAULT_EUROVOC_DATA_PATH = process.env.EUROVOC_DATA_PATH ||
  path.join(__dirname, "data", "eurovoc.json");

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

function loadEurovocSidecar(eurovocPath) {
  try {
    if (!fs.existsSync(eurovocPath)) return {};
    const parsed = JSON.parse(fs.readFileSync(eurovocPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function getDeterministicMatch(index, key) {
  if (!key) return null;
  const matches = index.get(key) || [];
  return matches.length === 1 ? matches[0] : null;
}

function buildMiniSearch(records) {
  const miniSearch = new MiniSearch({
    idField: "celex",
    fields: ["title", "aliases"],
    storeFields: ["type"],
    searchOptions: {
      boost: { aliases: 3, title: 1 },
      fuzzy: 0.2,
      prefix: true,
      combineWith: "AND",
    },
  });

  miniSearch.addAll(records.map((record) => ({
    celex: record.celex,
    title: record.normalizedTitle || record.title || "",
    aliases: Array.isArray(record.aliases) ? record.aliases.join(" ") : "",
    type: record.type,
  })));

  return miniSearch;
}

// Re-encodes the act-type priors that the retired scoreLaw ranking applied,
// as multiplicative boosts on MiniSearch relevance. This only reshuffles the
// free-text stage: the deterministic celex/reference/alias matches run first
// and are unaffected. Demote decisions (they rarely answer a plain "... act"
// query) and nudge results toward the act type the query names.
function buildDocumentBoost(parsed) {
  const query = String(parsed.originalQuery || "").toLowerCase();
  const mentionsAct = /\bact\b/.test(query);
  const mentionsDirective = /\bdirective\b/.test(query);
  const mentionsRegulation = /\bregulation\b/.test(query);

  return (_id, _term, stored) => {
    const type = stored && stored.type;
    let boost = 1;
    if (type === "decision") boost *= mentionsAct ? 0.3 : 0.6;
    else if (type === "directive") boost *= mentionsDirective ? 1.5 : 1.05;
    else if (type === "regulation") boost *= mentionsRegulation ? 1.5 : 1.1;
    if (mentionsDirective && type === "regulation") boost *= 0.7;
    if (mentionsRegulation && type === "directive") boost *= 0.7;
    return boost;
  };
}

class JsonLegalCacheStore {
  constructor(cachePath = DEFAULT_SEARCH_CACHE_PATH, eurovocPath = DEFAULT_EUROVOC_DATA_PATH) {
    this.cachePath = cachePath;
    this.eurovocPath = eurovocPath;
    this.payload = null;
    this.records = [];
    this.loadedAt = null;
    this.loadError = null;
    this.byCelex = new Map();
    this.byEli = new Map();
    this.byOfficialReference = new Map();
    this.byAlias = new Map();
    this.miniSearch = null;
  }

  load() {
    try {
      if (!fs.existsSync(this.cachePath)) {
        this.payload = null;
        this.records = [];
        this.loadedAt = null;
        this.loadError = `Search cache not found at ${this.cachePath}`;
        this.byCelex = new Map();
        this.byEli = new Map();
        this.byOfficialReference = new Map();
        this.byAlias = new Map();
        this.miniSearch = null;
        return false;
      }

      const raw = fs.readFileSync(this.cachePath, "utf8");
      const parsed = JSON.parse(raw);
      const records = Array.isArray(parsed.records)
        ? mergeSupplementalRecords(parsed.records)
          .map((record) => enrichSearchRecord(record))
          .filter((record) => record.isPrimaryAct)
        : [];

      const eurovocData = loadEurovocSidecar(this.eurovocPath);

      this.payload = parsed;
      this.records = records;
      this.byCelex = new Map();
      this.byEli = new Map();
      this.byOfficialReference = new Map();
      this.byAlias = new Map();

      for (const record of records) {
        record.eurovoc = eurovocData[record.celex] || [];

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

      this.miniSearch = buildMiniSearch(records);
      this.loadedAt = new Date().toISOString();
      this.loadError = null;
      return true;
    } catch (error) {
      this.payload = null;
      this.records = [];
      this.loadedAt = null;
      this.loadError = error.message;
      this.byCelex = new Map();
      this.byEli = new Map();
      this.byOfficialReference = new Map();
      this.byAlias = new Map();
      this.miniSearch = null;
      return false;
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

    if (this.miniSearch) {
      const boostDocument = buildDocumentBoost(parsed);
      let hits = this.miniSearch.search(parsed.rewrittenQuery, { combineWith: "AND", boostDocument });
      if (hits.length === 0) {
        hits = this.miniSearch.search(parsed.rewrittenQuery, { combineWith: "OR", boostDocument });
      }
      for (const hit of hits) {
        addMatch(getDeterministicMatch(this.byCelex, normalizeCelexLookupKey(hit.id)));
      }
    }

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
}

module.exports = {
  buildCanonicalEliFromReference,
  DEFAULT_EUROVOC_DATA_PATH,
  DEFAULT_SEARCH_CACHE_PATH,
  JsonLegalCacheStore,
  normalizeCelexLookupKey,
  normalizeEliLookupKey,
  normalizeOfficialReferenceLookupKey,
};
