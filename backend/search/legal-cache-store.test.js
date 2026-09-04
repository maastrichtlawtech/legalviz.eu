const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const {
  JsonLegalCacheStore,
  containedAliasKeys,
  documentPrior,
  isNotYetInForce,
} = require("./legal-cache-store");
const { buildSqliteData } = require("./build-sqlite-data");
const { openFulltextDatabase, FULLTEXT_SCHEMA_VERSION } = require("./fulltext-index-build");

const fixturePath = path.join(__dirname, "__fixtures__", "search-fixture.json");

// Builds a tiny fulltext.sqlite with the exact schema/metadata contract
// legal-cache-store.js's loadFulltext() checks (units/units_fts via
// openFulltextDatabase from the real builder module, fulltext_metadata rows,
// PRAGMA user_version). unitsByCelex maps celex -> [{unit_type, number,
// heading, text}]. Pass `version` to simulate a stale/mismatched artifact.
function buildTestFulltextDb(outputPath, unitsByCelex, { version = FULLTEXT_SCHEMA_VERSION, skipMetadata = false } = {}) {
  const db = openFulltextDatabase(outputPath);
  const insertUnit = db.prepare("INSERT INTO units (celex, unit_type, number, heading, char_count, text) VALUES (?,?,?,?,?,?)");
  const insertFts = db.prepare("INSERT INTO units_fts (rowid, heading, text) VALUES (?,?,?)");
  let unitCount = 0;
  let articleCount = 0;
  let recitalCount = 0;
  for (const [celex, units] of Object.entries(unitsByCelex)) {
    for (const unit of units) {
      const heading = unit.heading || "";
      const text = unit.text || "";
      const info = insertUnit.run(celex, unit.unit_type, unit.number || "", heading, text.length, text);
      insertFts.run(info.lastInsertRowid, heading, text);
      unitCount += 1;
      if (unit.unit_type === "article") articleCount += 1;
      if (unit.unit_type === "recital") recitalCount += 1;
    }
  }
  if (!skipMetadata) {
    const upsert = db.prepare("INSERT INTO fulltext_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    upsert.run("fulltext_version", String(version));
    upsert.run("parser_version", "1");
    upsert.run("generated_at", new Date("2026-01-01T00:00:00.000Z").toISOString());
    upsert.run("unit_count", String(unitCount));
    upsert.run("article_count", String(articleCount));
    upsert.run("recital_count", String(recitalCount));
    upsert.run("act_count", String(Object.keys(unitsByCelex).length));
    db.pragma(`user_version = ${version}`);
  }
  db.close();
}

function publicRecord(record) {
  return {
    celex: record?.celex,
    title: record?.title,
    date: record?.date,
    eli: record?.eli,
    type: record?.type,
    fmxAvailable: record?.fmxAvailable,
    fmxUnavailable: record?.fmxUnavailable,
    enrichError: record?.enrichError,
    eurovoc: record?.eurovoc,
    inForce: record?.inForce,
    endOfValidity: record?.endOfValidity,
    entryIntoForce: record?.entryIntoForce,
    celexYear: record?.celexYear,
    celexNumber: record?.celexNumber,
    aliases: record?.aliases,
  };
}

test("legal cache store loads fixture successfully", () => {
  const store = new JsonLegalCacheStore(fixturePath);
  assert.equal(store.load(), true);
  assert.equal(store.getStatus().ready, true);
  assert.equal(store.getStatus().count, 18);
});

// The offline re-derive builders are pointed at whichever of the two forms an
// earlier workflow step left on disk, and citation-graph-build.js resolves its
// reference index through this store. Handed a .gz path it used to find the
// file, skip the gunzip branch, and JSON.parse the compressed bytes -- failing
// with "Unexpected token '\u001f'" on a perfectly readable artifact.
test("legal cache store reads a cache path that is itself gzipped", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-gz-"));
  try {
    const gzPath = path.join(work, "search-cache.json.gz");
    fs.writeFileSync(gzPath, zlib.gzipSync(fs.readFileSync(fixturePath)));
    assert.equal(fs.existsSync(path.join(work, "search-cache.json")), false);

    const store = new JsonLegalCacheStore(gzPath, { preferJson: true });
    assert.equal(store.load(), true);
    assert.equal(store.getStatus().ready, true);
    assert.equal(store.getStatus().count, 18);
    assert.ok(store.exportReferenceIndex());
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("a missing gzipped cache path reports that path, not a doubled suffix", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-gz-"));
  try {
    const gzPath = path.join(work, "search-cache.json.gz");
    const store = new JsonLegalCacheStore(gzPath, { preferJson: true });
    assert.equal(store.load(), false);
    assert.match(store.getStatus().error, /search-cache\.json\.gz$/);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("a plain cache path still prefers the raw file over its .gz sibling", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-gz-"));
  try {
    const jsonPath = path.join(work, "search-cache.json");
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    fs.writeFileSync(jsonPath, JSON.stringify(fixture));
    // A .gz sibling holding only a single record: if it were preferred, the
    // record count below would not match the raw file's.
    fs.writeFileSync(`${jsonPath}.gz`, zlib.gzipSync(JSON.stringify({
      ...fixture, records: fixture.records.slice(0, 1),
    })));

    const store = new JsonLegalCacheStore(jsonPath, { preferJson: true });
    assert.equal(store.load(), true);
    assert.equal(store.getStatus().count, 18);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("legal cache store loads SQLite records without retaining excerpts", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-store-sqlite-"));
  const caseLawPath = path.join(tempDir, "case-law.json");
  const sqlitePath = path.join(tempDir, "data.sqlite");
  fs.writeFileSync(caseLawPath, "{}", "utf8");
  buildSqliteData({ searchCachePath: fixturePath, caseLawCachePath: caseLawPath, outputPath: sqlitePath });

  const store = new JsonLegalCacheStore(fixturePath, { sqlitePath, requireSqlite: true });
  assert.equal(store.load(), true);
  assert.equal(store.source, "sqlite");
  assert.equal(store.getStatus().count, 18);
  assert.equal(store.records.every((record) => !Object.hasOwn(record, "excerpt")), true);
  assert.equal(store.getByCelex("32002L0058")?.celex, "32002L0058");
  store.close();
});

test("JSON and SQLite hydrate the same public law-record contract", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-store-contract-"));
  const caseLawPath = path.join(tempDir, "case-law.json");
  const sqlitePath = path.join(tempDir, "data.sqlite");
  fs.writeFileSync(caseLawPath, "{}", "utf8");
  buildSqliteData({ searchCachePath: fixturePath, caseLawCachePath: caseLawPath, outputPath: sqlitePath });

  const jsonStore = new JsonLegalCacheStore(fixturePath, { preferJson: true });
  const sqliteStore = new JsonLegalCacheStore(fixturePath, { sqlitePath, requireSqlite: true });
  assert.equal(jsonStore.load(), true);
  assert.equal(sqliteStore.load(), true);
  assert.deepEqual(
    sqliteStore.records.map((record) => publicRecord(record)),
    jsonStore.records.map((record) => publicRecord(record))
  );
  sqliteStore.close();
});

test("an explicit missing SQLite path fails instead of silently loading JSON", () => {
  const missing = path.join(os.tmpdir(), `missing-data-${Date.now()}.sqlite`);
  const store = new JsonLegalCacheStore(fixturePath, { sqlitePath: missing, requireSqlite: true });
  assert.equal(store.load(), false);
  assert.match(store.loadError, /SQLite data store not found/);
});

test("preferJson ignores DATA_SQLITE_PATH for JSON authoring tools", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-store-prefer-json-"));
  const caseLawPath = path.join(tempDir, "case-law.json");
  const sqlitePath = path.join(tempDir, "data.sqlite");
  fs.writeFileSync(caseLawPath, "{}", "utf8");
  buildSqliteData({ searchCachePath: fixturePath, caseLawCachePath: caseLawPath, outputPath: sqlitePath });

  const previousSqlitePath = process.env.DATA_SQLITE_PATH;
  process.env.DATA_SQLITE_PATH = sqlitePath;
  try {
    const store = new JsonLegalCacheStore(fixturePath, { preferJson: true });
    assert.equal(store.load(), true);
    assert.equal(store.source, "json");
    assert.equal(Array.isArray(store.payload?.records), true);
  } finally {
    if (previousSqlitePath === undefined) delete process.env.DATA_SQLITE_PATH;
    else process.env.DATA_SQLITE_PATH = previousSqlitePath;
  }
});

test("legal cache store reports missing file", () => {
  const missingPath = path.join(os.tmpdir(), `missing-${Date.now()}.json`);
  const store = new JsonLegalCacheStore(missingPath);
  assert.equal(store.load(), false);
  assert.equal(store.getStatus().ready, false);
  assert.match(store.getStatus().error, /Search cache not found/);
});

test("legal cache store reports malformed JSON", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-store-bad-"));
  const tempPath = path.join(tempDir, "broken.json");
  fs.writeFileSync(tempPath, "{not valid json", "utf8");

  const store = new JsonLegalCacheStore(tempPath);
  assert.equal(store.load(), false);
  assert.equal(store.getStatus().ready, false);
  assert.match(store.getStatus().error, /Unexpected token|Expected property name|JSON/i);
});

test("legal cache store resolves exact CELEX", () => {
  const store = new JsonLegalCacheStore(fixturePath);
  store.load();
  assert.equal(store.getByCelex("32016r0679")?.title.includes("General Data Protection Regulation"), true);
});

test("legal cache store resolves exact ELI", () => {
  const store = new JsonLegalCacheStore(fixturePath);
  store.load();
  const match = store.getByEli("https://data.europa.eu/eli/dir/2015/2366/oj/");
  assert.equal(match?.celex, "32015L2366");
});

test("legal cache store resolves exact official reference", () => {
  const store = new JsonLegalCacheStore(fixturePath);
  store.load();
  const match = store.getByOfficialReference({
    actType: "Directive",
    year: "2015",
    number: "02366",
  });
  assert.equal(match?.celex, "32015L2366");
});

test("legal cache store resolves untyped official references before title matches", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-store-untyped-reference-"));
  const tempPath = path.join(tempDir, "search.json");
  fs.writeFileSync(tempPath, JSON.stringify({ records: [
    {
      celex: "32021R2115",
      title: "Common agricultural policy rules",
      type: "regulation",
      eli: "http://data.europa.eu/eli/reg/2021/2115/oj",
    },
    {
      celex: "32024R0123",
      title: "Regulation amending Regulation (EU) 2021/2115",
      type: "regulation",
      eli: "http://data.europa.eu/eli/reg/2024/123/oj",
    },
    {
      celex: "32014R2115",
      title: "Regulation 2014 reference",
      type: "regulation",
      eli: "http://data.europa.eu/eli/reg/2014/2115/oj",
    },
    {
      celex: "32014L2115",
      title: "Directive 2014 reference",
      type: "directive",
      eli: "http://data.europa.eu/eli/dir/2014/2115/oj",
    },
    {
      celex: "32014D2115",
      title: "Decision 2014 reference",
      type: "decision",
      eli: "http://data.europa.eu/eli/dec/2014/2115/oj",
    },
  ] }), "utf8");

  const store = new JsonLegalCacheStore(tempPath, { preferJson: true });
  try {
    assert.equal(store.load(), true);

    for (const query of ["2021/2115", "2021 2115"]) {
      const results = store.searchLaws(query, { limit: 2 });
      assert.deepEqual(results.map((result) => result.celex), ["32021R2115", "32024R0123"]);
      assert.equal(results[0].matchReason, "reference_exact");
      assert.equal(results[1].matchReason, "title_phrase");
    }

    const overlappingReferences = store.searchLaws("2014/2115", { limit: 3 });
    assert.deepEqual(
      overlappingReferences.map((result) => result.celex),
      ["32014R2115", "32014L2115", "32014D2115"]
    );
    assert.deepEqual(
      overlappingReferences.map((result) => result.matchReason),
      ["reference_exact", "reference_exact", "reference_exact"]
    );
  } finally {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("legal cache store supplements the ePrivacy Directive when missing from cache", () => {
  const store = new JsonLegalCacheStore(fixturePath);
  store.load();

  const match = store.getByCelex("32002L0058");
  assert.equal(match?.celex, "32002L0058");
  assert.match(match?.title || "", /privacy in the electronic communications sector/i);
});

test("legal cache store supplements the eCommerce Directive when missing from cache", () => {
  const store = new JsonLegalCacheStore(fixturePath);
  store.load();

  const match = store.getByCelex("32000L0031");
  assert.equal(match?.celex, "32000L0031");
  assert.match(match?.title || "", /electronic commerce/i);
});

test("legal cache store searchLaws ranks deterministic hits above free-text hits", () => {
  const store = new JsonLegalCacheStore(fixturePath);
  store.load();

  const results = store.searchLaws("digital markets act", { limit: 10 });
  assert.equal(results[0]?.celex, "32022R1925");
  assert.equal(results[0]?.matchReason, "alias_exact");
});

test("legal cache store searchLaws falls back to OR combine when AND yields no hits", () => {
  const store = new JsonLegalCacheStore(fixturePath);
  store.load();

  const results = store.searchLaws("gdpr artificial intelligence");
  const celexes = results.map((entry) => entry.celex);
  assert.ok(celexes.includes("32016R0679"));
  assert.ok(celexes.includes("32024R1689"));
});

test("legal cache store searchLaws honors disableRewrites for both stages", () => {
  const store = new JsonLegalCacheStore(fixturePath);
  store.load();

  const rewritten = store.searchLaws("dma", { limit: 1 });
  assert.equal(rewritten[0]?.celex, "32022R1925");

  const notRewritten = store.searchLaws("dma", { limit: 1, disableRewrites: true });
  assert.notEqual(notRewritten[0]?.celex, "32022R1925");
});

test("legal cache store searchLaws clamps the result limit", () => {
  const store = new JsonLegalCacheStore(fixturePath);
  store.load();

  assert.equal(store.searchLaws("regulation", { limit: 1 }).length, 1);
  assert.equal(store.searchLaws("regulation", { limit: 1000 }).length <= 50, true);
});

test("legal cache store searchLaws ranks a regulation above a decision for an \"... act\" query", () => {
  const store = new JsonLegalCacheStore(fixturePath);
  store.load();

  // The fixture holds a decision and a regulation with near-identical titles
  // that both free-text match "harmonised widget act". The act-type boost must
  // pull the regulation above the decision (the decision is indexed first, so
  // without the boost it would win the tie).
  const celexes = store.searchLaws("harmonised widget act", { limit: 5 }).map((r) => r.celex);
  assert.ok(celexes.includes("32021R0999"), `regulation missing: ${celexes.join(", ")}`);
  assert.ok(celexes.includes("32021D0998"), `decision missing: ${celexes.join(", ")}`);
  assert.ok(
    celexes.indexOf("32021R0999") < celexes.indexOf("32021D0998"),
    `regulation should outrank decision, got: ${celexes.join(", ")}`
  );
});

// Topics ride in the cache itself from data-v6 on — there is no sidecar to
// merge, and no way for one to drift out of sync with the records.
test("legal cache store exposes EuroVoc topics carried by the cache", () => {
  const store = new JsonLegalCacheStore(fixturePath);
  store.load();

  const match = store.getByCelex("32016R0679");
  assert.deepEqual(match?.eurovoc, [
    "data protection",
    "personal data",
    "protection of privacy",
    "data transfer",
    "approximation of laws",
    "EU Member State",
    "electronic data processing",
  ]);
});

test("legal cache store reports ranking-signal coverage", () => {
  const store = new JsonLegalCacheStore(fixturePath, { preferJson: true });
  assert.equal(store.load(), true);
  const stats = store.getRankingSignalStats();
  assert.equal(stats.records, store.records.length);
  assert.ok(stats.eurovocRecords > 0);
  assert.ok(stats.knownStatusRecords > 0);
  assert.equal(stats.excerptRecords, 0);
});

test("legal cache store retrieves a law by EuroVoc topic absent from its title", () => {
  const store = new JsonLegalCacheStore(fixturePath);
  store.load();

  const results = store.searchLaws("electronic data processing", { limit: 5 });
  assert.equal(results[0]?.celex, "32016R0679");
});

test("baseline ranking profile provides a reproducible EuroVoc-free comparison", () => {
  const baseline = new JsonLegalCacheStore(fixturePath, { preferJson: true, rankingProfile: "baseline" });
  const revised = new JsonLegalCacheStore(fixturePath, { preferJson: true, rankingProfile: "revised" });
  baseline.load();
  revised.load();

  const query = "online platform competition policy";
  assert.notEqual(baseline.searchLaws(query, { limit: 1 })[0]?.celex, "32022R1925");
  assert.equal(revised.searchLaws(query, { limit: 1 })[0]?.celex, "32022R1925");
});

test("free-text ranking prefers an in-force law but preserves historical intent", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-store-status-ranking-"));
  const tempPath = path.join(tempDir, "status-ranking.json");
  fs.writeFileSync(tempPath, JSON.stringify({ records: [
    {
      celex: "32020L0001",
      title: "Personal Data Protection Framework",
      type: "directive",
      eli: "http://data.europa.eu/eli/dir/2020/1/oj",
      inForce: false,
    },
    {
      celex: "32020L0002",
      title: "Personal Data Protection Framework",
      type: "directive",
      eli: "http://data.europa.eu/eli/dir/2020/2/oj",
      inForce: true,
    },
  ] }), "utf8");

  const store = new JsonLegalCacheStore(tempPath, { preferJson: true });
  assert.equal(store.load(), true);
  assert.equal(store.searchLaws("personal data protection")[0]?.celex, "32020L0002");
  // Historical wording reverses the small status preference rather than
  // silently rewriting an explicitly historical query toward current law.
  assert.equal(store.searchLaws("historical personal data protection")[0]?.celex, "32020L0001");
});

test("free-text ranking uses a capped distinct-citing-act prior", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-store-citation-ranking-"));
  const tempPath = path.join(tempDir, "citation-ranking.json");
  fs.writeFileSync(tempPath, JSON.stringify({ records: [
    {
      celex: "32020R0001",
      title: "Common Widget Rules",
      type: "regulation",
      eli: "http://data.europa.eu/eli/reg/2020/1/oj",
    },
    {
      celex: "32020R0002",
      title: "Common Widget Rules",
      type: "regulation",
      eli: "http://data.europa.eu/eli/reg/2020/2/oj",
    },
  ] }), "utf8");

  const store = new JsonLegalCacheStore(tempPath, {
    preferJson: true,
    citationCounts: [["32020R0002", 500]],
  });
  assert.equal(store.load(), true);
  assert.equal(store.searchLaws("common widget rules")[0]?.celex, "32020R0002");
  // Deterministic lookup remains stronger than every global prior.
  assert.equal(store.searchLaws("32020R0001")[0]?.celex, "32020R0001");
});

test("SQLite search derives citation authority from distinct citing acts", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-store-citation-sqlite-"));
  const searchPath = path.join(tempDir, "search.json");
  const caseLawPath = path.join(tempDir, "case-law.json");
  const graphPath = path.join(tempDir, "citation-graph.json");
  const sqlitePath = path.join(tempDir, "data.sqlite");
  const records = ["32020R0001", "32020R0002"].map((celex, index) => ({
    celex,
    title: "Common Widget Rules",
    type: "regulation",
    eli: `http://data.europa.eu/eli/reg/2020/${index + 1}/oj`,
  }));
  fs.writeFileSync(searchPath, JSON.stringify({ records }), "utf8");
  fs.writeFileSync(caseLawPath, "{}", "utf8");
  fs.writeFileSync(graphPath, JSON.stringify({
    graphVersion: 2,
    parserVersion: 15,
    generatedAt: "2026-07-16T00:00:00.000Z",
    coverage: {},
    stats: { edges: 2 },
    edges: [
      { kind: "legislation", sourceCelex: "32021R0010", sourceUnitType: "article", sourceUnit: "1", targetCelex: "32020R0002", targetArticle: null },
      // A second provision from the same act must not add another authority vote.
      { kind: "legislation", sourceCelex: "32021R0010", sourceUnitType: "article", sourceUnit: "2", targetCelex: "32020R0002", targetArticle: null },
    ],
  }), "utf8");
  buildSqliteData({
    searchCachePath: searchPath,
    caseLawCachePath: caseLawPath,
    citationGraphPath: graphPath,
    outputPath: sqlitePath,
    log: () => {},
  });

  const store = new JsonLegalCacheStore(searchPath, { sqlitePath, requireSqlite: true });
  assert.equal(store.load(), true);
  assert.equal(store.citationCounts.get("32020R0002"), 1);
  assert.equal(store.searchLaws("common widget rules")[0]?.celex, "32020R0002");
  store.close();
});

test("legal cache store caps searchLaws topics at 5 and defaults to empty array for a record with none", () => {
  const store = new JsonLegalCacheStore(fixturePath);
  store.load();

  const [gdpr] = store.searchLaws("32016R0679", { limit: 1 });
  assert.equal(gdpr.topics.length, 5);
  assert.deepEqual(gdpr.topics, [
    "data protection",
    "personal data",
    "protection of privacy",
    "data transfer",
    "approximation of laws",
  ]);

  const [dataAct] = store.searchLaws("32023R2854", { limit: 1 });
  assert.deepEqual(dataAct.topics, []);
});

// In-force status rides in the cache like topics do. `inForce` is a tri-state:
// true / false / null for "Cellar has no status for this act". The wire contract
// normalises an absent field to null so the client sees one shape.
test("legal cache store exposes in-force status through searchLaws", () => {
  const store = new JsonLegalCacheStore(fixturePath);
  store.load();

  const [gdpr] = store.searchLaws("32016R0679", { limit: 1 });
  assert.equal(gdpr.inForce, true);
  assert.equal(gdpr.endOfValidity, null);

  // PSD2 is flagged in force *and* carries an end-of-validity date. Cellar's
  // flag is authoritative; status must never be derived from the date.
  const [psd2] = store.searchLaws("32015L2366", { limit: 1 });
  assert.equal(psd2.inForce, true);
  assert.equal(psd2.endOfValidity, "2026-06-18");

  // A record predating the field reads as unknown, not as out of force.
  const [synthetic] = store.searchLaws("32026R0667", { limit: 1 });
  assert.equal(synthetic.inForce, null);
  assert.equal(synthetic.endOfValidity, null);
});

// `false` is the whole point of the field, and it is exactly the value a
// `|| null` or a truthiness check would quietly turn into "unknown".
test("legal cache store keeps a false in-force status distinct from unknown", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-store-in-force-"));
  const tempPath = path.join(tempDir, "repealed.json");
  fs.writeFileSync(tempPath, JSON.stringify({
    records: [{
      celex: "31995L0046",
      title: "Directive 95/46/EC on the protection of individuals with regard to the processing of personal data",
      type: "directive",
      date: "1995-10-24",
      eli: "http://data.europa.eu/eli/dir/1995/46/oj",
      inForce: false,
      endOfValidity: "2018-05-24",
    }],
  }), "utf8");

  const store = new JsonLegalCacheStore(tempPath, { preferJson: true });
  assert.equal(store.load(), true);

  const [match] = store.searchLaws("31995L0046", { limit: 1 });
  assert.equal(match.inForce, false);
  assert.equal(match.endOfValidity, "2018-05-24");
});

// The SQLite path is production. compactSqliteRecord is a hand-maintained
// whitelist, so a field can pass every JSON-backed test and still never reach
// the client — silently. Pin the round trip, including the false case.
test("SQLite round trip carries in-force status, including false", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-store-in-force-sqlite-"));
  const cachePath = path.join(tempDir, "cache.json");
  const caseLawPath = path.join(tempDir, "case-law.json");
  const sqlitePath = path.join(tempDir, "data.sqlite");
  fs.writeFileSync(caseLawPath, "{}", "utf8");
  fs.writeFileSync(cachePath, JSON.stringify({
    records: [
      {
        celex: "32016R0679",
        title: "Regulation (EU) 2016/679 on the protection of natural persons",
        type: "regulation",
        date: "2016-04-27",
        eli: "http://data.europa.eu/eli/reg/2016/679/oj",
        inForce: true,
        endOfValidity: null,
      },
      {
        celex: "31995L0046",
        title: "Directive 95/46/EC on the protection of individuals",
        type: "directive",
        date: "1995-10-24",
        eli: "http://data.europa.eu/eli/dir/1995/46/oj",
        inForce: false,
        endOfValidity: "2018-05-24",
      },
    ],
  }), "utf8");
  buildSqliteData({ searchCachePath: cachePath, caseLawCachePath: caseLawPath, outputPath: sqlitePath });

  const store = new JsonLegalCacheStore(cachePath, { sqlitePath, requireSqlite: true });
  assert.equal(store.load(), true);
  assert.equal(store.source, "sqlite");

  assert.equal(store.getByCelex("32016R0679")?.inForce, true);
  assert.equal(store.getByCelex("31995L0046")?.inForce, false);
  assert.equal(store.getByCelex("31995L0046")?.endOfValidity, "2018-05-24");

  const [repealed] = store.searchLaws("31995L0046", { limit: 1 });
  assert.equal(repealed.inForce, false);
  assert.equal(repealed.endOfValidity, "2018-05-24");
  store.close();
});

