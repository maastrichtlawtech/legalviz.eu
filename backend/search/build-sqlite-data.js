"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");

const { enrichSearchRecord } = require("./search-ranking");
const DEFAULT_SEARCH_CACHE_PATH = path.join(__dirname, "data", "search-cache.json");
const DEFAULT_SQLITE_DATA_PATH = path.join(__dirname, "data", "data.sqlite");
// Unversioned on purpose: the data-vN release tag already pins which build this
// came from, so a case-law schema bump no longer has to edit the Dockerfile's asset
// list. This is the release asset, distinct from law-cache/case-law-cache-v5.json,
// whose name IS the cache version (CASE_LAW_CACHE_FILE) and must keep its suffix.
const DEFAULT_CASE_LAW_CACHE_PATH = path.join(__dirname, "data", "case-law-cache.json");
const DEFAULT_CITATION_GRAPH_PATH = path.join(__dirname, "data", "citation-graph.json");
const DEFAULT_DEFINITIONS_PATH = path.join(__dirname, "data", "definitions.json");
// Keep in lock-step with SQLITE_SCHEMA_VERSION in legal-cache-store.js.
const SQLITE_SCHEMA_VERSION = 3;

// Normalized form of a cited article, matching how the store compares them, so the
// (target_celex, target_article_key) index can serve the lookup directly rather than
// forcing a scan through LOWER()/TRIM() at query time.
function articleKey(article) {
  return String(article == null ? "" : article).trim().toLowerCase();
}

function textOrNull(value) {
  if (value == null) return null;
  const text = String(value);
  return text === "" ? null : text;
}

