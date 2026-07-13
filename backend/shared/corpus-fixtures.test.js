"use strict";

// Parse-health regression across every EU document-format era we support.
//
// __fixtures__/corpus/ holds one real, frozen EUR-Lex capture per format era
// (see manifest.json for the map). Each is parsed through the same path the
// production build uses — FMX via wrapForParsing() + the Formex parser, EUR-Lex
// HTML via the HTML parser — and asserted to still yield at least the article/
// recital/definition counts recorded at freeze time. A parser change that breaks
// an older era (the recurring failure mode: recitals silently dropping to zero)
// fails here instead of shipping.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const { parseFmxXml } = require("./fmx-parser-node.js");
const { parseEurlexHtmlToCombined } = require("./eurlex-html-parser.js");
const { wrapForParsing } = require("../search/search-build.js");

const FIXTURE_DIR = path.join(__dirname, "__fixtures__", "corpus");
const manifest = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, "manifest.json"), "utf8"),
);

function readFixture(file) {
  return zlib.gunzipSync(fs.readFileSync(path.join(FIXTURE_DIR, file))).toString("utf8");
}

async function parseFixture(entry) {
  const raw = readFixture(entry.file);
  if (entry.kind === "fmx") return parseFmxXml(wrapForParsing(raw));
  if (entry.kind === "html") return parseEurlexHtmlToCombined(raw, "ENG");
  throw new Error(`Unknown fixture kind: ${entry.kind}`);
}

test("every format-era fixture is present and listed once", () => {
  const listed = manifest.fixtures.map((f) => f.file).sort();
  const onDisk = fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".gz"))
    .sort();
  assert.deepEqual(onDisk, listed, "manifest and fixture files must match exactly");
  assert.equal(new Set(listed).size, listed.length, "no duplicate fixture entries");
});

for (const entry of manifest.fixtures) {
  test(`parses ${entry.format} (${entry.celex})`, async () => {
    const combined = await parseFixture(entry);
    const articles = combined.articles?.length || 0;
    const recitals = combined.recitals?.length || 0;
    const definitions = combined.definitions?.length || 0;

    assert.ok(
      articles >= entry.expect.minArticles,
      `${entry.celex}: expected >= ${entry.expect.minArticles} articles, got ${articles}`,
    );
    assert.ok(
      recitals >= entry.expect.minRecitals,
      `${entry.celex}: expected >= ${entry.expect.minRecitals} recitals, got ${recitals}`,
    );
    assert.ok(
      definitions >= entry.expect.minDefinitions,
      `${entry.celex}: expected >= ${entry.expect.minDefinitions} definitions, got ${definitions}`,
    );
    // The enacting formula must never leak into a recital in any era.
    assert.ok(
      (combined.recitals || []).every(
        (r) => !/\b(?:HAS|HAVE)\s+(?:ADOPTED|DECIDED)\s+THIS\s+(?:REGULATION|DIRECTIVE|DECISION)\b/i.test(r.recital_text || ""),
      ),
      `${entry.celex}: a recital swallowed the enacting formula`,
    );
  });
}