// A cache built by search-build.js carries no eurovoc field at all (the fold
// happens before release). That must read as "no topics", not throw.
test("legal cache store serves a cache whose records carry no topics field", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-store-no-topics-"));
  const tempPath = path.join(tempDir, "no-topics.json");
  fs.writeFileSync(tempPath, JSON.stringify({
    records: [{
      celex: "31985L0374",
      title: "Council Directive 85/374/EEC on liability for defective products",
      type: "directive",
      date: "1985-07-25",
      eli: "http://data.europa.eu/eli/dir/1985/374/oj",
    }],
  }), "utf8");

  const store = new JsonLegalCacheStore(tempPath);
  assert.equal(store.load(), true);
  assert.equal(store.getStatus().ready, true);

  const [directive] = store.searchLaws("31985L0374", { limit: 1 });
  assert.deepEqual(directive.topics, []);
  assert.equal(directive.date, "1985-07-25");
});

test("legal cache store stays searchable when a CELEX is duplicated", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-store-"));
  const tempPath = path.join(tempDir, "duplicate-celex.json");
  fs.writeFileSync(tempPath, JSON.stringify({
    generatedAt: "2026-03-28T00:00:00.000Z",
    count: 2,
    records: [
      {
        celex: "32020R0123",
        title: "Regulation (EU) 2020/123 on widgets",
        type: "regulation",
        date: "2020-01-01",
        eli: "http://data.europa.eu/eli/reg/2020/123/oj",
        fmxAvailable: true,
        fmxUnavailable: false,
      },
      {
        celex: "32020R0123",
        title: "Regulation (EU) 2020/123 on widgets duplicate",
        type: "regulation",
        date: "2020-01-02",
        eli: "http://data.europa.eu/eli/reg/2020/124/oj",
        fmxAvailable: true,
        fmxUnavailable: false,
      },
    ],
  }, null, 2));

  const store = new JsonLegalCacheStore(tempPath);
  assert.equal(store.load(), true);
  assert.equal(store.getStatus().ready, true);
  // A duplicated id must not throw during index build and take down search.
  const results = store.searchLaws("widgets", { limit: 5 });
  assert.equal(results[0]?.celex, "32020R0123");
});