function normalizeDefinitionTerm(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[‘’‛`]/g, "'")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[\s'"“”]+|[\s'"“”.,;:]+$/g, "")
    .toLocaleLowerCase("en");
}

function definitionRows(payload) {
  const occurrences = Array.isArray(payload?.occurrences)
    ? payload.occurrences
    : (Array.isArray(payload?.definitions) ? payload.definitions : []);
  const rows = [];
  for (const item of occurrences) {
    const term = String(item?.term || item?.displayTerm || "").trim();
    const normalizedTerm = normalizeDefinitionTerm(item?.normalizedTerm || term);
    const definition = String(item?.definition || item?.text || "").trim();
    const celex = String(item?.celex || "").trim().toUpperCase();
    if (!normalizedTerm || !term || !definition || !celex) continue;
    rows.push({
      normalizedTerm, term, definition, celex,
      sourceArticle: textOrNull(item.sourceArticle ?? item.article),
      definitionHash: String(item.definitionHash || item.wordingHash || "").trim()
        || crypto.createHash("sha256").update(definition.normalize("NFKC").replace(/\s+/g, " ").trim()).digest("hex"),
    });
  }
  return rows;
}

function definitionTermRows(payload, occurrences) {
  const supplied = Array.isArray(payload?.terms)
    ? payload.terms
    : (Array.isArray(payload?.groups) ? payload.groups : []);
  const suppliedByTerm = new Map();
  for (const item of supplied) {
    const normalizedTerm = normalizeDefinitionTerm(item?.normalizedTerm || item?.term || item?.displayTerm);
    if (normalizedTerm) suppliedByTerm.set(normalizedTerm, item);
  }
  const grouped = new Map();
  for (const row of occurrences) {
    const group = grouped.get(row.normalizedTerm) || [];
    group.push(row);
    grouped.set(row.normalizedTerm, group);
  }
  const keys = new Set([...suppliedByTerm.keys(), ...grouped.keys()]);
  return [...keys].map((normalizedTerm) => {
    const item = suppliedByTerm.get(normalizedTerm) || {};
    const members = grouped.get(normalizedTerm) || [];
    const displayTerm = String(item.displayTerm || item.term || members[0]?.term || normalizedTerm).trim();
    const sampleDefinition = String(item.sampleDefinition || item.definition || members[0]?.definition || "").trim();
    const lawCount = Number.isSafeInteger(item.lawCount)
      ? item.lawCount : new Set(members.map((row) => row.celex)).size;
    const wordingCount = Number.isSafeInteger(item.wordingCount)
      ? item.wordingCount : new Set(members.map((row) => row.definitionHash)).size;
    return { normalizedTerm, displayTerm, sampleDefinition, lawCount, wordingCount };
  }).filter((row) => row.displayTerm && row.sampleDefinition);
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(filePath, "r");
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function resolveReadablePath(inputPath) {
  if (fs.existsSync(inputPath)) return inputPath;
  if (!inputPath.endsWith(".gz") && fs.existsSync(`${inputPath}.gz`)) return `${inputPath}.gz`;
  throw new Error(`Input data not found at ${inputPath}${inputPath.endsWith(".gz") ? "" : ` or ${inputPath}.gz`}`);
}

function readJson(inputPath) {
  return readJsonAsset(inputPath).payload;
}

function readJsonAsset(inputPath) {
  const resolved = resolveReadablePath(inputPath);
  const bytes = fs.readFileSync(resolved);
  const raw = resolved.endsWith(".gz") ? zlib.gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
  return {
    payload: JSON.parse(raw),
    path: resolved,
    bytes: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}

function isPartialCaseLawEntry(entry) {
  return !entry?.name || !Array.isArray(entry.declarations) || entry.declarations.length === 0;
}

function buildSqliteData({
  searchCachePath = DEFAULT_SEARCH_CACHE_PATH,
  caseLawCachePath = DEFAULT_CASE_LAW_CACHE_PATH,
  citationGraphPath = DEFAULT_CITATION_GRAPH_PATH,
  definitionsPath = DEFAULT_DEFINITIONS_PATH,
  outputPath = DEFAULT_SQLITE_DATA_PATH,
  manifestPath = `${outputPath}.manifest.json`,
  log = console.warn,
} = {}) {
  const searchAsset = readJsonAsset(searchCachePath);
  const caseLawAsset = readJsonAsset(caseLawCachePath);
  // The citation graph is optional: it is a large, separately built artifact, and a
  // build without it must still produce a usable data.sqlite. The tables are then
  // empty and the store reports itself unavailable (503) rather than serving a
  // silently partial graph — the manifest records which case this build was.
  let citationAsset = null;
  if (citationGraphPath) {
    try {
      citationAsset = readJsonAsset(citationGraphPath);
    } catch (error) {
      if (!/not found/.test(String(error?.message))) throw error;
      log(`[build-sqlite-data] No citation graph at ${citationGraphPath} — citation tables will be empty`);
    }
  }
  let definitionsAsset = null;
  if (definitionsPath) {
    try {
      definitionsAsset = readJsonAsset(definitionsPath);
    } catch (error) {
      if (!/not found/.test(String(error?.message))) throw error;
      log(`[build-sqlite-data] No definitions index at ${definitionsPath} — definition tables will be empty`);
    }
  }
  const searchPayload = searchAsset.payload;
  const caseLawPayload = caseLawAsset.payload;
  const citationEdges = Array.isArray(citationAsset?.payload?.edges) ? citationAsset.payload.edges : [];
  const definitionOccurrences = definitionRows(definitionsAsset?.payload);
  const definitionTerms = definitionTermRows(definitionsAsset?.payload, definitionOccurrences);
  const records = Array.isArray(searchPayload.records) ? searchPayload.records : [];
  const caseLawEntries = Object.entries(caseLawPayload).filter(([rawCelex, details]) => (
    String(rawCelex || "").trim() && details && typeof details === "object"
  ));

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const tempPath = `${outputPath}.${process.pid}.tmp`;
  const tempManifestPath = `${manifestPath}.${process.pid}.tmp`;
  fs.rmSync(tempPath, { force: true });
  fs.rmSync(tempManifestPath, { force: true });

  const database = new Database(tempPath);
  try {
    database.exec(`
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;
      PRAGMA temp_store = MEMORY;
      PRAGMA user_version = ${SQLITE_SCHEMA_VERSION};

      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE laws (
        ordinal INTEGER PRIMARY KEY,
        celex TEXT,
        record_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE law_excerpt_map (
        rowid INTEGER PRIMARY KEY,
        celex TEXT NOT NULL,
        ordinal INTEGER NOT NULL
      ) STRICT;
      -- detail=full is FTS5's default; stated explicitly so phrase/NEAR recall
      -- stays available and a later reviewer does not "simplify" it to a
      -- narrower detail mode. Because it matches the default, the on-disk
      -- format is unchanged and SQLITE_SCHEMA_VERSION does not need a bump;
      -- moving to detail=column/none would change the schema and require one.
      CREATE VIRTUAL TABLE law_excerpts USING fts5(
        excerpt,
        content='',
        detail=full,
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TABLE case_law (
        celex TEXT PRIMARY KEY,
        details_json TEXT NOT NULL,
        is_partial INTEGER NOT NULL CHECK (is_partial IN (0, 1))
      ) STRICT;
      -- Citing-act titles live here rather than on every edge: ~84k distinct sources
      -- carry ~836k edges, so repeating the title per edge is what made the JSON
      -- artifact enormous.
      CREATE TABLE citation_sources (
        celex TEXT PRIMARY KEY,
        title TEXT
      ) STRICT;
      CREATE TABLE citations (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        source_celex TEXT NOT NULL,
        source_unit_type TEXT,
        source_unit TEXT,
        target_celex TEXT NOT NULL,
        target_article TEXT,
        target_article_key TEXT NOT NULL,
        target_paragraph TEXT,
        target_point TEXT,
        raw TEXT
      ) STRICT;
      -- Serves both cited-by lookups: act-level uses the target_celex prefix,
      -- article-level uses both columns.
      CREATE INDEX citations_target ON citations (target_celex, target_article_key);
      CREATE TABLE definition_occurrences (
        id INTEGER PRIMARY KEY,
        normalized_term TEXT NOT NULL,
        term TEXT NOT NULL,
        definition TEXT NOT NULL,
        definition_hash TEXT NOT NULL,
        celex TEXT NOT NULL,
        source_article TEXT
      ) STRICT;
      CREATE INDEX definition_occurrences_term ON definition_occurrences (normalized_term);
      CREATE VIRTUAL TABLE definition_terms USING fts5(
        normalized_term,
        display_term,
        sample_definition,
        law_count UNINDEXED,
        wording_count UNINDEXED,
        tokenize='unicode61 remove_diacritics 2'
      );
    `);

    const insertMetadata = database.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)");
    const insertLaw = database.prepare("INSERT INTO laws (ordinal, celex, record_json) VALUES (?, ?, ?)");
    const insertExcerptMap = database.prepare(
      "INSERT INTO law_excerpt_map (rowid, celex, ordinal) VALUES (?, ?, ?)"
    );
    const insertExcerpt = database.prepare("INSERT INTO law_excerpts (rowid, excerpt) VALUES (?, ?)");
    const insertCaseLaw = database.prepare(
      "INSERT INTO case_law (celex, details_json, is_partial) VALUES (?, ?, ?)"
    );
    const insertCitationSource = database.prepare(
      "INSERT INTO citation_sources (celex, title) VALUES (?, ?)"
    );
    const insertCitation = database.prepare(`
      INSERT INTO citations (
        kind, source_celex, source_unit_type, source_unit,
        target_celex, target_article, target_article_key, target_paragraph, target_point, raw
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertDefinitionOccurrence = database.prepare(`
      INSERT INTO definition_occurrences
        (normalized_term, term, definition, definition_hash, celex, source_article)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertDefinitionTerm = database.prepare(`
      INSERT INTO definition_terms
        (normalized_term, display_term, sample_definition, law_count, wording_count)
      VALUES (?, ?, ?, ?, ?)
    `);

    let expectedExcerptCount = 0;
    let skippedCitationEdges = 0;
    database.exec("BEGIN IMMEDIATE");
    try {
      insertMetadata.run("generated_at", String(searchPayload.generatedAt || ""));
      insertMetadata.run("search_record_count", String(records.length));
      insertMetadata.run("case_law_count", String(caseLawEntries.length));
      insertMetadata.run("definitions_available", definitionsAsset ? "1" : "0");

      records.forEach((record, ordinal) => {
        const excerpt = typeof record?.excerpt === "string" ? record.excerpt : "";
        const withoutExcerpt = { ...(record || {}) };
        for (const derivedKey of [
          "excerpt",
          "normalizedTitle",
          "normalizedEli",
          "normalizedCelex",
          "celexYear",
          "celexNumber",
          "eliKind",
          "isPrimaryAct",
          "aliases",
        ]) {
          delete withoutExcerpt[derivedKey];
        }
        const celex = String(withoutExcerpt.celex || "").trim().toUpperCase() || null;
        insertLaw.run(ordinal, celex, JSON.stringify(withoutExcerpt));

        if (celex && excerpt && enrichSearchRecord(record).isPrimaryAct) {
          const rowid = ordinal + 1;
          insertExcerptMap.run(rowid, celex, ordinal);
          insertExcerpt.run(rowid, excerpt);
          expectedExcerptCount += 1;
        }
      });

      for (const [rawCelex, details] of caseLawEntries) {
        const celex = String(rawCelex || "").trim().toUpperCase();
        insertCaseLaw.run(celex, JSON.stringify(details), isPartialCaseLawEntry(details) ? 1 : 0);
      }

      if (citationAsset) {
        const header = citationAsset.payload;
        insertMetadata.run("citation_graph_version", String(header.graphVersion ?? ""));
        insertMetadata.run("citation_graph_parser_version", JSON.stringify(header.parserVersion ?? null));
        insertMetadata.run("citation_graph_generated_at", String(header.generatedAt || ""));
        insertMetadata.run("citation_graph_coverage", JSON.stringify(header.coverage ?? null));
        insertMetadata.run("citation_graph_stats", JSON.stringify(header.stats ?? null));
      }
      const citationSourceTitles = new Map();
      for (const edge of citationEdges) {
        const sourceCelex = String(edge?.sourceCelex || "").trim().toUpperCase();
        const targetCelex = String(edge?.targetCelex || "").trim().toUpperCase();
        // An edge without both endpoints cannot be looked up from either side.
        if (!sourceCelex || !targetCelex) { skippedCitationEdges += 1; continue; }
        if (!citationSourceTitles.has(sourceCelex)) {
          citationSourceTitles.set(sourceCelex, textOrNull(edge.sourceTitle));
        }
        insertCitation.run(
          String(edge.kind || ""), sourceCelex,
          textOrNull(edge.sourceUnitType), textOrNull(edge.sourceUnit),
          targetCelex, textOrNull(edge.targetArticle), articleKey(edge.targetArticle),
          textOrNull(edge.targetParagraph), textOrNull(edge.targetPoint), textOrNull(edge.raw),
        );
      }
      for (const [celex, title] of citationSourceTitles) insertCitationSource.run(celex, title);
      insertMetadata.run("citation_edge_count", String(citationEdges.length - skippedCitationEdges));
      for (const row of definitionOccurrences) {
        insertDefinitionOccurrence.run(
          row.normalizedTerm, row.term, row.definition, row.definitionHash, row.celex, row.sourceArticle
        );
      }
      for (const row of definitionTerms) {
        insertDefinitionTerm.run(
          row.normalizedTerm, row.displayTerm, row.sampleDefinition, row.lawCount, row.wordingCount
        );
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    database.exec("VACUUM");
    const integrity = database.prepare("PRAGMA integrity_check").get().integrity_check;
    if (integrity !== "ok") throw new Error(`SQLite integrity check failed: ${integrity}`);

    const lawCount = database.prepare("SELECT COUNT(*) AS count FROM laws").get().count;
    const caseLawCount = database.prepare("SELECT COUNT(*) AS count FROM case_law").get().count;
    const excerptCount = database.prepare("SELECT COUNT(*) AS count FROM law_excerpts").get().count;
    const excerptMapCount = database.prepare("SELECT COUNT(*) AS count FROM law_excerpt_map").get().count;
    const orphanLawMappings = database.prepare(`
      SELECT COUNT(*) AS count
      FROM law_excerpt_map AS mapping
      LEFT JOIN laws ON laws.ordinal = mapping.ordinal
      WHERE laws.ordinal IS NULL
    `).get().count;
    const orphanFtsMappings = database.prepare(`
      SELECT COUNT(*) AS count
      FROM law_excerpt_map AS mapping
      LEFT JOIN law_excerpts ON law_excerpts.rowid = mapping.rowid
      WHERE law_excerpts.rowid IS NULL
    `).get().count;
    if (lawCount !== records.length) {
      throw new Error(`SQLite law count mismatch: wrote ${lawCount}, expected ${records.length}`);
    }
    if (caseLawCount !== caseLawEntries.length) {
      throw new Error(`SQLite case-law count mismatch: wrote ${caseLawCount}, expected ${caseLawEntries.length}`);
    }
    if (excerptCount !== expectedExcerptCount || excerptMapCount !== expectedExcerptCount) {
      throw new Error(
        `SQLite excerpt count mismatch: FTS ${excerptCount}, mapping ${excerptMapCount}, expected ${expectedExcerptCount}`
      );
    }
    if (orphanLawMappings !== 0 || orphanFtsMappings !== 0) {
      throw new Error(
        `SQLite excerpt mapping integrity failed: ${orphanLawMappings} missing laws, ` +
        `${orphanFtsMappings} missing FTS rows`
      );
    }

    const citationCount = database.prepare("SELECT COUNT(*) AS count FROM citations").get().count;
    const citationSourceCount = database.prepare("SELECT COUNT(*) AS count FROM citation_sources").get().count;
    const definitionTermCount = database.prepare("SELECT COUNT(*) AS count FROM definition_terms").get().count;
    const definitionOccurrenceCount = database.prepare("SELECT COUNT(*) AS count FROM definition_occurrences").get().count;
    if (definitionTermCount !== definitionTerms.length || definitionOccurrenceCount !== definitionOccurrences.length) {
      throw new Error(
        `SQLite definition count mismatch: terms ${definitionTermCount}/${definitionTerms.length}, ` +
        `occurrences ${definitionOccurrenceCount}/${definitionOccurrences.length}`
      );
    }
    const expectedCitationCount = citationEdges.length - skippedCitationEdges;
    if (citationCount !== expectedCitationCount) {
      throw new Error(`SQLite citation count mismatch: wrote ${citationCount}, expected ${expectedCitationCount}`);
    }
    const orphanCitationSources = database.prepare(`
      SELECT COUNT(*) AS count
      FROM citations
      LEFT JOIN citation_sources ON citation_sources.celex = citations.source_celex
      WHERE citation_sources.celex IS NULL
    `).get().count;
    if (orphanCitationSources !== 0) {
      throw new Error(`SQLite citation source integrity failed: ${orphanCitationSources} edges without a source row`);
    }

    database.close();
    const outputBytes = fs.statSync(tempPath).size;
    const outputSha256 = sha256File(tempPath);
    const manifest = {
      formatVersion: 1,
      schemaVersion: SQLITE_SCHEMA_VERSION,
      builtAt: new Date().toISOString(),
      source: {
        search: {
          file: path.basename(searchAsset.path),
          bytes: searchAsset.bytes,
          sha256: searchAsset.sha256,
          records: records.length,
          generatedAt: searchPayload.generatedAt || null,
        },
        caseLaw: {
          file: path.basename(caseLawAsset.path),
          bytes: caseLawAsset.bytes,
          sha256: caseLawAsset.sha256,
          records: caseLawEntries.length,
        },
        // null when this build had no citation graph input, so a deploy serving an
        // empty graph is attributable from the manifest alone.
        citationGraph: citationAsset ? {
          file: path.basename(citationAsset.path),
          bytes: citationAsset.bytes,
          sha256: citationAsset.sha256,
          edges: expectedCitationCount,
          skippedEdges: skippedCitationEdges,
          graphVersion: citationAsset.payload?.graphVersion ?? null,
          generatedAt: citationAsset.payload?.generatedAt || null,
        } : null,
        definitions: definitionsAsset ? {
          file: path.basename(definitionsAsset.path),
          bytes: definitionsAsset.bytes,
          sha256: definitionsAsset.sha256,
          terms: definitionTerms.length,
          occurrences: definitionOccurrences.length,
          generatedAt: definitionsAsset.payload?.generatedAt || null,
        } : null,
      },
      artifact: {
        file: path.basename(outputPath),
        bytes: outputBytes,
        sha256: outputSha256,
      },
      tables: {
        laws: lawCount,
        excerpts: excerptCount,
        excerptMappings: excerptMapCount,
        caseLaw: caseLawCount,
        citations: citationCount,
        citationSources: citationSourceCount,
        definitionTerms: definitionTermCount,
        definitionOccurrences: definitionOccurrenceCount,
      },
      integrity: {
        sqlite: integrity,
        orphanLawMappings,
        orphanFtsMappings,
      },
    };
    fs.writeFileSync(tempManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, outputPath);
    fs.renameSync(tempManifestPath, manifestPath);
    return {
      outputPath,
      manifestPath,
      laws: lawCount,
      excerpts: excerptCount,
      caseLaw: caseLawCount,
      definitionTerms: definitionTermCount,
      definitionOccurrences: definitionOccurrenceCount,
      bytes: outputBytes,
      sha256: outputSha256,
    };
  } catch (error) {
    try { database.close(); } catch { /* best effort */ }
    fs.rmSync(tempPath, { force: true });
    fs.rmSync(tempManifestPath, { force: true });
    throw error;
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (token === "--search" && value) options.searchCachePath = path.resolve(value);
    else if (token === "--case-law" && value) options.caseLawCachePath = path.resolve(value);
    else if (token === "--citation-graph" && value) options.citationGraphPath = path.resolve(value);
    else if (token === "--definitions" && value) options.definitionsPath = path.resolve(value);
    else if (token === "--output" && value) options.outputPath = path.resolve(value);
    else if (token === "--manifest" && value) options.manifestPath = path.resolve(value);
    else continue;
    index += 1;
  }
  return options;
}

if (require.main === module) {
  try {
    const result = buildSqliteData(parseArgs(process.argv.slice(2)));
    console.log(
      `[sqlite-data] wrote ${result.outputPath}: ${result.laws} laws, ` +
      `${result.caseLaw} judgments, ${(result.bytes / 1024 / 1024).toFixed(1)} MB`
    );
  } catch (error) {
    console.error(`[sqlite-data] fatal: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  DEFAULT_CASE_LAW_CACHE_PATH,
  DEFAULT_CITATION_GRAPH_PATH,
  DEFAULT_DEFINITIONS_PATH,
  SQLITE_SCHEMA_VERSION,
  articleKey,
  buildSqliteData,
  isPartialCaseLawEntry,
  normalizeDefinitionTerm,
  readJson,
  readJsonAsset,
  sha256File,
};
