"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { DatabaseSync } = require("node:sqlite");

const { enrichSearchRecord } = require("./search-ranking");
const DEFAULT_SEARCH_CACHE_PATH = path.join(__dirname, "data", "search-cache.json");
const DEFAULT_SQLITE_DATA_PATH = path.join(__dirname, "data", "data.sqlite");
const DEFAULT_CASE_LAW_CACHE_PATH = path.join(__dirname, "data", "case-law-cache-v5.json");
const SQLITE_SCHEMA_VERSION = 1;

function resolveReadablePath(inputPath) {
  if (fs.existsSync(inputPath)) return inputPath;
  if (!inputPath.endsWith(".gz") && fs.existsSync(`${inputPath}.gz`)) return `${inputPath}.gz`;
  throw new Error(`Input data not found at ${inputPath}${inputPath.endsWith(".gz") ? "" : ` or ${inputPath}.gz`}`);
}

function readJson(inputPath) {
  const resolved = resolveReadablePath(inputPath);
  const bytes = fs.readFileSync(resolved);
  const raw = resolved.endsWith(".gz") ? zlib.gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
  return JSON.parse(raw);
}

function isPartialCaseLawEntry(entry) {
  return !entry?.name || !Array.isArray(entry.declarations) || entry.declarations.length === 0;
}

function buildSqliteData({
  searchCachePath = DEFAULT_SEARCH_CACHE_PATH,
  caseLawCachePath = DEFAULT_CASE_LAW_CACHE_PATH,
  outputPath = DEFAULT_SQLITE_DATA_PATH,
} = {}) {
  const searchPayload = readJson(searchCachePath);
  const caseLawPayload = readJson(caseLawCachePath);
  const records = Array.isArray(searchPayload.records) ? searchPayload.records : [];

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.${process.pid}.tmp`;
  fs.rmSync(tempPath, { force: true });

  const database = new DatabaseSync(tempPath);
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
      CREATE VIRTUAL TABLE law_excerpts USING fts5(
        excerpt,
        content='',
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TABLE case_law (
        celex TEXT PRIMARY KEY,
        details_json TEXT NOT NULL,
        is_partial INTEGER NOT NULL CHECK (is_partial IN (0, 1))
      ) STRICT;
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

    database.exec("BEGIN IMMEDIATE");
    try {
      insertMetadata.run("generated_at", String(searchPayload.generatedAt || ""));
      insertMetadata.run("search_record_count", String(records.length));
      insertMetadata.run("case_law_count", String(Object.keys(caseLawPayload).length));

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
        }
      });

      for (const [rawCelex, details] of Object.entries(caseLawPayload)) {
        const celex = String(rawCelex || "").trim().toUpperCase();
        if (!celex || !details || typeof details !== "object") continue;
        insertCaseLaw.run(celex, JSON.stringify(details), isPartialCaseLawEntry(details) ? 1 : 0);
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
    if (lawCount !== records.length) {
      throw new Error(`SQLite law count mismatch: wrote ${lawCount}, expected ${records.length}`);
    }

    database.close();
    fs.renameSync(tempPath, outputPath);
    return {
      outputPath,
      laws: lawCount,
      caseLaw: caseLawCount,
      bytes: fs.statSync(outputPath).size,
    };
  } catch (error) {
    try { database.close(); } catch { /* best effort */ }
    fs.rmSync(tempPath, { force: true });
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
    else if (token === "--output" && value) options.outputPath = path.resolve(value);
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
  buildSqliteData,
  isPartialCaseLawEntry,
  readJson,
};
