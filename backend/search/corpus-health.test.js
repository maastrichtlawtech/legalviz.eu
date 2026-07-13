"use strict";

// Corpus-wide parse-health scan — opt-in, skips when the raw corpus is absent.
//
// The gitignored local corpus (search/data/laws{,-html}) is only present on a
// machine that has run the harvest. When it is, this samples across every year
// and asserts aggregate health: nearly everything parses into a non-empty
// excerpt, and parse errors are rare. It is the corpus-scale counterpart to the
// per-era guarantees in shared/corpus-fixtures.test.js. In CI (no corpus) it
// reports as skipped rather than failing.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const { parseFmxXml } = require("../shared/fmx-parser-node.js");
const { parseEurlexHtmlToCombined } = require("../shared/eurlex-html-parser.js");
const { wrapForParsing, buildExcerptFromCombined } = require("./search-build.js");

const DATA_DIR = path.join(__dirname, "data");
const FMX_ROOT = path.join(DATA_DIR, "laws");
const HTML_ROOT = path.join(DATA_DIR, "laws-html");

// Cap the sample so the scan stays reasonable even on a full corpus; evenly
// spaced across each year so every era is represented. FMX parsing (jsdom) is
// the slow part. Raise via CORPUS_HEALTH_SAMPLE for a deeper local pass; the
// exhaustive sweep is intentionally not in the test suite.
const MAX_PER_CORPUS = Number(process.env.CORPUS_HEALTH_SAMPLE) || 100;

function listYearFiles(root, ext) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const year of fs.readdirSync(root).filter((d) => /^\d{4}$/.test(d)).sort()) {
    for (const f of fs.readdirSync(path.join(root, year))) {
      if (f.endsWith(ext)) files.push(path.join(root, year, f));
    }
  }
  return files;
}

function evenSample(files, cap) {
  if (files.length <= cap) return files;
  const step = files.length / cap;
  const picked = [];
  for (let i = 0; i < files.length && picked.length < cap; i += step) {
    picked.push(files[Math.floor(i)]);
  }
  return picked;
}

async function scan(files, parse) {
  let empty = 0;
  let errors = 0;
  const errorSamples = [];
  for (const file of files) {
    let raw;
    try {
      raw = zlib.gunzipSync(fs.readFileSync(file)).toString("utf8");
    } catch {
      continue; // mid-write / corrupt gz — not a parser signal
    }
    try {
      const combined = await parse(raw);
      if (!(buildExcerptFromCombined(combined) || "")) empty += 1;
    } catch (e) {
      errors += 1;
      if (errorSamples.length < 10) errorSamples.push(`${path.basename(file)}: ${e.message}`);
    }
  }
  return { scanned: files.length, empty, errors, errorSamples };
}

test("FMX corpus parses into non-empty excerpts", async (t) => {
  const files = evenSample(listYearFiles(FMX_ROOT, ".xml.gz"), MAX_PER_CORPUS);
  if (files.length === 0) {
    t.skip("no local FMX corpus (search/data/laws) — run the harvest to enable");
    return;
  }
  const r = await scan(files, (raw) => parseFmxXml(wrapForParsing(raw)));
  const emptyRate = r.empty / r.scanned;
  const errorRate = r.errors / r.scanned;
  assert.ok(errorRate < 0.02, `FMX parse errors ${(errorRate * 100).toFixed(1)}% > 2% :: ${r.errorSamples.join(" | ")}`);
  assert.ok(emptyRate < 0.1, `FMX empty excerpts ${(emptyRate * 100).toFixed(1)}% > 10% (scanned ${r.scanned})`);
});

test("EUR-Lex HTML corpus parses into non-empty excerpts", async (t) => {
  const files = evenSample(listYearFiles(HTML_ROOT, ".html.gz"), MAX_PER_CORPUS);
  if (files.length === 0) {
    t.skip("no local HTML corpus (search/data/laws-html) — run the harvest to enable");
    return;
  }
  const r = await scan(files, (raw) => parseEurlexHtmlToCombined(raw, "ENG"));
  const emptyRate = r.empty / r.scanned;
  const errorRate = r.errors / r.scanned;
  assert.ok(errorRate < 0.02, `HTML parse errors ${(errorRate * 100).toFixed(1)}% > 2% :: ${r.errorSamples.join(" | ")}`);
  assert.ok(emptyRate < 0.05, `HTML empty excerpts ${(emptyRate * 100).toFixed(1)}% > 5% (scanned ${r.scanned})`);
});
