const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  JsonLegalCacheStore,
} = require("./legal-cache-store");
const { buildSqliteData } = require("./build-sqlite-data");

const fixturePath = path.join(__dirname, "__fixtures__", "search-fixture.json");

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
