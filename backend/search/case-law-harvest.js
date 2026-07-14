// Bulk-download the raw HTML of the CJEU / General Court judgments that interpret
// legislation into the case-law corpus (case-law/<year>/<CELEX>.html.gz).
//
// Download-only, mirroring the laws pipeline: parsing judgment HTML into
// structured declarations + articleRefs (via shared/case-law-parser.js) happens
// OFFLINE afterward, so the fragile parser never blocks the network run and can
// be re-run against the local corpus with zero re-scraping.
//
// It reuses the WAF-resilient, resumable, corpus-first `harvestHtml` machinery
// with the "caselaw" variant — the judgment HTML endpoint is the same WAF-
// protected eur-lex.europa.eu/legal-content path as the FMX-less act harvest, so
// there is no reason to fork the fetch/retry/cookie-warm logic. Concurrency is 1
// (single warmed session, polite single stream); this is a deliberately slow,
// unattended run.
//
// Usage (from backend/):
//   node search/case-law-harvest.js                 # discover if needed, then harvest
//   node search/case-law-harvest.js --maxRecords 50 # small capped smoke run
//   node search/case-law-harvest.js --skipDiscover  # reuse existing targets file

const fs = require("fs");
const path = require("path");

const { harvestHtml } = require("./html-harvest");
const { discoverCaseLawTargets, DEFAULT_TARGETS_PATH } = require("./case-law-discover");

const DATA_DIR = path.join(__dirname, "data");
const DEFAULT_STATE_PATH = path.join(DATA_DIR, "case-law-harvest-state.json");

async function harvestCaseLaw(options = {}) {
  const targetsPath = options.targets || DEFAULT_TARGETS_PATH;
  const statePath = options.statePath || DEFAULT_STATE_PATH;
  const corpusDir = options.corpusDir || DATA_DIR;

  if (!options.skipDiscover && !fs.existsSync(targetsPath)) {
    console.log("[case-law-harvest] no targets file — discovering judgments first");
    await discoverCaseLawTargets({ outPath: targetsPath });
  }

  return harvestHtml({
    variant: "caselaw",
    targets: targetsPath,
    statePath,
    corpusDir,
    // Cookies live alongside the laws corpus so the warmed WAF session is shared.
    cookieCacheDir: corpusDir,
    // Polite single-stream default; judgments are larger than act shells.
    delayMs: options.delayMs !== undefined ? options.delayMs : 400,
    maxRecords: options.maxRecords,
    timeoutMs: options.timeoutMs,
    eurlexBase: options.eurlexBase,
  });
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith("--")) { options[key] = true; }
    else { options[key] = next; i += 1; }
  }
  const result = await harvestCaseLaw(options);
  console.log(`[case-law-harvest] Done pass: ${JSON.stringify(result)}`);
}

if (require.main === module) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { harvestCaseLaw, DEFAULT_STATE_PATH };