test("legal cache store searchLaws matches a law via excerpt text alone (title/aliases don't mention the topic)", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-store-excerpt-"));
  const tempPath = path.join(tempDir, "excerpt.json");
  fs.writeFileSync(tempPath, JSON.stringify({
    generatedAt: "2026-03-28T00:00:00.000Z",
    count: 2,
    records: [
      {
        celex: "32024R9001",
        title: "Regulation (EU) 2024/9001 on widget market surveillance",
        type: "regulation",
        date: "2024-01-01",
        eli: "http://data.europa.eu/eli/reg/2024/9001/oj",
        fmxAvailable: true,
        fmxUnavailable: false,
        excerpt: "This Regulation lays down harmonised rules on automated decision-making systems and establishes transparency obligations for providers deploying automated decision-making in the internal market.",
      },
      {
        celex: "32024R9002",
        title: "Regulation (EU) 2024/9002 on gadget labelling requirements",
        type: "regulation",
        date: "2024-01-02",
        eli: "http://data.europa.eu/eli/reg/2024/9002/oj",
        fmxAvailable: true,
        fmxUnavailable: false,
        excerpt: "This Regulation concerns the physical labelling of consumer gadgets sold within the Union.",
      },
    ],
  }, null, 2));

  const store = new JsonLegalCacheStore(tempPath);
  assert.equal(store.load(), true);

  // Neither record's title/aliases mention "automated decision-making" — only
  // the first record's excerpt does. A pre-excerpt index would return nothing.
  const results = store.searchLaws("automated decision-making", { limit: 5 });
  const celexes = results.map((entry) => entry.celex);
  assert.ok(celexes.includes("32024R9001"), `expected excerpt-only match, got: ${celexes.join(", ")}`);
  assert.ok(!celexes.includes("32024R9002"), `unrelated excerpt should not match, got: ${celexes.join(", ")}`);
});

