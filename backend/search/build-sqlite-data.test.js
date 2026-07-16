const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildSqliteData, SQLITE_SCHEMA_VERSION } = require("./build-sqlite-data");

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

  // citationGraphPath is pinned to a non-existent path: left unset it would default
  // to the real (multi-hundred-MB) data/citation-graph.json in a dev checkout.
  const result = buildSqliteData({
    searchCachePath: searchPath, caseLawCachePath: caseLawPath,
    citationGraphPath: path.join(tempDir, "absent-citation-graph.json"),
    outputPath, manifestPath, log: () => {},
  });
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(result.laws, 2);
  assert.equal(result.excerpts, 1);
  assert.equal(result.caseLaw, 1);
  assert.equal(manifest.schemaVersion, SQLITE_SCHEMA_VERSION);
  assert.deepEqual(manifest.tables, {
    laws: 2,
    excerpts: 1,
    excerptMappings: 1,
    caseLaw: 1,
    citations: 0,
    citationSources: 0,
    definitionTerms: 0,
    definitionOccurrences: 0,
  });
  assert.equal(manifest.source.citationGraph, null);
  assert.equal(manifest.source.definitions, null);
  assert.deepEqual(manifest.integrity, {
    sqlite: "ok",
    orphanLawMappings: 0,
    orphanFtsMappings: 0,
  });
  assert.equal(manifest.source.search.sha256, sha256(searchPath));
  assert.equal(manifest.source.caseLaw.sha256, sha256(caseLawPath));
  assert.equal(manifest.artifact.sha256, sha256(outputPath));
});

test("buildSqliteData optionally folds definitions into searchable tables", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-data-definitions-"));
  const searchPath = path.join(tempDir, "search.json");
  const caseLawPath = path.join(tempDir, "case-law.json");
  const definitionsPath = path.join(tempDir, "definitions.json");
  const outputPath = path.join(tempDir, "data.sqlite");
  const manifestPath = path.join(tempDir, "manifest.json");
  fs.writeFileSync(searchPath, JSON.stringify({ records: [] }), "utf8");
  fs.writeFileSync(caseLawPath, "{}", "utf8");
  fs.writeFileSync(definitionsPath, JSON.stringify({
    generatedAt: "2026-07-16T00:00:00.000Z",
    occurrences: [
      { term: "risk", definition: "the potential for loss", celex: "32022L2555", sourceArticle: "Article 6", definitionHash: "same" },
      { term: "Risk", definition: "the potential for loss", celex: "32022L2557", article: "3", wordingHash: "same" },
    ],
  }), "utf8");

  const result = buildSqliteData({
    searchCachePath: searchPath, caseLawCachePath: caseLawPath,
    citationGraphPath: path.join(tempDir, "absent-graph.json"), definitionsPath,
    outputPath, manifestPath, log: () => {},
  });
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(result.definitionTerms, 1);
  assert.equal(result.definitionOccurrences, 2);
  assert.equal(manifest.source.definitions.terms, 1);
  assert.equal(manifest.source.definitions.occurrences, 2);
  assert.equal(manifest.tables.definitionTerms, 1);
  assert.equal(manifest.tables.definitionOccurrences, 2);
});

test("buildSqliteData folds the citation graph into indexed tables and dedups source titles", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-data-citations-"));
  const searchPath = path.join(tempDir, "search.json");
  const caseLawPath = path.join(tempDir, "case-law.json");
  const graphPath = path.join(tempDir, "citation-graph.json");
  const outputPath = path.join(tempDir, "data.sqlite");
  const manifestPath = path.join(tempDir, "manifest.json");
  fs.writeFileSync(searchPath, JSON.stringify({ generatedAt: "2026-07-15T00:00:00.000Z", records: [] }), "utf8");
  fs.writeFileSync(caseLawPath, JSON.stringify({}), "utf8");
  fs.writeFileSync(graphPath, JSON.stringify({
    graphVersion: 2, parserVersion: 15, generatedAt: "2026-07-15T19:22:07.710Z",
    coverage: { legislation: { htmlLaws: 2 } }, stats: { edges: 3 },
    edges: [
      // two edges from one source: the title must be stored once
      { kind: "legislation", sourceCelex: "32020R0001", sourceTitle: "Widgets", sourceUnitType: "article", sourceUnit: "5", targetCelex: "32016R0679", targetArticle: "6", targetParagraph: "1", targetPoint: null, raw: "Article 6(1)" },
      { kind: "legislation", sourceCelex: "32020R0001", sourceTitle: "Widgets", sourceUnitType: "article", sourceUnit: "6", targetCelex: "32016R0679", targetArticle: null, targetParagraph: null, targetPoint: null, raw: "the GDPR" },
      { kind: "judgment", sourceCelex: "62020CJ0001", sourceTitle: "Some Case", sourceUnitType: "judgment", sourceUnit: "62020CJ0001", targetCelex: "32016R0679", targetArticle: "6", targetParagraph: null, targetPoint: null, raw: "Article 6" },
      { kind: "legislation", sourceCelex: "", sourceTitle: "No source", sourceUnitType: "article", sourceUnit: "1", targetCelex: "32016R0679", targetArticle: "6", targetParagraph: null, targetPoint: null, raw: "dropped" },
    ],
  }), "utf8");

  buildSqliteData({
    searchCachePath: searchPath, caseLawCachePath: caseLawPath, citationGraphPath: graphPath,
    outputPath, manifestPath, log: () => {},
  });
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.tables.citations, 3);        // the endpoint-less edge is dropped
  assert.equal(manifest.tables.citationSources, 2);  // Widgets stored once, not per edge
  assert.equal(manifest.source.citationGraph.edges, 3);
  assert.equal(manifest.source.citationGraph.skippedEdges, 1);
  assert.equal(manifest.source.citationGraph.graphVersion, 2);
});
