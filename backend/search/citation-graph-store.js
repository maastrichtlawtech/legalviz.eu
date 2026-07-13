const fs = require("fs");
const path = require("path");
const GRAPH_VERSION = 1;

const DEFAULT_CITATION_GRAPH_PATH = process.env.CITATION_GRAPH_PATH || path.join(__dirname, "data", "citation-graph.json");
const normalize = (value) => String(value == null ? "" : value).trim().toUpperCase();
const sourceKey = (edge) => [edge.kind, edge.sourceCelex, edge.sourceUnitType, edge.sourceUnit].join("|");

function compareCitations(a, b) {
  return String(a.sourceCelex).localeCompare(String(b.sourceCelex), "en", { numeric: true })
    || String(a.sourceUnit).localeCompare(String(b.sourceUnit), "en", { numeric: true });
}

function distinctSources(edges) {
  const grouped = new Map();
  for (const edge of edges) {
    const key = sourceKey(edge);
    let source = grouped.get(key);
    if (!source) {
      source = { ...edge, _references: [] };
      grouped.set(key, source);
    }
    const reference = {
      paragraph: edge.targetParagraph == null ? null : String(edge.targetParagraph),
      point: edge.targetPoint == null ? null : String(edge.targetPoint),
      raw: edge.raw || null,
    };
    const referenceKey = JSON.stringify(reference);
    if (!source._references.some((item) => JSON.stringify(item) === referenceKey)) source._references.push(reference);
  }
  return [...grouped.values()].sort(compareCitations);
}

function publicCitation(edge) {
  const references = edge._references || [{
      paragraph: edge.targetParagraph == null ? null : String(edge.targetParagraph),
      point: edge.targetPoint == null ? null : String(edge.targetPoint),
      raw: edge.raw || null,
    }];
  if (edge.kind === "judgment") {
    return { celex: edge.sourceCelex, name: edge.sourceTitle || null, references };
  }
  return {
    celex: edge.sourceCelex, title: edge.sourceTitle || null,
    unitType: edge.sourceUnitType, unit: edge.sourceUnit, references,
  };
}

function countsFor(edges) {
  const provisions = distinctSources(edges.filter((edge) => edge.kind === "legislation")).length;
  const judgments = distinctSources(edges.filter((edge) => edge.kind === "judgment")).length;
  return { provisions, judgments, total: provisions + judgments };
}

class CitationGraphStore {
  constructor(graphPath = DEFAULT_CITATION_GRAPH_PATH) {
    this.graphPath = graphPath;
    this.payload = null;
    this.loadedAt = null;
    this.loadError = null;
    this.byTargetCelex = new Map();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.graphPath, "utf8"));
      if (parsed?.graphVersion !== GRAPH_VERSION) throw new Error(`Unsupported citation graph version ${parsed?.graphVersion}; expected ${GRAPH_VERSION}`);
      if (!Array.isArray(parsed.edges)) throw new Error("Citation graph edges must be an array");
      this.payload = parsed;
      this.byTargetCelex = new Map();
      for (const edge of parsed.edges) {
        const target = normalize(edge?.targetCelex);
        if (!target) continue;
        const entries = this.byTargetCelex.get(target) || [];
        entries.push(edge);
        this.byTargetCelex.set(target, entries);
      }
      this.loadedAt = new Date().toISOString();
      this.loadError = null;
      return true;
    } catch (error) {
      this.payload = null;
      this.byTargetCelex = new Map();
      this.loadedAt = null;
      this.loadError = error.code === "ENOENT" ? `Citation graph not found at ${this.graphPath}` : error.message;
      return false;
    }
  }

  loadFromDisk() { return this.load(); }
  isReady() { return Boolean(this.payload); }
  getStatus() {
    return {
      ready: this.isReady(), graphPath: this.graphPath,
      graphVersion: this.payload?.graphVersion || null, parserVersion: this.payload?.parserVersion ?? null,
      generatedAt: this.payload?.generatedAt || null, coverage: this.payload?.coverage || null,
      edges: this.payload?.stats?.edges ?? 0, loadedAt: this.loadedAt, error: this.loadError,
    };
  }

  assertReady() {
    if (this.isReady()) return;
    const error = new Error(this.loadError || "Citation graph is not loaded");
    error.code = "citation_graph_unavailable";
    throw error;
  }

  getArticleCitations(celex, article, options = {}) {
    this.assertReady();
    const targetCelex = normalize(celex);
    const targetArticle = String(article == null ? "" : article).trim().toLowerCase();
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 50, 200));
    const offset = Math.max(0, Number.parseInt(options.offset, 10) || 0);
    const matching = (this.byTargetCelex.get(targetCelex) || [])
      .filter((edge) => String(edge.targetArticle == null ? "" : edge.targetArticle).trim().toLowerCase() === targetArticle);
    const provisions = distinctSources(matching.filter((edge) => edge.kind === "legislation"));
    const judgments = distinctSources(matching.filter((edge) => edge.kind === "judgment"));
    const combined = [...provisions.map((edge) => ({ edge, kind: "legislation" })),
      ...judgments.map((edge) => ({ edge, kind: "judgment" }))].sort((a, b) => compareCitations(a.edge, b.edge));
    const page = combined.slice(offset, offset + limit);
    return {
      celex: targetCelex, article: String(article),
      citingProvisions: page.filter((item) => item.kind === "legislation").map((item) => publicCitation(item.edge)),
      citingJudgments: page.filter((item) => item.kind === "judgment").map((item) => publicCitation(item.edge)),
      counts: { provisions: provisions.length, judgments: judgments.length, total: combined.length },
      pagination: { limit, offset, returned: page.length, hasMore: offset + page.length < combined.length },
    };
  }

  getActCitations(celex) {
    this.assertReady();
    const targetCelex = normalize(celex);
    const edges = this.byTargetCelex.get(targetCelex) || [];
    const actOnly = edges.filter((edge) => edge.targetArticle == null || String(edge.targetArticle).trim() === "");
    const article = edges.filter((edge) => edge.targetArticle != null && String(edge.targetArticle).trim() !== "");
    const byArticle = new Map();
    for (const edge of article) {
      const key = String(edge.targetArticle);
      const entries = byArticle.get(key) || [];
      entries.push(edge);
      byArticle.set(key, entries);
    }
    const articles = [...byArticle.entries()]
      .sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))
      .map(([citedArticle, articleEdges]) => ({ article: citedArticle, ...countsFor(articleEdges) }));
    return { celex: targetCelex, actOnly: countsFor(actOnly), article: countsFor(article), articles, totals: countsFor(edges) };
  }
}

module.exports = { CitationGraphStore, DEFAULT_CITATION_GRAPH_PATH, distinctSources };
