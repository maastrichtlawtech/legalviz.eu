const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const GRAPH_VERSION = 2;

const DEFAULT_CITATION_GRAPH_PATH = path.join(__dirname, "data", "citation-graph.json");
const DEFAULT_SQLITE_DATA_PATH = path.join(__dirname, "data", "data.sqlite");
// Keep in lock-step with SQLITE_SCHEMA_VERSION in build-sqlite-data.js / legal-cache-store.js.
const SQLITE_SCHEMA_VERSION = 4;

// Columns are aliased to the edge field names so rows drop straight into the same
// distinctSources/publicCitation helpers the JSON path uses.
const CITATION_SELECT = `
  SELECT citations.kind AS kind,
         citations.source_celex AS sourceCelex,
         citation_sources.title AS sourceTitle,
         citations.source_unit_type AS sourceUnitType,
         citations.source_unit AS sourceUnit,
         citations.target_celex AS targetCelex,
         citations.target_article AS targetArticle,
         citations.target_paragraph AS targetParagraph,
         citations.target_point AS targetPoint,
         citations.raw AS raw
  FROM citations
  LEFT JOIN citation_sources ON citation_sources.celex = citations.source_celex
`;
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
      source = { ...edge, _references: [], _referenceKeys: new Set() };
      grouped.set(key, source);
    }
    const reference = {
      paragraph: edge.targetParagraph == null ? null : String(edge.targetParagraph),
      point: edge.targetPoint == null ? null : String(edge.targetPoint),
      raw: edge.raw || null,
    };
    const referenceKey = `${reference.paragraph ?? ""}|${reference.point ?? ""}|${reference.raw ?? ""}`;
    if (!source._referenceKeys.has(referenceKey)) {
      source._referenceKeys.add(referenceKey);
      source._references.push(reference);
    }
  }
  return [...grouped.values()].sort(compareCitations);
}

function publicSourceUnit(edge) {
  const unit = edge.sourceUnit;
  if (typeof unit !== "string") return unit;
  const unitType = String(edge.sourceUnitType || "").trim().toLowerCase();
  if (unitType !== "recital" && unitType !== "annex") return unit;
  const prefix = `${unitType}_`;
  if (!unit.toLowerCase().startsWith(prefix) || unit.length === prefix.length) return unit;
  return unit.slice(prefix.length);
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
    unitType: edge.sourceUnitType, unit: publicSourceUnit(edge), references,
  };
}

function countsFor(edges) {
  const provisions = distinctSources(edges.filter((edge) => edge.kind === "legislation")).length;
  const judgments = distinctSources(edges.filter((edge) => edge.kind === "judgment")).length;
  return { provisions, judgments, total: provisions + judgments };
}

class CitationGraphStore {
  // Mirrors JsonLegalCacheStore: prefer the SQLite store when one is configured and
  // present, else fall back to the JSON artifact (local rebuilds, tests). The
  // deployed image ships only data.sqlite, so it always takes the SQLite path.
  constructor(graphPath = DEFAULT_CITATION_GRAPH_PATH, options = {}) {
    this.graphPath = graphPath;
    const explicitSqlitePath = options.sqlitePath || null;
    const environmentSqlitePath = options.preferJson ? null : (process.env.DATA_SQLITE_PATH || null);
    const configuredSqlitePath = explicitSqlitePath || environmentSqlitePath;
    const hasJsonOverride = Boolean(process.env.CITATION_GRAPH_PATH);
    this.sqlitePath = configuredSqlitePath ||
      (!options.preferJson && !hasJsonOverride && graphPath === DEFAULT_CITATION_GRAPH_PATH
        ? DEFAULT_SQLITE_DATA_PATH
        : null);
    this.requireSqlite = options.requireSqlite ?? Boolean(configuredSqlitePath);
    this.payload = null;
    this.loadedAt = null;
    this.loadError = null;
    this.byTargetCelex = new Map();
    this.database = null;
    this.source = null;
  }

  load() {
    this.close();
    if (this.sqlitePath && fs.existsSync(this.sqlitePath)) return this.loadFromSqlite();
    if (this.requireSqlite) {
      this.loadError = `SQLite data store not found at ${this.sqlitePath}`;
      return false;
    }
    return this.loadFromJson();
  }

  close() {
    if (this.database) {
      try { this.database.close(); } catch { /* already closed */ }
      this.database = null;
    }
  }

