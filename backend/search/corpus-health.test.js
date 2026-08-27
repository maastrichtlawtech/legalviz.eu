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
const { emptyHealth, inspectParseHealth, mergeParseHealth } = require("./parse-health.js");

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
  const result = { empty: 0, errors: 0, invalidInternalRefs: 0, ...emptyHealth() };
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
      if (!(buildExcerptFromCombined(combined) || "")) result.empty += 1;
      const validArticleNumbers = new Set((combined.articles || []).map((article) => String(article.article_number)));
      for (const refs of Object.values(combined.crossReferences || {})) {
        for (const ref of refs || []) {
          if (ref.type === "article" && !validArticleNumbers.has(String(ref.target))) {
            result.invalidInternalRefs += 1;
            if (errorSamples.length < 10) {
              errorSamples.push(`${path.basename(file)}: invalid internal Article ${ref.target}`);
            }
          }
        }
      }
      mergeParseHealth(result, inspectParseHealth(combined), { label: path.basename(file) });
    } catch (e) {
      result.errors += 1;
      if (errorSamples.length < 10) errorSamples.push(`${path.basename(file)}: ${e.message}`);
    }
  }
  return { scanned: files.length, ...result, errorSamples };
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
  const definitionArticleEmptyRate = r.definitionArticlesWithoutDefinitions / (r.definitionArticles || 1);
  const malformedDefinitionRate = r.malformedDefinitionTerms / (r.definitions || 1);
  const duplicateRecitalRate = r.recitalsDuplicated / r.scanned;
  const missingRecitalRate = r.recitalsMissing / r.scanned;
  const articlelessRate = r.articlelessWithBody / r.scanned;
  assert.ok(errorRate < 0.02, `FMX parse errors ${(errorRate * 100).toFixed(1)}% > 2% :: ${r.errorSamples.join(" | ")}`);
  assert.ok(emptyRate < 0.1, `FMX empty excerpts ${(emptyRate * 100).toFixed(1)}% > 10% (scanned ${r.scanned})`);
  assert.equal(r.invalidInternalRefs, 0, `FMX invalid internal refs :: ${r.errorSamples.join(" | ")}`);
  assert.ok(definitionArticleEmptyRate < 0.02, `FMX definition articles with zero definitions ${(definitionArticleEmptyRate * 100).toFixed(1)}% > 2% :: ${r.signals.join(" | ")}`);
  assert.ok(malformedDefinitionRate < 0.02, `FMX malformed definition terms ${(malformedDefinitionRate * 100).toFixed(1)}% > 2% :: ${r.signals.join(" | ")}`);
  // Recital-numbering and segmentation contradictions. These are asserted as
  // rates, not as zero: a handful of individual acts are known to trip them
  // (31993R2463 parses 30 recitals numbered up to 44), and failing the whole
  // sweep on one such act in a 100-act sample would make the check unusable.
  // The failure mode worth catching here is systemic — duplicate recital
  // numbers fired on most of the FMX corpus while harvested captures held the
  // act two or three times, and would again if that regressed.
  assert.ok(duplicateRecitalRate < 0.02, `FMX acts with duplicate recital numbers ${(duplicateRecitalRate * 100).toFixed(1)}% > 2% :: ${r.signals.join(" | ")}`);
  assert.ok(missingRecitalRate < 0.02, `FMX acts with recitals numbered above the parsed count ${(missingRecitalRate * 100).toFixed(1)}% > 2% :: ${r.signals.join(" | ")}`);
  assert.ok(articlelessRate < 0.02, `FMX acts with body text but no articles ${(articlelessRate * 100).toFixed(1)}% > 2% :: ${r.signals.join(" | ")}`);
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
  const definitionArticleEmptyRate = r.definitionArticlesWithoutDefinitions / (r.definitionArticles || 1);
  const malformedDefinitionRate = r.malformedDefinitionTerms / (r.definitions || 1);
  const duplicateRecitalRate = r.recitalsDuplicated / r.scanned;
  const missingRecitalRate = r.recitalsMissing / r.scanned;
  const articlelessRate = r.articlelessWithBody / r.scanned;
  assert.ok(errorRate < 0.02, `HTML parse errors ${(errorRate * 100).toFixed(1)}% > 2% :: ${r.errorSamples.join(" | ")}`);
  assert.ok(emptyRate < 0.05, `HTML empty excerpts ${(emptyRate * 100).toFixed(1)}% > 5% (scanned ${r.scanned})`);
  assert.equal(r.invalidInternalRefs, 0, `HTML invalid internal refs :: ${r.errorSamples.join(" | ")}`);
  assert.ok(definitionArticleEmptyRate < 0.02, `HTML definition articles with zero definitions ${(definitionArticleEmptyRate * 100).toFixed(1)}% > 2% :: ${r.signals.join(" | ")}`);
  assert.ok(malformedDefinitionRate < 0.02, `HTML malformed definition terms ${(malformedDefinitionRate * 100).toFixed(1)}% > 2% :: ${r.signals.join(" | ")}`);
  // Recital-numbering and segmentation contradictions. These are asserted as
  // rates, not as zero: a handful of individual acts are known to trip them
  // (31993R2463 parses 30 recitals numbered up to 44), and failing the whole
  // sweep on one such act in a 100-act sample would make the check unusable.
  // The failure mode worth catching here is systemic — duplicate recital
  // numbers fired on most of the FMX corpus while harvested captures held the
  // act two or three times, and would again if that regressed.
  assert.ok(duplicateRecitalRate < 0.02, `HTML acts with duplicate recital numbers ${(duplicateRecitalRate * 100).toFixed(1)}% > 2% :: ${r.signals.join(" | ")}`);
  assert.ok(missingRecitalRate < 0.02, `HTML acts with recitals numbered above the parsed count ${(missingRecitalRate * 100).toFixed(1)}% > 2% :: ${r.signals.join(" | ")}`);
  assert.ok(articlelessRate < 0.02, `HTML acts with body text but no articles ${(articlelessRate * 100).toFixed(1)}% > 2% :: ${r.signals.join(" | ")}`);
});
