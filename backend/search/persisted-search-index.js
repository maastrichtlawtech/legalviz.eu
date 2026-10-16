"use strict";

// MiniSearch keeps its whole inverted index on the V8 heap. For the title/alias
// and EuroVoc indexes over ~80k acts that is ~190 MB, resident for the life of
// the process, on a host billed by the gigabyte. The data build therefore
// writes MiniSearch's own serialised index (toJSON) into data.sqlite, and
// PersistedSearchIndex answers search() from it: the vocabulary and the field
// lengths stay in memory (a few MB), and a query reads only the postings of the
// terms it expands to.
//
// Results are MiniSearch's, scores included: the same term expansion (exact,
// prefix, fuzzy), weights and BM25+ parameters, and the same iteration order,
// which fixes both the floating-point summation order and the order of
// equal-scoring hits. persisted-search-index.test.js holds the two to that.
// Only `id`, `score` and `queryTerms` are returned; stored fields are supplied
// by the caller (`storedFields`) for boostDocument.

const MiniSearch = require("minisearch");

// MiniSearch's built-in search defaults. They are not exported, so they are
// restated here; the parity test fails if a MiniSearch upgrade changes them.
const DEFAULT_SEARCH_OPTIONS = {
  combineWith: "or",
  prefix: false,
  fuzzy: false,
  maxFuzzy: 6,
  boost: {},
  weights: { fuzzy: 0.45, prefix: 0.375 },
  bm25: { k: 1.2, b: 0.7, d: 0.5 },
};

const SEARCH_INDEX_SCHEMA = `
  CREATE TABLE search_indexes (
    name TEXT PRIMARY KEY,
    document_count INTEGER NOT NULL,
    field_ids TEXT NOT NULL,
    average_field_length TEXT NOT NULL,
    document_ids TEXT NOT NULL,
    field_lengths BLOB NOT NULL
  ) STRICT;
  -- ordinal is the term's position in MiniSearch's own index iteration order,
  -- which is the order its prefix and fuzzy expansions visit terms in.
  CREATE TABLE search_index_terms (
    name TEXT NOT NULL,
    term TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    postings BLOB NOT NULL,
    PRIMARY KEY (name, term)
  ) STRICT, WITHOUT ROWID;
`;

const getOwnProperty = (object, property) => (
  Object.prototype.hasOwnProperty.call(object, property) ? object[property] : undefined
);

// Postings for one term: per field, the field id, the posting count, then
// (document short id, term frequency) pairs in ascending short-id order, all
// little-endian uint32.
function encodePostings(fieldData) {
  const entries = Object.entries(fieldData);
  let words = 0;
  for (const [, freqs] of entries) words += 2 + 2 * Object.keys(freqs).length;
  const buffer = Buffer.alloc(words * 4);
  let offset = 0;
  for (const [fieldId, freqs] of entries) {
    const pairs = Object.entries(freqs);
    offset = buffer.writeUInt32LE(Number(fieldId), offset);
    offset = buffer.writeUInt32LE(pairs.length, offset);
    for (const [shortId, frequency] of pairs) {
      offset = buffer.writeUInt32LE(Number(shortId), offset);
      offset = buffer.writeUInt32LE(frequency, offset);
    }
  }
  return buffer;
}

function decodePostings(buffer) {
  const fields = new Map();
  let offset = 0;
  while (offset < buffer.length) {
    const fieldId = buffer.readUInt32LE(offset);
    const count = buffer.readUInt32LE(offset + 4);
    offset += 8;
    const pairs = new Uint32Array(count * 2);
    for (let index = 0; index < pairs.length; index += 1) {
      pairs[index] = buffer.readUInt32LE(offset);
      offset += 4;
    }
    fields.set(fieldId, pairs);
  }
  return fields;
}

