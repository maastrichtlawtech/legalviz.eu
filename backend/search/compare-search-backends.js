"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { JsonLegalCacheStore } = require("./legal-cache-store");

const DEFAULT_SEARCH_PATH = path.join(__dirname, "data", "search-cache.json");
const DEFAULT_SQLITE_PATH = path.join(__dirname, "data", "data.sqlite");
const DEFAULT_CASES_PATH = path.join(__dirname, "search-parity-cases.json");

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (token === "--search" && value) options.searchPath = path.resolve(value);
    else if (token === "--sqlite" && value) options.sqlitePath = path.resolve(value);
    else if (token === "--cases" && value) options.casesPath = path.resolve(value);
    else if (token === "--report" && value) options.reportPath = path.resolve(value);
    else continue;
    index += 1;
  }
  return options;
}

function runCases(store, cases, limit = 10) {
  return cases.map((entry) => ({
    ...entry,
    results: store.searchLaws(entry.query, { limit }).map((result) => result.celex),
  }));
}

function rankOf(results, celex) {
  const index = results.indexOf(celex);
  return index < 0 ? null : index + 1;
}

function evaluateParity(cases, jsonRuns, sqliteRuns, preserveOldTopWithin = 5) {
  const failures = [];
  let sameTopResult = 0;
  const comparisons = cases.map((entry, index) => {
    const json = jsonRuns[index].results;
    const sqlite = sqliteRuns[index].results;
    if (json[0] === sqlite[0]) sameTopResult += 1;
    if (json.length > 0 && sqlite.length === 0) {
      failures.push(`${entry.query}: SQLite returned no results; JSON returned ${json[0]}`);
    }
    if (!entry.allowTopChange && json[0] && !sqlite.slice(0, preserveOldTopWithin).includes(json[0])) {
      failures.push(
        `${entry.query}: previous top result ${json[0]} is outside SQLite top ${preserveOldTopWithin}`
      );
    }
    if (entry.expectedCelex) {
      const maxRank = entry.maxRank || 1;
      const jsonRank = rankOf(json, entry.expectedCelex);
      const sqliteRank = rankOf(sqlite, entry.expectedCelex);
      if (!entry.allowTopChange && (jsonRank === null || jsonRank > maxRank)) {
        failures.push(`${entry.query}: expected ${entry.expectedCelex} within JSON top ${maxRank}, rank ${jsonRank}`);
      }
      if (sqliteRank === null || sqliteRank > maxRank) {
        failures.push(`${entry.query}: expected ${entry.expectedCelex} within SQLite top ${maxRank}, rank ${sqliteRank}`);
      }
    }
    return {
      query: entry.query,
      expectedCelex: entry.expectedCelex || null,
      allowTopChange: Boolean(entry.allowTopChange),
      json,
      sqlite,
      sameTopResult: json[0] === sqlite[0],
    };
  });

  return {
    summary: {
      queries: cases.length,
      sameTopResult,
      changedTopResult: cases.length - sameTopResult,
      failures: failures.length,
      preserveOldTopWithin,
    },
    failures,
    comparisons,
  };
}

function loadStore(store, label) {
  const startedAt = Date.now();
  if (!store.load()) throw new Error(`${label} failed to load: ${store.loadError}`);
  return Date.now() - startedAt;
}

function writeReport(reportPath, report) {
  if (!reportPath) return;
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const searchPath = options.searchPath || DEFAULT_SEARCH_PATH;
  const jsonCachePath = searchPath.endsWith(".gz") ? searchPath.slice(0, -3) : searchPath;
  const sqlitePath = options.sqlitePath || DEFAULT_SQLITE_PATH;
  const casesPath = options.casesPath || DEFAULT_CASES_PATH;
  const config = JSON.parse(fs.readFileSync(casesPath, "utf8"));
  const cases = config.cases || [];

  const jsonStore = new JsonLegalCacheStore(jsonCachePath, { preferJson: true });
  const jsonLoadMs = loadStore(jsonStore, "JSON store");
  const jsonRuns = runCases(jsonStore, cases);
  jsonStore.close();
  jsonStore.resetIndexes();
  if (typeof global.gc === "function") global.gc();

  const sqliteStore = new JsonLegalCacheStore(jsonCachePath, { sqlitePath, requireSqlite: true });
  const sqliteLoadMs = loadStore(sqliteStore, "SQLite store");
  const sqliteRuns = runCases(sqliteStore, cases);
  sqliteStore.close();

  const report = evaluateParity(
    cases,
    jsonRuns,
    sqliteRuns,
    config.preserveOldTopWithin || 5
  );
  report.generatedAt = new Date().toISOString();
  report.inputs = { searchPath, sqlitePath, casesPath };
  report.loadMs = { json: jsonLoadMs, sqlite: sqliteLoadMs };
  writeReport(options.reportPath, report);
  console.log(JSON.stringify({ summary: report.summary, loadMs: report.loadMs }, null, 2));
  if (report.failures.length > 0) {
    for (const failure of report.failures) console.error(`[search-parity] ${failure}`);
    process.exitCode = 1;
  }
  return report;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[search-parity] fatal: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { evaluateParity, parseArgs, rankOf, runCases };
