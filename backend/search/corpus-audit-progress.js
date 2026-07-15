const fs = require("fs");
const path = require("path");

const DEFAULT_PROGRESS_FILE = path.join(__dirname, "corpus-audit-progress.json");

function readProgress(file = DEFAULT_PROGRESS_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { schemaVersion: 1, corpora: {} };
  }
}

function mergeRanges(ranges) {
  const sorted = ranges.filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of sorted) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function recordAudit({
  file = DEFAULT_PROGRESS_FILE,
  kind,
  available,
  offset,
  selected,
  stats,
  years = [],
  emptyYears = [],
  rangeStable = false,
}) {
  const progress = readProgress(file);
  const entry = progress.corpora[kind] || { verifiedRanges: [], runs: [] };
  const clean = selected > 0 && !stats.errors && !stats.oversized;
  const empty = selected === 0;
  if (clean && rangeStable) entry.verifiedRanges = mergeRanges([...entry.verifiedRanges, [offset, offset + selected]]);
  entry.available = available;
  entry.runs.push({
    offset,
    selected,
    scanned: stats.scanned,
    errors: stats.errors || 0,
    oversized: stats.oversized || 0,
    explicitUnresolved: stats.explicitUnresolved || stats.unresolved || 0,
    clean,
    empty,
    years: [...new Set(years)],
    emptyYears: [...new Set(emptyYears)],
  });
  entry.runs = entry.runs.slice(-200);
  entry.years = entry.years || {};
  for (const year of new Set(years)) {
    const yearEntry = entry.years[year] || { runs: 0, cleanRuns: 0, emptyRuns: 0, scanned: 0 };
    yearEntry.runs += 1;
    yearEntry.scanned += stats.scanned || 0;
    if (clean) yearEntry.cleanRuns += 1;
    if (empty) yearEntry.emptyRuns = (yearEntry.emptyRuns || 0) + 1;
    entry.years[year] = yearEntry;
  }
  for (const year of new Set(emptyYears)) {
    const yearEntry = entry.years[year] || { runs: 0, cleanRuns: 0, emptyRuns: 0, scanned: 0 };
    yearEntry.runs += 1;
    yearEntry.emptyRuns = (yearEntry.emptyRuns || 0) + 1;
    entry.years[year] = yearEntry;
  }
  progress.corpora[kind] = entry;
  fs.writeFileSync(file, `${JSON.stringify(progress, null, 2)}\n`);
  return progress;
}

module.exports = { DEFAULT_PROGRESS_FILE, mergeRanges, readProgress, recordAudit };