// Writes a built MiniSearch index under `name`. Returns the counts written so
// the caller can record them in its manifest.
function writeSearchIndex(database, name, miniSearch) {
  const json = miniSearch.toJSON();
  if (json.dirtCount) throw new Error(`Search index ${name} has discarded documents; rebuild it before persisting`);
  const fieldCount = Object.keys(json.fieldIds).length;
  const documentIds = [];
  const fieldLengths = Buffer.alloc(json.nextId * fieldCount * 4);
  for (let shortId = 0; shortId < json.nextId; shortId += 1) {
    const id = getOwnProperty(json.documentIds, String(shortId));
    if (id === undefined) throw new Error(`Search index ${name} has no document for short id ${shortId}`);
    documentIds.push(id);
    const lengths = json.fieldLength[shortId] || [];
    for (let fieldId = 0; fieldId < fieldCount; fieldId += 1) {
      fieldLengths.writeUInt32LE(lengths[fieldId] || 0, (shortId * fieldCount + fieldId) * 4);
    }
  }
  database.prepare(`
    INSERT INTO search_indexes (name, document_count, field_ids, average_field_length, document_ids, field_lengths)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    name,
    json.documentCount,
    JSON.stringify(json.fieldIds),
    JSON.stringify(json.averageFieldLength),
    JSON.stringify(documentIds),
    fieldLengths,
  );
  const insertTerm = database.prepare(
    "INSERT INTO search_index_terms (name, term, ordinal, postings) VALUES (?, ?, ?, ?)"
  );
  json.index.forEach(([term, fieldData], ordinal) => {
    insertTerm.run(name, term, ordinal, encodePostings(fieldData));
  });
  return { documents: json.documentCount, terms: json.index.length };
}

// Levenshtein distance, or -1 once it must exceed `max`. MiniSearch's fuzzy
// matching is plain Levenshtein bounded the same way.
function boundedEditDistance(a, b, max, rowA, rowB) {
  if (Math.abs(a.length - b.length) > max) return -1;
  let previous = rowA;
  let current = rowB;
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowMinimum = i;
    const code = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j += 1) {
      const value = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (code === b.charCodeAt(j - 1) ? 0 : 1),
      );
      current[j] = value;
      if (value < rowMinimum) rowMinimum = value;
    }
    if (rowMinimum > max) return -1;
    [previous, current] = [current, previous];
  }
  return previous[b.length] <= max ? previous[b.length] : -1;
}

function assignUniqueTerms(target, source) {
  for (const term of source) {
    if (!target.includes(term)) target.push(term);
  }
}

class PersistedSearchIndex {
  // `options` are the MiniSearch options the index was built with; only
  // `fields`, `searchOptions`, `tokenize` and `processTerm` are consulted.
  // `storedFields(id)` supplies a document's stored fields to boostDocument.
  static open(database, name, options, { storedFields = () => ({}) } = {}) {
    const row = database.prepare("SELECT * FROM search_indexes WHERE name = ?").get(name);
    if (!row) return null;
    return new PersistedSearchIndex(database, row, options, storedFields);
  }

  constructor(database, row, options, storedFields) {
    this.name = row.name;
    this.documentCount = row.document_count;
    this.fieldIds = JSON.parse(row.field_ids);
    this.averageFieldLength = JSON.parse(row.average_field_length);
    this.documentIds = JSON.parse(row.document_ids);
    this.fieldCount = Object.keys(this.fieldIds).length;
    this.fieldLengths = new Uint32Array(this.documentIds.length * this.fieldCount);
    for (let index = 0; index < this.fieldLengths.length; index += 1) {
      this.fieldLengths[index] = row.field_lengths.readUInt32LE(index * 4);
    }
    this.fields = options.fields;
    this.searchOptions = { ...DEFAULT_SEARCH_OPTIONS, ...(options.searchOptions || {}) };
    this.tokenize = options.tokenize || MiniSearch.getDefault("tokenize");
    this.processTerm = options.processTerm || MiniSearch.getDefault("processTerm");
    this.storedFields = storedFields;

    const terms = database.prepare(
      "SELECT term, ordinal FROM search_index_terms WHERE name = ?"
    ).all(this.name);
    // SQLite's BINARY collation orders by UTF-8 bytes; prefix ranges are found
    // by binary search with JavaScript's UTF-16 comparison, so sort again.
    terms.sort((left, right) => (left.term < right.term ? -1 : left.term > right.term ? 1 : 0));
    this.sortedTerms = terms.map((entry) => entry.term);
    this.termOrdinals = Int32Array.from(terms, (entry) => entry.ordinal);
    this.termsByLength = new Map();
    let longest = 0;
    this.sortedTerms.forEach((term, index) => {
      if (!this.termsByLength.has(term.length)) this.termsByLength.set(term.length, []);
      this.termsByLength.get(term.length).push(index);
      longest = Math.max(longest, term.length);
    });
    this.editRows = [new Int32Array(longest + 1), new Int32Array(longest + 1)];
    this.postingsStatement = database.prepare(
      "SELECT postings FROM search_index_terms WHERE name = ? AND term = ?"
    );
  }

  lowerBound(term) {
    let low = 0;
    let high = this.sortedTerms.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.sortedTerms[middle] < term) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  // Indexes into sortedTerms in stored-ordinal order. MiniSearch's index
  // iterator, which toJSON and prefix matching use, walks each node's children
  // last to first, while its fuzzy matcher walks them first to last: prefix
  // matches therefore come in ordinal order and fuzzy matches in reverse.
  byIndexOrder(indexes, { reverse = false } = {}) {
    const direction = reverse ? -1 : 1;
    return indexes.sort((left, right) => direction * (this.termOrdinals[left] - this.termOrdinals[right]));
  }

  prefixMatches(term) {
    const matches = [];
    for (let index = this.lowerBound(term); index < this.sortedTerms.length; index += 1) {
      if (!this.sortedTerms[index].startsWith(term)) break;
      matches.push(index);
    }
    return this.byIndexOrder(matches).map((index) => this.sortedTerms[index]);
  }

  fuzzyMatches(term, maxDistance) {
    const distances = new Map();
    const [rowA, rowB] = this.editRows;
    const matches = [];
    for (let length = Math.max(0, term.length - maxDistance); length <= term.length + maxDistance; length += 1) {
      for (const index of this.termsByLength.get(length) || []) {
        const distance = boundedEditDistance(term, this.sortedTerms[index], maxDistance, rowA, rowB);
        if (distance < 0) continue;
        matches.push(index);
        distances.set(index, distance);
      }
    }
    return new Map(
      this.byIndexOrder(matches, { reverse: true }).map((index) => [this.sortedTerms[index], distances.get(index)])
    );
  }

  postings(term) {
    const row = this.postingsStatement.get(this.name, term);
    return row ? decodePostings(row.postings) : null;
  }

  search(query, searchOptions = {}) {
    const options = { ...this.searchOptions, ...searchOptions };
    const terms = this.tokenize(query)
      .flatMap((term) => this.processTerm(term))
      .filter((term) => !!term);
    const results = terms.map((term) => this.executeTerm(term, options));
    const combined = this.combine(results, options.combineWith);
    const hits = [];
    for (const [shortId, { score, terms: queryTerms }] of combined) {
      const quality = queryTerms.length || 1;
      hits.push({ id: this.documentIds[shortId], score: score * quality, queryTerms });
    }
    // Array.prototype.sort is stable, like the sort MiniSearch relies on.
    return hits.sort((left, right) => right.score - left.score);
  }

  executeTerm(term, options) {
    const fields = options.fields || this.fields;
    const boosts = fields.reduce((all, field) => ({ ...all, [field]: getOwnProperty(options.boost, field) || 1 }), {});
    const { fuzzy: fuzzyWeight, prefix: prefixWeight } = { ...DEFAULT_SEARCH_OPTIONS.weights, ...options.weights };
    const scoring = { boosts, boostDocument: options.boostDocument, bm25: options.bm25 };
    const results = new Map();
    this.termResults(term, term, 1, scoring, results);

    const fuzzy = options.fuzzy === true ? 0.2 : (options.fuzzy || false);
    let fuzzyMatches = null;
    if (fuzzy) {
      const maxDistance = fuzzy < 1 ? Math.min(options.maxFuzzy, Math.round(term.length * fuzzy)) : fuzzy;
      if (maxDistance) fuzzyMatches = this.fuzzyMatches(term, maxDistance);
    }
    if (options.prefix === true) {
      for (const derived of this.prefixMatches(term)) {
        const distance = derived.length - term.length;
        if (!distance) continue;
        // A term that is both a prefix and a fuzzy match is scored as a prefix.
        fuzzyMatches?.delete(derived);
        const weight = prefixWeight * derived.length / (derived.length + 0.3 * distance);
        this.termResults(term, derived, weight, scoring, results);
      }
    }
    if (fuzzyMatches) {
      for (const [derived, distance] of fuzzyMatches) {
        if (!distance) continue;
        const weight = fuzzyWeight * derived.length / (derived.length + distance);
        this.termResults(term, derived, weight, scoring, results);
      }
    }
    return results;
  }

  termResults(sourceTerm, derivedTerm, termWeight, { boosts, boostDocument, bm25 }, results) {
    const postings = this.postings(derivedTerm);
    if (!postings) return;
    const { k, b, d } = bm25;
    for (const field of Object.keys(boosts)) {
      const fieldBoost = boosts[field];
      const fieldId = this.fieldIds[field];
      const pairs = postings.get(fieldId);
      if (!pairs) continue;
      const matchingFields = pairs.length / 2;
      const avgFieldLength = this.averageFieldLength[fieldId];
      const invDocFreq = Math.log(1 + (this.documentCount - matchingFields + 0.5) / (matchingFields + 0.5));
      for (let index = 0; index < pairs.length; index += 2) {
        const shortId = pairs[index];
        const docBoost = boostDocument
          ? boostDocument(this.documentIds[shortId], derivedTerm, this.storedFields(this.documentIds[shortId]))
          : 1;
        if (!docBoost) continue;
        const termFreq = pairs[index + 1];
        const fieldLength = this.fieldLengths[shortId * this.fieldCount + fieldId];
        const rawScore = invDocFreq * (d + termFreq * (k + 1) / (termFreq + k * (1 - b + b * fieldLength / avgFieldLength)));
        // Same multiplication order as MiniSearch (termBoost is always 1 here).
        const weightedScore = termWeight * 1 * fieldBoost * docBoost * rawScore;
        const result = results.get(shortId);
        if (result) {
          result.score += weightedScore;
          if (!result.terms.includes(sourceTerm)) result.terms.push(sourceTerm);
        } else {
          results.set(shortId, { score: weightedScore, terms: [sourceTerm] });
        }
      }
    }
  }

  combine(results, combineWith = "or") {
    if (results.length === 0) return new Map();
    const operator = String(combineWith).toLowerCase();
    if (operator === "or") {
      return results.reduce((left, right) => {
        for (const [shortId, entry] of right) {
          const existing = left.get(shortId);
          if (existing == null) {
            left.set(shortId, entry);
          } else {
            existing.score = existing.score + entry.score;
            assignUniqueTerms(existing.terms, entry.terms);
          }
        }
        return left;
      });
    }
    if (operator === "and") {
      return results.reduce((left, right) => {
        const combined = new Map();
        for (const [shortId, entry] of right) {
          const existing = left.get(shortId);
          if (existing == null) continue;
          assignUniqueTerms(existing.terms, entry.terms);
          combined.set(shortId, { score: existing.score + entry.score, terms: existing.terms });
        }
        return combined;
      });
    }
    throw new Error(`Invalid combination operator: ${combineWith}`);
  }
}

module.exports = {
  PersistedSearchIndex,
  SEARCH_INDEX_SCHEMA,
  writeSearchIndex,
};
