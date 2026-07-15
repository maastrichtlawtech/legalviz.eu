const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildSqliteData } = require("./build-sqlite-data");

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

test("buildSqliteData emits a verified manifest with source and table counts", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-data-manifest-"));
  const searchPath = path.join(tempDir, "search.json");
  const caseLawPath = path.join(tempDir, "case-law.json");
  const outputPath = path.join(tempDir, "data.sqlite");
  const manifestPath = path.join(tempDir, "manifest.json");
  fs.writeFileSync(searchPath, JSON.stringify({
    generatedAt: "2026-07-15T00:00:00.000Z",
    records: [
      {
        celex: "32024R9001",
        title: "Widgets Regulation",
        type: "regulation",
        eli: "http://data.europa.eu/eli/reg/2024/9001/oj",
        excerpt: "Harmonised rules for widgets.",
      },
      {
        celex: "32024R9002",
        title: "Gadgets Regulation",
        type: "regulation",
        eli: "http://data.europa.eu/eli/reg/2024/9002/oj",
        excerpt: "",
      },
    ],
  }), "utf8");
  fs.writeFileSync(caseLawPath, JSON.stringify({
    "62020CJ0001": { name: "Example", declarations: [{ text: "Ruling" }] },
    ignored: null,
  }), "utf8");

  const result = buildSqliteData({ searchCachePath: searchPath, caseLawCachePath: caseLawPath, outputPath, manifestPath });
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(result.laws, 2);
  assert.equal(result.excerpts, 1);
  assert.equal(result.caseLaw, 1);
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.tables, {
    laws: 2,
    excerpts: 1,
    excerptMappings: 1,
    caseLaw: 1,
  });
  assert.deepEqual(manifest.integrity, {
    sqlite: "ok",
    orphanLawMappings: 0,
    orphanFtsMappings: 0,
  });
  assert.equal(manifest.source.search.sha256, sha256(searchPath));
  assert.equal(manifest.source.caseLaw.sha256, sha256(caseLawPath));
  assert.equal(manifest.artifact.sha256, sha256(outputPath));
});
