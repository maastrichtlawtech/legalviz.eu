"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");

const { enrichSearchRecord } = require("./search-ranking");
const DEFAULT_SEARCH_CACHE_PATH = path.join(__dirname, "data", "search-cache.json");
const DEFAULT_SQLITE_DATA_PATH = path.join(__dirname, "data", "data.sqlite");
const DEFAULT_CASE_LAW_CACHE_PATH = path.join(__dirname, "data", "case-law-cache-v5.json");
const SQLITE_SCHEMA_VERSION = 1;

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
  outputPath = DEFAULT_SQLITE_DATA_PATH,
  manifestPath = `${outputPath}.manifest.json`,
} = {}) {
  const searchAsset = readJsonAsset(searchCachePath);
  const caseLawAsset = readJsonAsset(caseLawCachePath);
  const searchPayload = searchAsset.payload;
  const caseLawPayload = caseLawAsset.payload;
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

    let expectedExcerptCount = 0;
    database.exec("BEGIN IMMEDIATE");
    try {
      insertMetadata.run("generated_at", String(searchPayload.generatedAt || ""));
      insertMetadata.run("search_record_count", String(records.length));
      insertMetadata.run("case_law_count", String(caseLawEntries.length));

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
  buildSqliteData,
  isPartialCaseLawEntry,
  readJson,
  readJsonAsset,
  sha256File,
};