test("SQLite excerpt search handles punctuation and reads case-law details", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-store-fts-"));
  const searchPath = path.join(tempDir, "search.json");
  const caseLawPath = path.join(tempDir, "case-law.json");
  const sqlitePath = path.join(tempDir, "data.sqlite");
  fs.writeFileSync(searchPath, JSON.stringify({ records: [{
    celex: "32024R9001",
    title: "Regulation on widget market surveillance",
    type: "regulation",
    eli: "http://data.europa.eu/eli/reg/2024/9001/oj",
    excerpt: "Harmonised rules on automated decision-making systems and Article 22 safeguards.",
  }] }), "utf8");
  fs.writeFileSync(caseLawPath, JSON.stringify({
    "62020CJ0001": {
      name: "Example judgment",
      declarations: [{ number: 1, text: "The Court rules." }],
      articlesCited: ["Art. 22 GDPR"],
      articleRefs: [],
    },
    "62020CJ0002": { name: null, declarations: [], articlesCited: [], articleRefs: [] },
  }), "utf8");
  buildSqliteData({ searchCachePath: searchPath, caseLawCachePath: caseLawPath, outputPath: sqlitePath });

  const store = new JsonLegalCacheStore(searchPath, { sqlitePath, requireSqlite: true });
  assert.equal(store.load(), true);
  assert.equal(store.searchLaws("automated decision-making")[0]?.celex, "32024R9001");
  assert.doesNotThrow(() => store.searchLaws("regulation 2016/679"));
  assert.doesNotThrow(() => store.searchLaws("Article 22(1)"));
  assert.equal(store.getCaseLawDetails(["62020cj0001"]).get("62020CJ0001")?.name, "Example judgment");
  assert.deepEqual(store.getCaseLawCacheStats(), { total: 2, partial: 1, failedRecently: 0 });
  store.close();
});

