const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const test = require("node:test");

const { CitationGraphStore } = require("./citation-graph-store");

function writeGraph(payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citation-store-"));
  const graphPath = path.join(dir, "graph.json");
  fs.writeFileSync(graphPath, JSON.stringify(payload));
  return graphPath;
}

const edges = [
  { kind: "legislation", sourceCelex: "32024R0001", sourceTitle: "A", sourceUnitType: "article", sourceUnit: "2", targetCelex: "32016R0679", targetArticle: "6", targetParagraph: null, targetPoint: null },
  { kind: "legislation", sourceCelex: "32024R0001", sourceTitle: "A", sourceUnitType: "article", sourceUnit: "2", targetCelex: "32016R0679", targetArticle: "6", targetParagraph: "1", targetPoint: "a" },
  { kind: "legislation", sourceCelex: "32024R0002", sourceTitle: "B", sourceUnitType: "article", sourceUnit: "8", targetCelex: "32016R0679", targetArticle: null, targetParagraph: null, targetPoint: null },
  { kind: "judgment", sourceCelex: "62020CJ0001", sourceTitle: "Case", sourceUnitType: "judgment", sourceUnit: "62020CJ0001", targetCelex: "32016R0679", targetArticle: "6", targetParagraph: "1", targetPoint: null },
];

test("store rejects missing and incompatible artifacts without throwing", () => {
  const missing = new CitationGraphStore("/definitely/missing/citation-graph.json");
  assert.equal(missing.load(), false);
  assert.equal(missing.getStatus().ready, false);
  assert.throws(() => missing.getActCitations("32016R0679"), { code: "citation_graph_unavailable" });

  const incompatible = new CitationGraphStore(writeGraph({ graphVersion: 99, edges: [] }));
  assert.equal(incompatible.load(), false);
  assert.match(incompatible.getStatus().error, /Unsupported citation graph version/);
});

test("store loads the gzipped artifact when the raw file is absent", () => {
  // Fresh deploys ship only citation-graph.json.gz as a Release asset; the raw
  // JSON exists only after a local rebuild and must win when both are present.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citation-store-gz-"));
  const graphPath = path.join(dir, "citation-graph.json");
  fs.writeFileSync(`${graphPath}.gz`, zlib.gzipSync(JSON.stringify({ graphVersion: 1, stats: { edges: 4 }, edges })));

  const store = new CitationGraphStore(graphPath);
  assert.equal(store.load(), true);
  assert.deepEqual(store.getActCitations("32016R0679").totals, { provisions: 2, judgments: 1, total: 3 });

  fs.writeFileSync(graphPath, JSON.stringify({ graphVersion: 1, stats: { edges: 0 }, edges: [] }));
  assert.equal(store.load(), true);
  assert.equal(store.getStatus().edges, 0);
});

test("article queries count distinct sources and paginate the combined result", () => {
  const store = new CitationGraphStore(writeGraph({ graphVersion: 1, parserVersion: 4, stats: { edges: 4 }, edges }));
  assert.equal(store.load(), true);
  const first = store.getArticleCitations("32016r0679", "6", { limit: 1 });
  assert.deepEqual(first.counts, { provisions: 1, judgments: 1, total: 2 });
  assert.equal(first.pagination.hasMore, true);
  assert.equal(first.citingProvisions.length + first.citingJudgments.length, 1);
  assert.equal(first.citingProvisions[0].references.length, 2);
  assert.deepEqual(Object.keys(first.citingProvisions[0]).sort(), ["celex", "references", "title", "unit", "unitType"]);
  const second = store.getArticleCitations("32016R0679", "6", { limit: 1, offset: 1 });
  assert.equal(second.citingProvisions.length + second.citingJudgments.length, 1);
});

test("article query public units remove recital and annex storage prefixes only", () => {
  const sourceEdges = [
    { kind: "legislation", sourceCelex: "32024R0001", sourceTitle: "Article source", sourceUnitType: "article", sourceUnit: "article_2", targetCelex: "32016R0679", targetArticle: "6" },
    { kind: "legislation", sourceCelex: "32024R0002", sourceTitle: "Recital source", sourceUnitType: "recital", sourceUnit: "recital_140", targetCelex: "32016R0679", targetArticle: "6" },
    { kind: "legislation", sourceCelex: "32024R0003", sourceTitle: "Annex source", sourceUnitType: "annex", sourceUnit: "annex_I", targetCelex: "32016R0679", targetArticle: "6" },
    { kind: "legislation", sourceCelex: "32024R0004", sourceTitle: "Malformed source", sourceUnitType: "recital", sourceUnit: "recital_", targetCelex: "32016R0679", targetArticle: "6" },
  ];
  const store = new CitationGraphStore(writeGraph({ graphVersion: 1, edges: sourceEdges }));
  assert.equal(store.load(), true);

  const result = store.getArticleCitations("32016R0679", "6", { limit: 10 });
  assert.deepEqual(result.citingProvisions.map(({ unitType, unit }) => ({ unitType, unit })), [
    { unitType: "article", unit: "article_2" },
    { unitType: "recital", unit: "140" },
    { unitType: "annex", unit: "I" },
    { unitType: "recital", unit: "recital_" },
  ]);
});

test("act query separates act-only references from article references", () => {
  const store = new CitationGraphStore(writeGraph({ graphVersion: 1, edges }));
  store.load();
  assert.deepEqual(store.getActCitations("32016R0679"), {
    celex: "32016R0679",
    actOnly: { provisions: 1, judgments: 0, total: 1 },
    article: { provisions: 1, judgments: 1, total: 2 },
    articles: [{ article: "6", provisions: 1, judgments: 1, total: 2 }],
    totals: { provisions: 2, judgments: 1, total: 3 },
  });
});

test("act query dedups a provision citing both the act and an article across subsets", () => {
  // 32024R0009 unit 3 cites the act generally (act-only) and Article 6. It must
  // count once in actOnly, once in article, but only once in the deduplicated
  // totals — so actOnly.total + article.total (2) intentionally exceeds
  // totals.total (1). This pins the "totals is not the sum of the parts" contract.
  const overlappingEdges = [
    { kind: "legislation", sourceCelex: "32024R0009", sourceTitle: "Dual citer", sourceUnitType: "article", sourceUnit: "3", targetCelex: "32016R0679", targetArticle: null, targetParagraph: null, targetPoint: null },
    { kind: "legislation", sourceCelex: "32024R0009", sourceTitle: "Dual citer", sourceUnitType: "article", sourceUnit: "3", targetCelex: "32016R0679", targetArticle: "6", targetParagraph: null, targetPoint: null },
  ];
  const store = new CitationGraphStore(writeGraph({ graphVersion: 1, edges: overlappingEdges }));
  assert.equal(store.load(), true);
  const result = store.getActCitations("32016R0679");
  assert.deepEqual(result.actOnly, { provisions: 1, judgments: 0, total: 1 });
  assert.deepEqual(result.article, { provisions: 1, judgments: 0, total: 1 });
  assert.deepEqual(result.totals, { provisions: 1, judgments: 0, total: 1 });
  assert.ok(result.actOnly.total + result.article.total > result.totals.total);
});
