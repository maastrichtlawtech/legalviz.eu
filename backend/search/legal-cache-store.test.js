const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  JsonLegalCacheStore,
} = require("./legal-cache-store");

const fixturePath = path.join(__dirname, "__fixtures__", "search-fixture.json");
const eurovocFixturePath = path.join(__dirname, "__fixtures__", "eurovoc-fixture.json");

test("legal cache store loads fixture successfully", () => {
  const store = new JsonLegalCacheStore(fixturePath);
  assert.equal(store.load(), true);
  assert.equal(store.getStatus().ready, true);
  assert.equal(store.getStatus().count, 18);
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

test("legal cache store attaches EuroVoc topics from the sidecar", () => {
  const store = new JsonLegalCacheStore(fixturePath, eurovocFixturePath);
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

test("legal cache store caps searchLaws topics at 5 and defaults to empty array without a sidecar entry", () => {
  const store = new JsonLegalCacheStore(fixturePath, eurovocFixturePath);
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

test("legal cache store degrades gracefully when the EuroVoc sidecar is missing", () => {
  const missingEurovocPath = path.join(os.tmpdir(), `missing-eurovoc-${Date.now()}.json`);
  const store = new JsonLegalCacheStore(fixturePath, missingEurovocPath);

  assert.equal(store.load(), true);
  assert.equal(store.getStatus().ready, true);

  const [gdpr] = store.searchLaws("32016R0679", { limit: 1 });
  assert.deepEqual(gdpr.topics, []);
});

test("legal cache store backfills missing dates from the sidecar without overriding existing ones", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-store-dates-"));
  const cachePath = path.join(tempDir, "cache.json");
  const datesPath = path.join(tempDir, "dates.json");
  // Keep the test hermetic: point EuroVoc at a missing path so it can't fall
  // back to the large committed sidecar, which is irrelevant to date backfill.
  const noEurovocPath = path.join(tempDir, "no-eurovoc.json");
  fs.writeFileSync(cachePath, JSON.stringify({
    records: [
      {
        celex: "31968R0260",
        title: "Regulation (EEC) 260/68 on old widgets",
        type: "regulation",
        date: null,
        eli: "http://data.europa.eu/eli/reg/1968/260/oj",
        fmxAvailable: true,
      },
      {
        celex: "32020R0123",
        title: "Regulation (EU) 2020/123 on new widgets",
        type: "regulation",
        date: "2020-01-01",
        eli: "http://data.europa.eu/eli/reg/2020/123/oj",
        fmxAvailable: true,
      },
    ],
  }));
  // Sidecar has a date for the date-less record, and a (stale) one for the
  // record that already carries a date — the latter must not win.
  fs.writeFileSync(datesPath, JSON.stringify({
    "31968R0260": "1968-02-29",
    "32020R0123": "1999-12-31",
  }));

  const store = new JsonLegalCacheStore(cachePath, noEurovocPath, datesPath);
  assert.equal(store.load(), true);

  assert.equal(store.getByCelex("31968R0260")?.date, "1968-02-29");
  assert.equal(store.getByCelex("32020R0123")?.date, "2020-01-01");

  const [old] = store.searchLaws("31968R0260", { limit: 1 });
  assert.equal(old.date, "1968-02-29");
});

test("legal cache store leaves dates untouched when the sidecar is missing or has a null entry", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-store-dates-missing-"));
  const cachePath = path.join(tempDir, "cache.json");
  const datesPath = path.join(tempDir, "dates.json");
  const noEurovocPath = path.join(tempDir, "no-eurovoc.json");
  fs.writeFileSync(cachePath, JSON.stringify({
    records: [
      {
        celex: "31968R0260",
        title: "Regulation (EEC) 260/68 on old widgets",
        type: "regulation",
        date: null,
        eli: "http://data.europa.eu/eli/reg/1968/260/oj",
        fmxAvailable: true,
      },
    ],
  }));
  // A null sidecar entry (endpoint had no date) must not throw or fabricate one.
  fs.writeFileSync(datesPath, JSON.stringify({ "31968R0260": null }));

  const store = new JsonLegalCacheStore(cachePath, noEurovocPath, datesPath);
  assert.equal(store.load(), true);
  assert.equal(store.getByCelex("31968R0260")?.date, null);

  const missingDatesPath = path.join(os.tmpdir(), `missing-dates-${Date.now()}.json`);
  const store2 = new JsonLegalCacheStore(cachePath, noEurovocPath, missingDatesPath);
  assert.equal(store2.load(), true);
  assert.equal(store2.getByCelex("31968R0260")?.date, null);
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

test("legal cache store returns null for ambiguous official reference key", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legal-cache-store-"));
  const tempPath = path.join(tempDir, "ambiguous.json");
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

  const store = new JsonLegalCacheStore(tempPath);
  store.load();
  assert.equal(store.getByOfficialReference({
    actType: "regulation",
    year: "2020",
    number: "123",
  }), null);
  assert.equal(store.getByEli("http://data.europa.eu/eli/reg/2020/123/oj"), null);
});