test("definition search and comparison work in JSON and SQLite stores", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-definitions-"));
  const searchPath = path.join(tempDir, "search.json");
  const caseLawPath = path.join(tempDir, "case-law.json");
  const definitionsPath = path.join(tempDir, "definitions.json");
  const sqlitePath = path.join(tempDir, "data.sqlite");
  fs.writeFileSync(searchPath, JSON.stringify({ records: [
    { celex: "32022L2555", title: "NIS 2 Directive", type: "directive", date: "2022-12-14", eli: "http://data.europa.eu/eli/dir/2022/2555/oj" },
    { celex: "32022L2557", title: "CER Directive", type: "directive", date: "2022-12-14", eli: "http://data.europa.eu/eli/dir/2022/2557/oj" },
    { celex: "32024R0001", title: "Imported Risk Regulation", type: "regulation", date: "2024-01-01" },
  ] }), "utf8");
  fs.writeFileSync(caseLawPath, "{}", "utf8");
  fs.writeFileSync(definitionsPath, JSON.stringify({ occurrences: [
    { occurrenceId: "risk-a", normalizedTerm: "risk", term: "risk", definition: "the potential for loss", definitionHash: "a", classification: "substantive", celex: "32022L2555", sourceArticle: "6" },
    { occurrenceId: "risk-b", normalizedTerm: "risk", term: "risk", definition: "a possible harmful event", definitionHash: "b", classification: "hybrid", celex: "32022L2557", sourceArticle: "3" },
    { occurrenceId: "risk-import", normalizedTerm: "risk", term: "risk", definition: "risk as defined in Article 6 of Directive (EU) 2022/2555", definitionHash: "import", classification: "imported", celex: "32024R0001", sourceArticle: "2", referenceEdges: [{ edgeType: "definition_import", sourceOccurrenceId: "risk-import", targetCelex: "32022L2555", targetArticle: "6", targetOccurrenceId: "risk-a", resolution: "definition" }] },
    { occurrenceId: "stable-a", normalizedTerm: "stable", term: "stable", definition: "unlikely to change", definitionHash: "stable", classification: "substantive", celex: "32022L2555", sourceArticle: "2" },
  ] }), "utf8");
  buildSqliteData({
    searchCachePath: searchPath, caseLawCachePath: caseLawPath, definitionsPath,
    citationGraphPath: path.join(tempDir, "absent-graph.json"), outputPath: sqlitePath, log: () => {},
  });

  const stores = [
    new JsonLegalCacheStore(searchPath, { preferJson: true, definitionsPath }),
    new JsonLegalCacheStore(searchPath, { sqlitePath, requireSqlite: true }),
  ];
  for (const store of stores) {
    assert.equal(store.load(), true);
    const results = store.searchDefinitions("risk");
    assert.equal(results.length, 1);
    assert.equal(results[0].lawCount, 3);
    assert.equal(results[0].substantiveLawCount, 2);
    assert.equal(results[0].importCount, 1);
    assert.equal(results[0].wordingCount, 2);
    assert.equal(results[0].representativeSource.celex, "32022L2555");
    assert.equal(store.searchDefinitions("stable", { filter: "different" }).length, 0);
    assert.equal(store.searchDefinitions("stable", { filter: "reused" }).length, 0);
    assert.equal(store.searchDefinitions("", { filter: "different" })[0].normalizedTerm, "risk");
    assert.equal(store.searchDefinitions("", { filter: "reused" })[0].importCount, 1);
    if (store.database) {
      const usageStatement = store.definitionUsageStatement;
      store.definitionUsageStatement = { all() { throw new Error("search must not load usage edges"); } };
      assert.equal(store.searchDefinitions("risk").length, 1);
      store.definitionUsageStatement = usageStatement;
    }
    const comparison = store.compareDefinitions(" ‘RISK’ ");
    assert.equal(comparison.occurrences.length, 3);
    assert.equal(comparison.wordings.length, 2);
    assert.equal(comparison.importCount, 1);
    assert.equal(comparison.usageEdges.length, 1);
    assert.equal(comparison.occurrences[0].law.title, "NIS 2 Directive");
    store.close();
  }
});

test("definition methods distinguish an unavailable optional index", () => {
  const store = new JsonLegalCacheStore(fixturePath, {
    preferJson: true,
    definitionsPath: path.join(os.tmpdir(), `missing-definitions-${process.pid}.json`),
  });
  assert.equal(store.load(), true);
  assert.equal(store.getDefinitionsStatus().ready, false);
  assert.throws(() => store.searchDefinitions("risk"), { code: "definition_index_unavailable" });
});

test("legal cache store searchLaws keeps a title match ahead of an excerpt-only match for the same term", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-store-excerpt-boost-"));
  const tempPath = path.join(tempDir, "excerpt-boost.json");
  fs.writeFileSync(tempPath, JSON.stringify({
    generatedAt: "2026-03-28T00:00:00.000Z",
    count: 2,
    records: [
      {
        celex: "32024R9003",
        title: "Regulation (EU) 2024/9003 on producer obligations",
        type: "regulation",
        date: "2024-01-01",
        eli: "http://data.europa.eu/eli/reg/2024/9003/oj",
        fmxAvailable: true,
        fmxUnavailable: false,
        // "widgets" only appears deep in body text here, never in the title.
        excerpt: "This Regulation applies to producers of widgets and related components placed on the market.",
      },
      {
        celex: "32024R9004",
        title: "Widgets Regulation",
        type: "regulation",
        date: "2024-01-02",
        eli: "http://data.europa.eu/eli/reg/2024/9004/oj",
        fmxAvailable: true,
        fmxUnavailable: false,
        excerpt: "",
      },
    ],
  }, null, 2));

  const store = new JsonLegalCacheStore(tempPath);
  store.load();

  const results = store.searchLaws("widgets", { limit: 5 });
  const celexes = results.map((entry) => entry.celex);
  assert.ok(celexes.includes("32024R9003"));
  assert.ok(celexes.includes("32024R9004"));
  assert.ok(
    celexes.indexOf("32024R9004") < celexes.indexOf("32024R9003"),
    `title match should outrank excerpt-only match, got: ${celexes.join(", ")}`
  );
});

test("JSON and SQLite both preserve ambiguous lookups", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-store-"));
  const tempPath = path.join(tempDir, "ambiguous.json");
  const caseLawPath = path.join(tempDir, "case-law.json");
  const sqlitePath = path.join(tempDir, "ambiguous.sqlite");
  fs.writeFileSync(tempPath, JSON.stringify({
    generatedAt: "2026-03-28T00:00:00.000Z",
    count: 2,
    records: [
      {
        celex: "32020R0123",
        title: "Regulation (EU) 2020/123",
        type: "regulation",
        date: "2020-01-01",
        eli: "http://data.europa.eu/eli/reg/2020/123/oj",
        fmxAvailable: true,
        fmxUnavailable: false,
      },
      {
        celex: "32020R0123",
        title: "Regulation (EU) 2020/123 duplicate",
        type: "regulation",
        date: "2020-01-02",
        eli: "http://data.europa.eu/eli/reg/2020/123/oj",
        fmxAvailable: true,
        fmxUnavailable: false,
      },
    ],
  }, null, 2));
  fs.writeFileSync(caseLawPath, "{}", "utf8");
  buildSqliteData({ searchCachePath: tempPath, caseLawCachePath: caseLawPath, outputPath: sqlitePath });

  const stores = [
    new JsonLegalCacheStore(tempPath, { preferJson: true }),
    new JsonLegalCacheStore(tempPath, { sqlitePath, requireSqlite: true }),
  ];
  for (const store of stores) {
    store.load();
    assert.equal(store.getByOfficialReference({
      actType: "regulation",
      year: "2020",
      number: "123",
    }), null);
    assert.equal(store.getByEli("http://data.europa.eu/eli/reg/2020/123/oj"), null);
    store.close();
  }
});

test("containedAliasKeys yields contiguous multi-word phrases, longest first", () => {
  const keys = containedAliasKeys("digital services act obligations");

  // Both the spaced and compact form of each sub-phrase are produced so a query
  // can hit either alias variant stored in byAlias.
  assert.ok(keys.includes("digital services act"));
  assert.ok(keys.includes("digitalservicesact"));

  // Longest sub-phrases come first so a more specific alias outranks a shorter
  // one when several are added before the MiniSearch stage.
  assert.equal(keys[0], "digital services act");

  // The full query is handled by the exact-alias lookup, and single words are
  // deliberately excluded to avoid broad, low-precision matches.
  assert.ok(!keys.includes("digital services act obligations"));
  assert.ok(!keys.includes("digital"));
});

test("containedAliasKeys stays bounded and deduplicated", () => {
  // Fewer than three words cannot contain a shorter contiguous sub-phrase, so
  // nothing is generated (the exact-alias path covers the whole query itself).
  assert.deepEqual(containedAliasKeys(""), []);
  assert.deepEqual(containedAliasKeys("oneword"), []);
  assert.deepEqual(containedAliasKeys("two words"), []);

  // Repeated phrases collapse to a single spaced/compact pair.
  assert.deepEqual(containedAliasKeys("act act act"), ["act act", "actact"]);
});

