const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  JsonLegalCacheStore,
} = require("./legal-cache-store");

const fixturePath = path.join(__dirname, "__fixtures__", "search-fixture.json");

test("legal cache store loads fixture successfully", () => {
  const store = new JsonLegalCacheStore(fixturePath);
  assert.equal(store.load(), true);
  assert.equal(store.getStatus().ready, true);
  assert.equal(store.getStatus().count, 16);
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