  loadFromSqlite() {
    try {
      const Database = require("better-sqlite3");
      const database = new Database(this.sqlitePath, { readonly: true, fileMustExist: true });
      const schemaVersion = database.prepare("PRAGMA user_version").get().user_version;
      if (schemaVersion !== SQLITE_SCHEMA_VERSION) {
        database.close();
        throw new Error(`Unsupported SQLite data schema ${schemaVersion}; expected ${SQLITE_SCHEMA_VERSION}`);
      }
      const metadata = new Map(
        database.prepare("SELECT key, value FROM metadata").all().map((row) => [row.key, row.value])
      );
      const graphVersion = Number.parseInt(metadata.get("citation_graph_version"), 10);
      if (!metadata.has("citation_graph_version")) {
        database.close();
        throw new Error("SQLite data store contains no citation graph");
      }
      if (graphVersion !== GRAPH_VERSION) {
        database.close();
        throw new Error(`Unsupported citation graph version ${graphVersion}; expected ${GRAPH_VERSION}`);
      }
      const parseMeta = (key) => { try { return JSON.parse(metadata.get(key)); } catch { return null; } };
      this.payload = {
        graphVersion,
        parserVersion: parseMeta("citation_graph_parser_version"),
        generatedAt: metadata.get("citation_graph_generated_at") || null,
        coverage: parseMeta("citation_graph_coverage"),
        stats: parseMeta("citation_graph_stats"),
      };
      this.database = database;
      this.byActStatement = database.prepare(`${CITATION_SELECT} WHERE citations.target_celex = ?`);
      this.byArticleStatement = database.prepare(
        `${CITATION_SELECT} WHERE citations.target_celex = ? AND citations.target_article_key = ?`
      );
      this.source = "sqlite";
      this.loadedAt = new Date().toISOString();
      this.loadError = null;
      return true;
    } catch (error) {
      this.payload = null;
      this.database = null;
      this.loadedAt = null;
      this.loadError = error.message;
      return false;
    }
  }

  loadFromJson() {
    try {
      // The graph is too large to commit, so a fresh deploy fetches
      // citation-graph.json.gz as a GitHub Release asset at build time (see
      // backend/Dockerfile). Prefer the raw file when present (a local rebuild
      // writes it), else fall back to the gzipped artifact.
      const gzPath = `${this.graphPath}.gz`;
      const useGz = !fs.existsSync(this.graphPath) && fs.existsSync(gzPath);
      if (!useGz && !fs.existsSync(this.graphPath)) {
        const error = new Error(`Citation graph not found at ${this.graphPath} (or ${gzPath})`);
        error.code = "ENOENT";
        throw error;
      }
      const raw = useGz
        ? zlib.gunzipSync(fs.readFileSync(gzPath)).toString("utf8")
        : fs.readFileSync(this.graphPath, "utf8");
      const parsed = JSON.parse(raw);
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
      this.source = "json";
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
      ready: this.isReady(), graphPath: this.graphPath, source: this.source,
      graphVersion: this.payload?.graphVersion || null, parserVersion: this.payload?.parserVersion ?? null,
      generatedAt: this.payload?.generatedAt || null, coverage: this.payload?.coverage || null,
      edges: this.payload?.stats?.edges ?? 0, loadedAt: this.loadedAt, error: this.loadError,
    };
  }

  // The only storage-dependent step: fetch the edges citing this act (optionally a
  // single article). Everything downstream is shared with the JSON path.
  edgesForAct(targetCelex) {
    if (this.database) return this.byActStatement.all(targetCelex);
    return this.byTargetCelex.get(targetCelex) || [];
  }

  edgesForArticle(targetCelex, articleKey) {
    if (this.database) return this.byArticleStatement.all(targetCelex, articleKey);
    return (this.byTargetCelex.get(targetCelex) || [])
      .filter((edge) => String(edge.targetArticle == null ? "" : edge.targetArticle).trim().toLowerCase() === articleKey);
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
    const matching = this.edgesForArticle(targetCelex, targetArticle);
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

  getActCitations(celex, options = {}) {
    this.assertReady();
    const targetCelex = normalize(celex);
    const citingLawsLimit = Math.max(1, Math.min(Number.parseInt(options.citingLawsLimit, 10) || 10, 50));
    const edges = this.edgesForAct(targetCelex);
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
    // Top citing acts: legislation only (a judgment is a single source, so a
    // "top" ranking is meaningless there — the case-law endpoints cover them),
    // ranked by how many distinct provisions of the citing act reference this one.
    const bySourceCelex = new Map();
    for (const edge of edges) {
      if (edge.kind !== "legislation") continue;
      const key = normalize(edge.sourceCelex);
      if (!key) continue;
      const entries = bySourceCelex.get(key) || [];
      entries.push(edge);
      bySourceCelex.set(key, entries);
    }
    const rankedCitingLaws = [...bySourceCelex.entries()]
      .map(([sourceCelex, lawEdges]) => ({
        celex: sourceCelex,
        title: lawEdges.find((edge) => edge.sourceTitle)?.sourceTitle || null,
        provisions: distinctSources(lawEdges).length,
      }))
      .sort((a, b) => b.provisions - a.provisions
        || a.celex.localeCompare(b.celex, "en", { numeric: true }));
    const citingLaws = {
      total: rankedCitingLaws.length,
      laws: rankedCitingLaws.slice(0, citingLawsLimit),
    };
    // `actOnly`, `article`, and `totals` each count *distinct source provisions*
    // within their own edge subset, so they intentionally do NOT sum: a single
    // provision that cites both the act generally and a specific article is
    // counted once in `actOnly` and once in `article`, but only once in
    // `totals` (which dedups across every edge). Treat `totals` as the
    // authoritative distinct-source count; do not derive it from the parts.
    return { celex: targetCelex, actOnly: countsFor(actOnly), article: countsFor(article), articles, citingLaws, totals: countsFor(edges) };
  }
}

module.exports = { CitationGraphStore, DEFAULT_CITATION_GRAPH_PATH, DEFAULT_SQLITE_DATA_PATH, GRAPH_VERSION, SQLITE_SCHEMA_VERSION, distinctSources };
