// Sidecar manifest mapping CELEX -> work_date_document (the SPARQL "date of
// document"), persisted at harvest time so the offline corpus rebuild
// (build-cache-from-corpus.js) can restore precise dates without re-querying
// SPARQL. The raw law source gzipped on disk doesn't carry this date, so
// without the manifest an offline rebuild has no date for these acts at all.
//
// One JSON object keyed by normalized CELEX, written atomically alongside the
// corpus (<dataDir>/law-dates.json). Merges are additive: a new non-empty date
// wins, but an incoming null/empty never clobbers a date we already have — so a
// later harvest that happens to omit the date can't erase good data.

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const DATES_FILENAME = "law-dates.json";

function corpusDatesPath(dataDir) {
  return path.join(dataDir, DATES_FILENAME);
}

function normalizeCelexKey(celex) {
  return String(celex || "").trim().toUpperCase();
}

// Load the manifest as a plain { CELEX: date } object. A missing or corrupt
// file behaves like "no dates known" so a build never crashes on it.
function readCorpusDates(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(corpusDatesPath(dataDir), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Merge {celex, date} entries into the manifest and persist it. Only entries
// with both a CELEX and a truthy date are recorded. Returns the total entry
// count after the merge.
async function mergeCorpusDates(dataDir, records) {
  const filePath = corpusDatesPath(dataDir);

  // Start from the existing manifest so the merge is additive across runs (a
  // later harvest of a subset of years must not drop dates gathered earlier).
  let dates = {};
  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        dates = parsed;
      } else {
        throw new Error("manifest is not a JSON object");
      }
    } catch {
      // The manifest exists but is unreadable. Overwriting it with only this
      // batch would silently discard every previously harvested date, so move
      // the corrupt file aside for recovery and rebuild from this batch instead.
      const salvage = `${filePath}.corrupt.${process.pid}.${Date.now()}`;
      await fsp.rename(filePath, salvage).catch(() => {});
    }
  }

  for (const record of records || []) {
    const key = normalizeCelexKey(record && record.celex);
    const date = record && record.date;
    if (!key || !date) continue;
    dates[key] = date;
  }
  await fsp.mkdir(dataDir, { recursive: true });
  // Atomic write so an interrupted harvest never leaves a truncated manifest
  // that would later read back as corrupt (and silently lose every date).
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tempPath, `${JSON.stringify(dates)}\n`, "utf8");
  await fsp.rename(tempPath, filePath);
  return Object.keys(dates).length;
}

module.exports = {
  DATES_FILENAME,
  corpusDatesPath,
  mergeCorpusDates,
  normalizeCelexKey,
  readCorpusDates,
};