test("searchLaws recovers a known alias embedded in a modifier-heavy query", () => {
  const store = new JsonLegalCacheStore(fixturePath, { preferJson: true });
  assert.equal(store.load(), true);

  // Each query carries an extra modifier token that is absent from the target
  // law's title, so the exact-alias and strict AND paths cannot surface it; the
  // contiguous-alias recovery keeps the known law at rank one.
  const expectations = [
    ["digital services act obligations", "32022R2065"],
    ["digital markets act rules", "32022R1925"],
    ["data governance act scope", "32022R0868"],
  ];
  for (const [query, expectedCelex] of expectations) {
    const results = store.searchLaws(query, { limit: 5 }).map((result) => result.celex);
    assert.equal(results[0], expectedCelex, `${query} should surface ${expectedCelex} first`);
  }
  store.close();
});

// The fixture's JSON records carry no `excerpt` field (see publicRecord /
// search-fixture.json), so a preferJson store here has no SQLite excerpt
// source at all — the fulltext.sqlite artifact is the only place the chosen
// nonsense term can live, isolating what the fulltext RRF source
// contributes.
const FULLTEXT_PROBE_TERM = "zorblatt phosphorescent widget calibration";
const FULLTEXT_PROBE_CELEX = "32022R0868"; // Data Governance Act — absent from that term in title/eurovoc/excerpt.

