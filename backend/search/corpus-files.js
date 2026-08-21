// One walker for the raw corpus trees under search/data/{laws,laws-html,case-law},
// each of which is <year>/<CELEX>.<ext>.gz.
//
// Not everything that lands in those directories is a corpus file. The corpus
// was seeded from a macOS checkout, so it carries AppleDouble sidecars —
// `._<CELEX>.xml.gz`, one per real file, holding Finder metadata rather than a
// gzip stream — and `tar` faithfully copies them into every corpus-vN release,
// which is why they have survived every refresh since. Anything that walks a
// year directory filtering on extension alone counts them as acts:
// `case-law-parse` fed 8,752 of them to gunzip every run (`incorrect header
// check`), and the refresh-data scan derived CELEX ids like `._31953D0004` and
// handed 80,465 of them to the backfill, which dropped every one as
// unqueryable.
//
// The releases are being cleaned separately; this module is the guarantee that
// a stray dotfile can never again be read as an act, and the reason the four
// near-identical walkers that used to live in the callers are now one.

const fs = require("fs");
const path = require("path");

// A corpus entry is a real file whose name is exactly `<CELEX><extension>`.
// Dotfiles are never acts: CELEX ids do not start with `.`, so this rejects
// AppleDouble sidecars, editor swap files, and `.DS_Store` alike.
function isCorpusFileName(name, extension) {
  return typeof name === "string" && !name.startsWith(".") && name.endsWith(extension) && name.length > extension.length;
}

function celexFromCorpusFileName(name, extension) {
  return name.slice(0, -extension.length);
}

// Walks `<root>/<year>/` in year then filename order, so batching and progress
// reporting are stable across runs. `maxYearExclusive` stops before a year the
// caller handles another way; omit it to take the whole tree.
function listCorpusFiles({ root, extension, maxYearExclusive }) {
  if (!root || !fs.existsSync(root)) return [];
  const out = [];
  const years = fs.readdirSync(root).filter((name) => /^\d{4}$/.test(name)).sort();
  for (const year of years) {
    if (Number.isFinite(maxYearExclusive) && Number(year) >= maxYearExclusive) continue;
    const yearDir = path.join(root, year);
    for (const name of fs.readdirSync(yearDir).sort()) {
      if (!isCorpusFileName(name, extension)) continue;
      out.push({ celex: celexFromCorpusFileName(name, extension), file: path.join(yearDir, name) });
    }
  }
  return out;
}

module.exports = { isCorpusFileName, celexFromCorpusFileName, listCorpusFiles };
