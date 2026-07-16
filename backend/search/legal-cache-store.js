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
const SQLITE_SCHEMA_VERSION = 4;

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

function buildMiniSearch(records, { includeExcerpt = true } = {}) {
  const fields = includeExcerpt ? ["title", "aliases", "excerpt"] : ["title", "aliases"];
  const boost = includeExcerpt
    ? { aliases: 3, title: 1, excerpt: EXCERPT_BOOST }
    : { aliases: 3, title: 1 };
  const miniSearch = new MiniSearch({
    idField: "celex",
    fields,
    storeFields: ["type"],
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
    excerpt: record.excerpt || "",
    type: record.type,
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
    this.payload = null;
    this.records = [];
    this.loadedAt = null;
    this.loadError = null;
    this.byCelex = new Map();
    this.byEli = new Map();
    this.byOfficialReference = new Map();
    this.byAlias = new Map();
    this.miniSearch = null;
    this.database = null;
    this.excerptSearchStatement = null;
    this.definitionSearchStatement = null;
    this.definitionOccurrenceStatement = null;
    this.definitionUsageStatement = null;
    this.definitionTerms = [];
    this.definitionOccurrences = [];
    this.definitionsAvailable = false;
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
    this.definitionTerms = [];
    this.definitionOccurrences = [];
    this.definitionsAvailable = false;
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

    this.miniSearch = buildMiniSearch(records, { includeExcerpt });
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
      count: this.records.length,
      error: this.loadError,
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

  definitionOccurrenceRows(normalizedTerm) {
    const rows = this.database
      ? this.definitionOccurrenceStatement.all(normalizedTerm)
      : this.definitionOccurrences.filter((item) => (
        normalizeDefinitionTerm(item?.normalizedTerm || item?.term) === normalizedTerm
      )).map((item) => ({
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
    return rows.map((row) => {
      const law = this.getByCelex(row.celex);
      const referenceEdges = this.database
        ? (row.occurrence_id ? this.definitionUsageStatement.all(row.occurrence_id) : [])
        : (this.definitionOccurrences.find((item) => item.occurrenceId === row.occurrence_id)?.referenceEdges || []);
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
        rows = this.definitionSearchStatement.all(expression, normalized, limit);
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
        .filter((row) => normalized
          ? (row.normalized_term.includes(normalized)
            || normalizeDefinitionTerm(row.sample_definition).includes(normalized))
          : (filter === "different" ? Number(row.wording_count) > 1 : Number(row.import_count) > 0))
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
      const occurrenceRows = this.definitionOccurrenceRows(row.normalized_term);
      const representativeSource = occurrenceRows.find((item) => (
        item.classification === "substantive" || item.classification === "hybrid"
      )) || occurrenceRows[0] || null;
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
    for (const key of containedAliasKeys(parsed.normalized)) {
      for (const record of this.byAlias.get(key) || []) addMatch(record);
    }

    if (this.miniSearch) {
      const boostDocument = buildDocumentBoost(parsed);
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

    if (this.database) {
      const terms = parsed.terms || [];
      let hits = this.searchExcerpts(buildFtsExpression(terms, "AND"));
      if (hits.length === 0) {
        hits = this.searchExcerpts(buildFtsExpression(terms, "OR"));
      }
      for (const hit of hits) {
        addMatch(getDeterministicMatch(this.byCelex, normalizeCelexLookupKey(hit.celex)));
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
    this.definitionSearchStatement = null;
    this.definitionOccurrenceStatement = null;
    this.definitionUsageStatement = null;
  }
}

module.exports = {
  buildCanonicalEliFromReference,
  DEFAULT_SEARCH_CACHE_PATH,
  DEFAULT_SQLITE_DATA_PATH,
  DEFAULT_DEFINITIONS_PATH,
  JsonLegalCacheStore,
  SQLITE_SCHEMA_VERSION,
  containedAliasKeys,
  normalizeCelexLookupKey,
  normalizeDefinitionTerm,
  normalizeEliLookupKey,
  normalizeOfficialReferenceLookupKey,
};