test("searchFulltextUnits searches body text only, joins titles, and returns marker ranges", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-store-fulltext-units-"));
  const fulltextPath = path.join(tempDir, "fulltext.sqlite");
  buildTestFulltextDb(fulltextPath, {
    [FULLTEXT_PROBE_CELEX]: [
      { unit_type: "article", number: "5", heading: "Heading-only marker", text: "The data governance authority shall act." },
    ],
  });
  const store = new JsonLegalCacheStore(fixturePath, { preferJson: true, fulltextPath });
  assert.equal(store.load(), true);

  const results = store.searchFulltextUnits("data govern", { limit: 50 });
  assert.equal(results.length, 1);
  assert.equal(results[0].celex, FULLTEXT_PROBE_CELEX);
  assert.match(results[0].title, /Data Governance Act/);
  assert.equal(results[0].unitType, "article");
  assert.equal(results[0].number, "5");
  assert.equal(results[0].snippet.includes("\u0002"), false);
  assert.equal(results[0].snippet.includes("\u0003"), false);
  const highlighted = results[0].highlightRanges.map(({ start, end }) => results[0].snippet.slice(start, end));
  assert.equal(highlighted.length > 0, true);
  assert.match(highlighted.join(" "), /data.*governance/);
  assert.equal(store.searchFulltextUnits("data authority").length, 1, "unquoted terms use independent strict-AND prefixes");
  assert.deepEqual(store.searchFulltextUnits("marker"), [], "heading terms must not match body-text search");

  assert.deepEqual(store.searchFulltextUnits("OR"), [], "quoted FTS operator words are searched literally");
  assert.throws(() => store.searchFulltextUnits("***"), (error) => error.code === "fulltext_query_empty");
  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("searchFulltextUnits preserves phrases, prefixes, strict AND, and global act diversification", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-store-fulltext-diversify-"));
  const fulltextPath = path.join(tempDir, "fulltext.sqlite");
  buildTestFulltextDb(fulltextPath, {
    [FULLTEXT_PROBE_CELEX]: [
      { unit_type: "article", number: "1", text: "data altruism organisation applies." },
      { unit_type: "article", number: "2", text: "data altruism organisation continues." },
    ],
    "32024R1689": [
      { unit_type: "recital", number: "14", text: "data altruism organisation and governance." },
    ],
    "32016R0679": [
      { unit_type: "article", number: "1", text: "data protection authority." },
    ],
  });
  const store = new JsonLegalCacheStore(fixturePath, { preferJson: true, fulltextPath });
  assert.equal(store.load(), true);

  const phrase = store.searchFulltextUnits('"data altruism" organisation', { limit: 50 });
  assert.deepEqual(phrase.map((result) => result.celex), [FULLTEXT_PROBE_CELEX, "32024R1689"]);
  assert.equal(store.searchFulltextUnits("data altruism absent", { limit: 50 }).length, 0, "public fulltext search is strict AND");
  assert.equal(store.searchFulltextUnits("data", { celex: FULLTEXT_PROBE_CELEX, limit: 50 }).length, 2, "scoped search returns multiple units from the act");
  assert.equal(new Set(store.searchFulltextUnits("data", { limit: 50 }).map((result) => result.celex)).size, store.searchFulltextUnits("data", { limit: 50 }).length, "global search returns one best unit per act");

  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("global fulltext diversification happens before the bounded result window", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-store-fulltext-window-"));
  const fulltextPath = path.join(tempDir, "fulltext.sqlite");
  buildTestFulltextDb(fulltextPath, {
    [FULLTEXT_PROBE_CELEX]: Array.from({ length: 500 }, (_, index) => ({
      unit_type: "article",
      number: String(index + 1),
      text: "windowprobe common wording.",
    })),
    "32024R1689": [
      { unit_type: "article", number: "1", text: "windowprobe common wording." },
    ],
  });
  const store = new JsonLegalCacheStore(fixturePath, { preferJson: true, fulltextPath });
  assert.equal(store.load(), true);

  assert.deepEqual(
    new Set(store.searchFulltextUnits("windowprobe", { limit: 50 }).map((result) => result.celex)),
    new Set([FULLTEXT_PROBE_CELEX, "32024R1689"])
  );

  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("collection fulltext search filters in SQLite before ranking and returns one unit per CELEX", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-store-fulltext-collection-"));
  const fulltextPath = path.join(tempDir, "fulltext.sqlite");
  const crowdedCelex = "32022R0868";
  const requestedCelex = "32024R1689";
  const otherRequestedCelex = "32016R0679";
  buildTestFulltextDb(fulltextPath, {
    [crowdedCelex]: Array.from({ length: 500 }, (_, index) => ({
      unit_type: "article",
      number: String(index + 1),
      text: "collectionprobe common wording.",
    })),
    [requestedCelex]: [
      { unit_type: "article", number: "1", text: "collectionprobe requested wording." },
      { unit_type: "article", number: "2", text: "collectionprobe requested wording continues." },
    ],
    [otherRequestedCelex]: [
      { unit_type: "recital", number: "4", text: "collectionprobe other requested wording." },
    ],
  });
  const store = new JsonLegalCacheStore(fixturePath, { preferJson: true, fulltextPath });
  assert.equal(store.load(), true);

  const results = store.searchFulltextUnits("collectionprobe", {
    limit: 50,
    celexes: [requestedCelex, requestedCelex.toLowerCase(), otherRequestedCelex],
  });
  assert.deepEqual(new Set(results.map((result) => result.celex)), new Set([requestedCelex, otherRequestedCelex]));
  assert.equal(results.length, 2);
  assert.equal(new Set(results.map((result) => result.celex)).size, results.length);
  assert.equal(store.searchFulltextUnits("collectionprobe", { limit: 1, celexes: [requestedCelex, otherRequestedCelex] }).length, 1);
  assert.throws(
    () => store.searchFulltextUnits("collectionprobe", { celex: requestedCelex, celexes: [otherRequestedCelex] }),
    (error) => error.code === "fulltext_scope_ambiguous",
  );

  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("collection fulltext search ranks only the requested CELEX values", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-store-fulltext-collection-ranking-"));
  const fulltextPath = path.join(tempDir, "fulltext.sqlite");
  const strongerCelex = "32024R1689";
  const weakerCelex = "32016R0679";
  buildTestFulltextDb(fulltextPath, {
    [weakerCelex]: [
      { unit_type: "article", number: "1", text: "collectionrankingprobe." },
    ],
    [strongerCelex]: [
      { unit_type: "article", number: "1", text: `${"collectionrankingprobe ".repeat(20)}.` },
    ],
  });
  const store = new JsonLegalCacheStore(fixturePath, { preferJson: true, fulltextPath });
  assert.equal(store.load(), true);

  const results = store.searchFulltextUnits("collectionrankingprobe", {
    limit: 50,
    celexes: [weakerCelex, strongerCelex],
  });
  assert.deepEqual(results.map((result) => result.celex), [strongerCelex, weakerCelex]);

  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("searchFulltextUnits reports an unavailable artifact with a stable code", () => {
  const store = new JsonLegalCacheStore(fixturePath, { preferJson: true, fulltextPath: path.join(os.tmpdir(), `missing-fulltext-${Date.now()}.sqlite`) });
  assert.equal(store.load(), true);
  assert.deepEqual(store.getFulltextStatus(), store.getStatus().fulltext);
  assert.throws(() => store.requireFulltext(), (error) => error.code === "fulltext_index_unavailable");
  assert.throws(() => store.searchFulltextUnits("data"), (error) => error.code === "fulltext_index_unavailable");
  store.close();
});

test("fulltext source: a term present only in indexed body text surfaces its act via RRF fusion", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-store-fulltext-"));
  const fulltextPath = path.join(tempDir, "fulltext.sqlite");
  buildTestFulltextDb(fulltextPath, {
    [FULLTEXT_PROBE_CELEX]: [
      { unit_type: "article", number: "5", heading: "headingonlyquasar", text: `The competent authority shall assess ${FULLTEXT_PROBE_TERM} before granting access.` },
    ],
  });

  const baseline = new JsonLegalCacheStore(fixturePath, { preferJson: true, fulltextPath: path.join(tempDir, "missing.sqlite") });
  assert.equal(baseline.load(), true);
  const baselineResults = baseline.searchLaws(FULLTEXT_PROBE_TERM, { limit: 5 }).map((r) => r.celex);
  assert.equal(baselineResults.includes(FULLTEXT_PROBE_CELEX), false, "the probe term must not already surface the target act without fulltext");

  const store = new JsonLegalCacheStore(fixturePath, {
    preferJson: true,
    fulltextPath,
    // Keep this test as an explicit wiring check now that production fusion
    // defaults to zero pending a better real-data instrument.
    rankingConfig: { sourceWeights: { fulltext: 0.4 } },
  });
  assert.equal(store.load(), true);
  assert.equal(store.getStatus().fulltext.available, true);
  assert.equal(store.getStatus().fulltext.unitCount, 1);
  assert.equal(store.getStatus().fulltext.actCount, 1);

  const results = store.searchLaws(FULLTEXT_PROBE_TERM, { limit: 5 }).map((r) => r.celex);
  assert.equal(results[0], FULLTEXT_PROBE_CELEX);
  assert.equal(
    store.searchLaws("headingonlyquasar", { limit: 5 }).some((result) => result.celex === FULLTEXT_PROBE_CELEX),
    false,
    "positive-weight fusion must search body text, not headings"
  );

  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("fulltext fusion is disabled by default while explicit positive weights remain usable", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-store-fulltext-default-"));
  const fulltextPath = path.join(tempDir, "fulltext.sqlite");
  buildTestFulltextDb(fulltextPath, {
    [FULLTEXT_PROBE_CELEX]: [
      { unit_type: "article", number: "5", text: `Provisions on ${FULLTEXT_PROBE_TERM}.` },
    ],
  });
  const store = new JsonLegalCacheStore(fixturePath, { preferJson: true, fulltextPath });
  assert.equal(store.load(), true);
  store.searchFulltext = () => {
    throw new Error("weight-zero fulltext source must not be queried");
  };
  let diagnostics = null;
  const results = store.searchLaws(FULLTEXT_PROBE_TERM, { limit: 10, onDiagnostics: (value) => { diagnostics = value; } });
  assert.equal(store.rankingConfig.sourceWeights.fulltext, 0);
  assert.equal(results.some((result) => result.celex === FULLTEXT_PROBE_CELEX), false);
  assert.deepEqual(diagnostics.sources.fulltext, []);
  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("fulltext source: an absent artifact is a true no-op (identical results, no throw)", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-store-fulltext-absent-"));
  const missingPath = path.join(tempDir, "does-not-exist.sqlite");

  // Both control stores point at distinct nonexistent paths so fulltext is
  // unavailable for both regardless of what sits at the default path. (An
  // unset fulltextPath resolves through `|| DEFAULT_FULLTEXT_SQLITE_PATH`, so a
  // real fulltext.sqlite present on a dev machine — e.g. after a local build —
  // would otherwise make "unset" diverge from "absent".)
  const otherMissingPath = path.join(tempDir, "also-does-not-exist.sqlite");
  const withMissingPath = new JsonLegalCacheStore(fixturePath, { preferJson: true, fulltextPath: missingPath });
  const withOtherMissingPath = new JsonLegalCacheStore(fixturePath, { preferJson: true, fulltextPath: otherMissingPath });
  assert.equal(withMissingPath.load(), true);
  assert.equal(withOtherMissingPath.load(), true);

  assert.equal(withMissingPath.getStatus().fulltext.available, false);
  assert.match(withMissingPath.getStatus().fulltext.reason, /not found/i);
  assert.equal(withOtherMissingPath.getStatus().fulltext.available, false);

  const queries = ["digital services act obligations", "personal data protection", FULLTEXT_PROBE_TERM, "regulation"];
  for (const query of queries) {
    const a = withMissingPath.searchLaws(query, { limit: 10 }).map((r) => r.celex);
    const b = withOtherMissingPath.searchLaws(query, { limit: 10 }).map((r) => r.celex);
    assert.deepEqual(a, b, `results for "${query}" must be identical for two stores that both have fulltext unavailable`);
  }

  withMissingPath.close();
  withOtherMissingPath.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("fulltext source: a PRAGMA user_version mismatch is non-fatal and leaves results unchanged", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-store-fulltext-stale-"));
  const fulltextPath = path.join(tempDir, "fulltext.sqlite");
  buildTestFulltextDb(fulltextPath, {
    [FULLTEXT_PROBE_CELEX]: [
      { unit_type: "article", number: "5", heading: "", text: `Provisions on ${FULLTEXT_PROBE_TERM}.` },
    ],
  }, { version: FULLTEXT_SCHEMA_VERSION + 1 });

  const store = new JsonLegalCacheStore(fixturePath, { preferJson: true, fulltextPath });
  assert.equal(store.load(), true);
  assert.equal(store.getStatus().fulltext.available, false);
  assert.match(store.getStatus().fulltext.reason, /schema/i);

  const withNoArtifact = new JsonLegalCacheStore(fixturePath, { preferJson: true, fulltextPath: path.join(tempDir, "missing.sqlite") });
  withNoArtifact.load();

  const queries = [FULLTEXT_PROBE_TERM, "digital markets act rules", "regulation"];
  for (const query of queries) {
    assert.deepEqual(
      store.searchLaws(query, { limit: 10 }).map((r) => r.celex),
      withNoArtifact.searchLaws(query, { limit: 10 }).map((r) => r.celex),
      `results for "${query}" must be unaffected by a schema-mismatched fulltext artifact`
    );
  }

  store.close();
  withNoArtifact.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("fulltext source: sourceWeights.fulltext = 0 excludes a fulltext-only candidate entirely (no zero-score padding)", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-store-fulltext-weight0-"));
  const fulltextPath = path.join(tempDir, "fulltext.sqlite");
  buildTestFulltextDb(fulltextPath, {
    [FULLTEXT_PROBE_CELEX]: [
      { unit_type: "article", number: "5", heading: "", text: `Provisions on ${FULLTEXT_PROBE_TERM}.` },
    ],
  });

  const store = new JsonLegalCacheStore(fixturePath, {
    preferJson: true,
    fulltextPath,
    rankingConfig: { sourceWeights: { fulltext: 0 } },
  });
  assert.equal(store.load(), true);
  assert.equal(store.getStatus().fulltext.available, true, "the artifact is loaded — only its RRF weight is zeroed");

  let diagnostics = null;
  store.searchLaws(FULLTEXT_PROBE_TERM, { limit: 10, onDiagnostics: (d) => { diagnostics = d; } });
  const fulltextOnly = diagnostics.ranked.find((candidate) => candidate.celex === FULLTEXT_PROBE_CELEX);
  assert.equal(fulltextOnly, undefined, "a weight-0 source must contribute no candidates at all, not even a zero-scored one");
  assert.deepEqual(diagnostics.sources.fulltext, [], "a weight-0 source must not even be queried into sourceIds");

  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ABLATION CONTRACT: addCandidates() guards on sourceWeights[source] > 0
// before adding any candidates, so a weight-0 source contributes nothing —
// not even a zero-scored, source-padding candidate. That means weight 0 on a
// source is byte-identical to that source's artifact being entirely absent:
//   - the plan's ablation contract ("final ranked results are byte-identical
//     to the fulltext-absent baseline")
//   - eval/compare-ranking.js's own comment on --fulltext-weight 0
//     ("control/ablation, disabling the fulltext source entirely")
// Repro: build a fulltext.sqlite with one unit for CELEX 32022R0868 whose
// text contains a term absent from every other source. With
// rankingConfig.sourceWeights.fulltext = 0 and limit 10, a query for that
// term must NOT return 32022R0868 at all — a store with no fulltextPath at
// all for the same query returns only the 2 non-fulltext matches, and so
// must the weight-0 store. This matters most for sparse-result queries
// (fewer natural matches than `limit`); dense queries were never at risk
// because zero-score candidates sort last and get truncated away regardless.
test("weight 0 fully excludes fulltext-only candidates from sparse-result sets", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-store-fulltext-weight0-bug-"));
  const fulltextPath = path.join(tempDir, "fulltext.sqlite");
  buildTestFulltextDb(fulltextPath, {
    [FULLTEXT_PROBE_CELEX]: [
      { unit_type: "article", number: "5", heading: "", text: `Provisions on ${FULLTEXT_PROBE_TERM}.` },
    ],
  });

  const withFulltextZeroWeight = new JsonLegalCacheStore(fixturePath, {
    preferJson: true,
    fulltextPath,
    rankingConfig: { sourceWeights: { fulltext: 0 } },
  });
  const withoutFulltextArtifact = new JsonLegalCacheStore(fixturePath, {
    preferJson: true,
    fulltextPath: path.join(tempDir, "missing.sqlite"),
  });
  withFulltextZeroWeight.load();
  withoutFulltextArtifact.load();

  const zeroResults = withFulltextZeroWeight.searchLaws(FULLTEXT_PROBE_TERM, { limit: 10 }).map((r) => r.celex);
  const absentResults = withoutFulltextArtifact.searchLaws(FULLTEXT_PROBE_TERM, { limit: 10 }).map((r) => r.celex);
  assert.deepEqual(zeroResults, absentResults, "weight-0 fulltext should be byte-identical to no fulltext artifact at all");

  withFulltextZeroWeight.close();
  withoutFulltextArtifact.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("fulltext source: FTS metacharacters in the query never throw or break the statement", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-store-fulltext-fts-safety-"));
  const fulltextPath = path.join(tempDir, "fulltext.sqlite");
  buildTestFulltextDb(fulltextPath, {
    [FULLTEXT_PROBE_CELEX]: [
      { unit_type: "article", number: "1", heading: "", text: "Ordinary operative text about data governance." },
    ],
  });

  const store = new JsonLegalCacheStore(fixturePath, { preferJson: true, fulltextPath });
  assert.equal(store.load(), true);
  assert.equal(store.getStatus().fulltext.available, true);

  // buildFtsExpression already strips anything that isn't ^[a-z0-9]+$ per
  // term before quoting it into `"term"*`, so none of these should ever
  // reach SQLite as raw FTS5 syntax; assert the guarantee holds end to end.
  const adversarialQueries = [
    'data "governance* OR (widgets NEAR/3 act)',
    '"; DROP TABLE units; --',
    "**** OR OR OR",
    "data) governance (act",
    'NEAR("data" "governance", 2)',
  ];
  for (const query of adversarialQueries) {
    assert.doesNotThrow(() => store.searchLaws(query, { limit: 5 }), `"${query}" must not throw`);
  }

  store.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// --- not yet in force -------------------------------------------------------
//
// `inForce: false` means "not in force on the day Cellar was asked" and nothing
// more. Acts are harvested when published, normally before entry into force, so
// a brand-new regulation reads `false` for its first weeks. Until entryIntoForce
// was fetched there was no way to tell that from an act that expired in 1994 —
// and both the label and the ranking prior treated it as the latter.

test("isNotYetInForce separates an upcoming act from an expired one", () => {
  const today = "2026-08-21";
  // 32026R1818 as Cellar actually answers it: in-force 0, entry 2026-08-30.
  assert.equal(isNotYetInForce({ inForce: false, entryIntoForce: "2026-08-30" }, today), true);
  // 31970R0729: entered into force in 1970, ran out in 1999.
  assert.equal(isNotYetInForce({ inForce: false, entryIntoForce: "1970-05-18" }, today), false);
  // Today is not "yet to come".
  assert.equal(isNotYetInForce({ inForce: false, entryIntoForce: today }, today), false);
  // Records predating the field, and acts Cellar has no entry date for.
  assert.equal(isNotYetInForce({ inForce: false }, today), false);
  assert.equal(isNotYetInForce({ inForce: false, entryIntoForce: null }, today), false);
  // A live act is never "not yet".
  assert.equal(isNotYetInForce({ inForce: true, entryIntoForce: "2026-08-30" }, today), false);
  assert.equal(isNotYetInForce(undefined, today), false);
});

test("an act that has not entered into force yet is not demoted as expired", () => {
  const parsed = { originalQuery: "regulation on packaging", terms: ["packaging"] };
  const counts = new Map();
  const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

  const upcoming = documentPrior(parsed, { celex: "32026R1818", type: "regulation", inForce: false, entryIntoForce: future }, counts);
  const expired = documentPrior(parsed, { celex: "31970R0729", type: "regulation", inForce: false, entryIntoForce: "1970-05-18" }, counts);
  const live = documentPrior(parsed, { celex: "32016R0679", type: "regulation", inForce: true, entryIntoForce: "2016-05-24" }, counts);

  assert.ok(upcoming > expired, "an upcoming act must not rank below an expired one");
  assert.ok(upcoming < live, "nor above one already in force — this fixes a penalty, it does not add a boost");
});

test("entryIntoForce survives the SQLite whitelist and reaches search results", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-store-entry-"));
  const cachePath = path.join(tempDir, "search-cache.json");
  const caseLawPath = path.join(tempDir, "case-law.json");
  const sqlitePath = path.join(tempDir, "data.sqlite");
  const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

  const record = {
    celex: "32026R1818",
    title: "Regulation (EU) 2026/1818 of the European Parliament and of the Council on packaging",
    type: "regulation",
    date: "2026-06-17",
    // Required: isPrimaryAct is derived from the ELI, and a record without one
    // is filtered out of the store entirely.
    eli: "http://data.europa.eu/eli/reg/2026/1818/oj",
    fmxAvailable: true,
    eurovoc: ["packaging"],
    inForce: false,
    endOfValidity: null,
    entryIntoForce: future,
  };
  fs.writeFileSync(cachePath, JSON.stringify({ count: 1, records: [record] }), "utf8");
  fs.writeFileSync(caseLawPath, "{}", "utf8");
  buildSqliteData({ searchCachePath: cachePath, caseLawCachePath: caseLawPath, outputPath: sqlitePath });

  // Both backends, because compactSqliteRecord is an explicit whitelist: a
  // field missing from it flows fine through the JSON dev path and vanishes in
  // production, which loads from SQLite.
  for (const store of [
    new JsonLegalCacheStore(cachePath, { preferJson: true }),
    new JsonLegalCacheStore(cachePath, { sqlitePath, requireSqlite: true }),
  ]) {
    assert.equal(store.load(), true);
    const hit = store.searchLaws("packaging", { limit: 5 }).find((law) => law.celex === "32026R1818");
    assert.ok(hit, `expected a hit from the ${store.source} backend`);
    assert.equal(hit.inForce, false);
    assert.equal(hit.entryIntoForce, future, `entryIntoForce lost by the ${store.source} backend`);
    store.close?.();
  }
});
