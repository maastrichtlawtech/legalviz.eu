"use strict";

// The record assembly and MiniSearch index construction shared by the server
// (legal-cache-store.js) and the Docker data build (build-sqlite-data.js). The
// build persists the title/alias and EuroVoc indexes into data.sqlite (see
// persisted-search-index.js), so both sides must derive byte-identical index
// documents from the same records; keeping one copy here is what guarantees it.
// The Dockerfile's data-builder stage copies this file, so keep its imports to
// search-ranking.js and installed packages.

const MiniSearch = require("minisearch");

const { enrichSearchRecord } = require("./search-ranking");

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

// The MiniSearch options of the title/alias index. The SQLite store builds the
// index with includeExcerpt and includeEurovoc off, and the persisted copy is
// read back with these same options.
function titleIndexOptions({ includeExcerpt = true, includeEurovoc = true } = {}) {
  const fields = ["title", "aliases"];
  if (includeEurovoc) fields.push("eurovoc");
  if (includeExcerpt) fields.push("excerpt");
  const boost = { aliases: 3, title: 1 };
  if (includeEurovoc) boost.eurovoc = EUROVOC_BOOST;
  if (includeExcerpt) boost.excerpt = EXCERPT_BOOST;
  return {
    idField: "celex",
    fields,
    storeFields: ["type", "inForce", "notYetInForce"],
    searchOptions: {
      boost,
      fuzzy: 0.2,
      prefix: true,
      combineWith: "AND",
    },
  };
}

// The fields the title/alias index stores per document, for boostDocument.
// Keys whose value is undefined are left out, as MiniSearch leaves them out.
function titleIndexStoredFields(record, today = todayIso()) {
  const stored = { type: record.type, inForce: record.inForce, notYetInForce: isNotYetInForce(record, today) };
  for (const key of Object.keys(stored)) if (stored[key] === undefined) delete stored[key];
  return stored;
}

const EUROVOC_INDEX_OPTIONS = {
  idField: "celex",
  fields: ["eurovoc"],
  searchOptions: {
    fuzzy: false,
    prefix: true,
    combineWith: "AND",
  },
};

function buildMiniSearch(records, options = {}) {
  const miniSearch = new MiniSearch(titleIndexOptions(options));

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
    // notYetInForce is resolved once here rather than per query hit: "in the
    // future" is relative to index-build time, which moves when the store is
    // rebuilt.
    ...titleIndexStoredFields(record, today),
  })));

  return miniSearch;
}

function buildEurovocSearch(records) {
  const miniSearch = new MiniSearch(EUROVOC_INDEX_OPTIONS);
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

// The records the SQLite store serves, in serving order: each `laws` row
// compacted (non-primary acts drop out), then any supplemental record whose
// CELEX the rows did not already provide.
function sqliteSearchRecords(rows) {
  const records = [];
  const seen = new Set();
  for (const row of rows) {
    const record = compactSqliteRecord(row);
    if (!record) continue;
    records.push(record);
    const key = normalizeCelexLookupKey(record.celex);
    if (key) seen.add(key);
  }
  for (const supplemental of SUPPLEMENTAL_RECORDS) {
    const key = normalizeCelexLookupKey(supplemental.celex);
    if (!key || seen.has(key)) continue;
    // compactSqliteRecord returns null for a record it can't compact, and a
    // null in `records` crashes every consumer that reads `.celex` off it.
    const record = compactSqliteRecord(supplemental);
    if (!record) continue;
    records.push(record);
    seen.add(key);
  }
  return records;
}

module.exports = {
  EUROVOC_BOOST,
  EUROVOC_INDEX_OPTIONS,
  EXCERPT_BOOST,
  SUPPLEMENTAL_RECORDS,
  buildEurovocSearch,
  buildExcerptMiniSearch,
  buildMiniSearch,
  compactSqliteRecord,
  dedupeByCelex,
  isNotYetInForce,
  mergeSupplementalRecords,
  normalizeCelexLookupKey,
  searchableAliases,
  sqliteSearchRecords,
  titleIndexOptions,
  titleIndexStoredFields,
  todayIso,
};
