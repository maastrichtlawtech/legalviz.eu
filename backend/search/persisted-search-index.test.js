"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const MiniSearch = require("minisearch");

const { buildSqliteData } = require("./build-sqlite-data");
const { JsonLegalCacheStore } = require("./legal-cache-store");
const { PersistedSearchIndex, SEARCH_INDEX_SCHEMA, writeSearchIndex } = require("./persisted-search-index");
const {
  EUROVOC_INDEX_OPTIONS,
  buildEurovocSearch,
  buildMiniSearch,
  sqliteSearchRecords,
  titleIndexOptions,
  titleIndexStoredFields,
  todayIso,
} = require("./title-index");

const fixturePath = path.join(__dirname, "__fixtures__", "search-fixture.json");

// The persisted index promises MiniSearch's results, not an approximation:
// the same hits in the same order, with bit-identical scores and matched terms.
function assertSameResults(expected, actual, label) {
  assert.deepEqual(
    actual.map(({ id, score, queryTerms }) => ({ id, score, queryTerms })),
    expected.map(({ id, score, queryTerms }) => ({ id, score, queryTerms })),
    label,
  );
}

function buildFixtureDatabase() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "persisted-search-index-"));
  const caseLawPath = path.join(tempDir, "case-law.json");
  const sqlitePath = path.join(tempDir, "data.sqlite");
  fs.writeFileSync(caseLawPath, "{}", "utf8");
  buildSqliteData({ searchCachePath: fixturePath, caseLawCachePath: caseLawPath, outputPath: sqlitePath, log: () => {} });
  return { tempDir, sqlitePath };
}

// Every query term of the corpus, plus truncations (prefix matches) and
// single-character edits (fuzzy matches), alone and in pairs.
function queriesFor(vocabulary) {
  const queries = new Set(["", "the of", "c++ €"]);
  const terms = [...vocabulary];
  for (const term of terms) {
    queries.add(term);
    if (term.length > 3) {
      queries.add(term.slice(0, 3));
      queries.add(`${term.slice(0, -2)}x${term.slice(-1)}`);
      queries.add(term.slice(1));
    }
  }
  for (let index = 0; index + 1 < terms.length; index += 3) {
    queries.add(`${terms[index]} ${terms[index + 1]}`);
  }
  return [...queries];
}

