const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createHtmlCacheService } = require("./html-cache-service");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "html-cache-test-"));
}

const SAMPLE_HTML = `<!DOCTYPE html><html lang="en"><head>
<meta name="WT.z_docTitle" content="Test Law"></head>
<body><div class="eli-subdivision" id="rct_1">
<table><tr><td>(1)</td><td>Recital text</td></tr></table></div>
<p class="oj-ti-art">Article 1</p></body></html>`;

test("get returns null for uncached entry", async () => {
  const dir = makeTempDir();
  const cache = createHtmlCacheService({ CACHE_DIR: dir, STORAGE_LIMIT_MB: 10 });
  const result = await cache.get("32016R0679", "ENG");
  assert.equal(result, null);
});

test("put then get round-trips raw HTML", async () => {
  const dir = makeTempDir();
  const cache = createHtmlCacheService({ CACHE_DIR: dir, STORAGE_LIMIT_MB: 10 });

  await cache.put("32016R0679", "ENG", SAMPLE_HTML);
  const cached = await cache.get("32016R0679", "ENG");

  assert.equal(cached, SAMPLE_HTML);
});

test("cached file uses .html.gz extension", async () => {
  const dir = makeTempDir();
  const cache = createHtmlCacheService({ CACHE_DIR: dir, STORAGE_LIMIT_MB: 10 });

  await cache.put("32016R0679", "ENG", SAMPLE_HTML);
  const files = fs.readdirSync(dir);
  assert.ok(files.includes("32016R0679_ENG.html.gz"), `expected .html.gz file, got: ${files}`);
});

test("get updates mtime for LRU tracking", async () => {
  const dir = makeTempDir();
  const cache = createHtmlCacheService({ CACHE_DIR: dir, STORAGE_LIMIT_MB: 10 });

  await cache.put("32016R0679", "ENG", SAMPLE_HTML);

  const filePath = path.join(dir, "32016R0679_ENG.html.gz");
  const pastDate = new Date(Date.now() - 60_000);
  fs.utimesSync(filePath, pastDate, pastDate);
  const mtimeBefore = fs.statSync(filePath).mtime;

  await cache.get("32016R0679", "ENG");
  const mtimeAfter = fs.statSync(filePath).mtime;

  assert.ok(mtimeAfter > mtimeBefore, "mtime should be updated on cache hit");
});

test("get returns HTML when the LRU touch fails", async () => {
  const dir = makeTempDir();
  const cache = createHtmlCacheService({ CACHE_DIR: dir, STORAGE_LIMIT_MB: 10 });

  await cache.put("32016R0679", "ENG", SAMPLE_HTML);

  const originalUtimes = fs.promises.utimes;
  fs.promises.utimes = async () => {
    throw new Error("simulated LRU touch failure");
  };
  try {
    assert.equal(await cache.get("32016R0679", "ENG"), SAMPLE_HTML);
  } finally {
    fs.promises.utimes = originalUtimes;
  }
});

test("evictOldestIfNeeded removes oldest files when over limit", async () => {
  const dir = makeTempDir();
  const cache = createHtmlCacheService({ CACHE_DIR: dir, STORAGE_LIMIT_MB: 0 });

  await cache.put("32016R0679", "ENG", SAMPLE_HTML);
  const firstPath = path.join(dir, "32016R0679_ENG.html.gz");
  const oldDate = new Date(Date.now() - 120_000);
  fs.utimesSync(firstPath, oldDate, oldDate);

  await cache.put("32024R1689", "ENG", "<html>second</html>");

  const firstCached = await cache.get("32016R0679", "ENG");
  assert.equal(firstCached, null, "oldest entry should be evicted");
});

test("does not interfere with non-.html.gz files in the same directory", async () => {
  const dir = makeTempDir();
  const cache = createHtmlCacheService({ CACHE_DIR: dir, STORAGE_LIMIT_MB: 0 });

  // Simulate an FMX file living in the same directory
  fs.writeFileSync(path.join(dir, "32016R0679.xml"), "<xml>fmx data</xml>");

  await cache.put("32016R0679", "ENG", SAMPLE_HTML);
  // Eviction with limit 0 should only touch .html.gz, not .xml
  const xmlStillExists = fs.existsSync(path.join(dir, "32016R0679.xml"));
  assert.ok(xmlStillExists, "FMX .xml file should not be evicted by HTML cache");
});