test("persisted fixture indexes return exactly what MiniSearch returns", () => {
  const { tempDir, sqlitePath } = buildFixtureDatabase();
  const database = new Database(sqlitePath, { readonly: true });
  try {
    const records = sqliteSearchRecords(
      database.prepare("SELECT record_json FROM laws ORDER BY ordinal").all().map((row) => JSON.parse(row.record_json))
    );
    const today = todayIso();
    const storedFields = new Map(records.map((record) => [record.celex, titleIndexStoredFields(record, today)]));
    const indexes = [
      {
        name: "title",
        memory: buildMiniSearch(records, { includeExcerpt: false, includeEurovoc: false }),
        persisted: PersistedSearchIndex.open(
          database,
          "title",
          titleIndexOptions({ includeExcerpt: false, includeEurovoc: false }),
          { storedFields: (id) => storedFields.get(id) },
        ),
      },
      {
        name: "eurovoc",
        memory: buildEurovocSearch(records),
        persisted: PersistedSearchIndex.open(database, "eurovoc", EUROVOC_INDEX_OPTIONS),
      },
    ];
    const vocabulary = new Set();
    for (const record of records) {
      for (const text of [record.title, ...(record.aliases || []), ...(record.eurovoc || [])]) {
        for (const term of String(text || "").toLowerCase().split(/[\n\r\p{Z}\p{P}]+/u)) if (term) vocabulary.add(term);
      }
    }
    const boostDocument = (id, term, stored) => (stored.type === "regulation" ? 1.5 : 1) * (stored.inForce === false ? 0.5 : 1);

    let compared = 0;
    for (const { name, memory, persisted } of indexes) {
      assert.ok(persisted, `${name} index is persisted`);
      for (const query of queriesFor(vocabulary)) {
        for (const combineWith of ["AND", "OR"]) {
          assertSameResults(memory.search(query, { combineWith }), persisted.search(query, { combineWith }), `${name} ${combineWith} ${query}`);
          compared += 1;
        }
        if (name === "title") {
          assertSameResults(
            memory.search(query, { boostDocument }),
            persisted.search(query, { boostDocument }),
            `${name} boosted ${query}`,
          );
        }
      }
    }
    assert.ok(compared > 500, `compared ${compared} result lists`);
  } finally {
    database.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("persisted index matches MiniSearch where prefix, fuzzy and tie order interact", () => {
  // Terms chosen so one query term reaches the same derived term as both a
  // prefix and a fuzzy match ("data" → "dated"), several fuzzy matches share a
  // query ("protecton"), equal scores must keep MiniSearch's order, and a
  // repeated term, an empty field and non-ASCII text are all present.
  const options = {
    fields: ["title", "aliases"],
    searchOptions: { boost: { aliases: 3, title: 1 }, fuzzy: 0.2, prefix: true, combineWith: "AND" },
  };
  const documents = [
    { id: "a", title: "data protection data", aliases: "" },
    { id: "b", title: "date of protection", aliases: "dpd" },
    { id: "c", title: "dated protections", aliases: "" },
    { id: "d", title: "database protecting", aliases: "db" },
    { id: "e", title: "datum protector", aliases: "" },
    { id: "f", title: "data protection", aliases: "" },
    { id: "g", title: "data protection", aliases: "" },
    { id: "h", title: "Übereinkommen über Daten", aliases: "c++ data" },
    { id: "i", title: "", aliases: "" },
  ];
  const memory = new MiniSearch(options);
  memory.addAll(documents);
  const database = new Database(":memory:");
  try {
    database.exec(SEARCH_INDEX_SCHEMA);
    assert.deepEqual(writeSearchIndex(database, "title", memory), { documents: documents.length, terms: memory.termCount });
    const persisted = PersistedSearchIndex.open(database, "title", options);
    const queries = [
      "data", "dat", "date", "dated", "datum", "database", "protecton", "protection", "protections",
      "protect", "data protection", "date protection", "dpd", "db", "übereinkommen", "über", "daten",
      "c++", "c", "nothing", "data data", "",
    ];
    for (const query of queries) {
      for (const combineWith of ["AND", "OR"]) {
        assertSameResults(memory.search(query, { combineWith }), persisted.search(query, { combineWith }), `${combineWith} ${query}`);
      }
      assertSameResults(
        memory.search(query, { fuzzy: 0.4, maxFuzzy: 2, weights: { fuzzy: 0.6 } }),
        persisted.search(query, { fuzzy: 0.4, maxFuzzy: 2, weights: { fuzzy: 0.6 } }),
        `overridden options ${query}`,
      );
    }
  } finally {
    database.close();
  }
});

test("the SQLite store searches the persisted indexes, not an in-memory MiniSearch", () => {
  const { tempDir, sqlitePath } = buildFixtureDatabase();
  try {
    const store = new JsonLegalCacheStore(fixturePath, { sqlitePath, requireSqlite: true });
    assert.equal(store.load(), true);
    assert.ok(store.miniSearch instanceof PersistedSearchIndex);
    assert.ok(store.eurovocSearch instanceof PersistedSearchIndex);
    const memory = buildMiniSearch(store.records, { includeExcerpt: false, includeEurovoc: false });
    assertSameResults(memory.search("data protection"), store.miniSearch.search("data protection"), "store title index");
    assert.ok(store.searchLaws("data protection").length > 0);
    store.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("baseline ranking over the persisted index matches baseline ranking over MiniSearch", () => {
  // The baseline profile is the one that passes boostDocument, so this is the
  // path that resolves stored fields from the store's records.
  const { tempDir, sqlitePath } = buildFixtureDatabase();
  try {
    const store = new JsonLegalCacheStore(fixturePath, { sqlitePath, requireSqlite: true, rankingProfile: "baseline" });
    assert.equal(store.load(), true);
    const queries = ["data protection", "digital", "services act", "regulaton", "privacy electronic"];
    const persisted = queries.map((query) => store.searchLaws(query, { limit: 50 }));
    store.miniSearch = buildMiniSearch(store.records, { includeExcerpt: false, includeEurovoc: false });
    const memory = queries.map((query) => store.searchLaws(query, { limit: 50 }));
    assert.deepEqual(persisted, memory);
    assert.ok(persisted.some((results) => results.length > 1));
    store.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("SQLite data without the persisted search indexes fails to load", () => {
  const { tempDir, sqlitePath } = buildFixtureDatabase();
  try {
    const writable = new Database(sqlitePath);
    writable.exec("DELETE FROM search_indexes WHERE name = 'eurovoc'");
    writable.close();
    const store = new JsonLegalCacheStore(fixturePath, { sqlitePath, requireSqlite: true });
    assert.equal(store.load(), false);
    assert.match(store.loadError, /persisted title\/EuroVoc search index/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
