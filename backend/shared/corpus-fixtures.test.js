"use strict";

// Parse-health regression across every EU document-format era we support.
//
// __fixtures__/corpus/ holds one frozen EUR-Lex capture per format era, plus
// targeted parser regression fixtures (see manifest.json for the map). Each is
// parsed through the same path the production build uses — FMX via
// wrapForParsing() + the Formex parser, EUR-Lex HTML via the HTML parser — and
// asserted to still yield at least the article/recital/definition counts
// recorded at freeze time. A parser change that breaks an older era (the
// recurring failure mode: recitals silently dropping to zero) fails here
// instead of shipping.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const { parseFmxXml } = require("./fmx-parser-node.js");
const { parseEurlexHtmlToCombined } = require("./eurlex-html-parser.js");
const { wrapForParsing } = require("../search/search-build.js");
const { inspectParseHealth } = require("../search/parse-health.js");

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
    const annexes = combined.annexes?.length || 0;

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
    assert.ok(
      annexes >= (entry.expect.minAnnexes || 0),
      `${entry.celex}: expected >= ${entry.expect.minAnnexes || 0} annexes, got ${annexes}`,
    );

    if (entry.celex === "32000R2909") {
      assert.deepEqual(combined.definitions.map((definition) => definition.term), ["Depreciation"]);
    }
    if (entry.celex === "32004R0671") {
      assert.deepEqual(combined.definitions, [], "quoted amendment targets must not become definitions");
    }

    // Cross-reference / citation extraction floors. These guard that older HTML
    // laws populate a crossReferences map (recital preambles + articles), capture
    // "(N) OJ No …" footnote citations, and that treaty (TFEU/TEU) references are
    // detected — the recurring gaps being an empty map or dropped citations.
    const crossReferences = combined.crossReferences || {};
    const crossRefKeys = Object.keys(crossReferences).length;
    const allRefs = Object.values(crossReferences).flat();
    const ojRefs = allRefs.filter((ref) => ref.type === "oj_ref").length;
    const treatyRefs = allRefs.filter((ref) => ref.treaty).length;

    assert.ok(
      crossRefKeys >= (entry.expect.minCrossRefKeys || 0),
      `${entry.celex}: expected >= ${entry.expect.minCrossRefKeys || 0} crossReferences keys, got ${crossRefKeys}`,
    );
    assert.ok(
      ojRefs >= (entry.expect.minOjRefs || 0),
      `${entry.celex}: expected >= ${entry.expect.minOjRefs || 0} OJ footnote refs, got ${ojRefs}`,
    );
    assert.ok(
      treatyRefs >= (entry.expect.minTreatyRefs || 0),
      `${entry.celex}: expected >= ${entry.expect.minTreatyRefs || 0} treaty refs, got ${treatyRefs}`,
    );

    if (entry.celex === "31972R2681") {
      const legacy = allRefs.find((ref) => ref.target === "2306/70");
      assert.deepEqual(
        legacy && { articleNumber: legacy.articleNumber, year: legacy.year, number: legacy.number, actCelex: legacy.actCelex },
        { articleNumber: "10", year: "1970", number: "2306", actCelex: "31970R2306" },
      );
    }

    if (entry.celex === "32004R0097") {
      const refsTo2299 = (crossReferences["2"] || [])
        .filter((ref) => ref.target === "2299/2003")
        .map((ref) => ref.articleNumber);
      assert.deepEqual(refsTo2299, ["1"], "the Article 2 heading must not bind to Regulation 2299/2003");
    }
    // Every fixture must be free of the self-contradictions in
    // search/parse-health.js. This is the one layer of that check that runs in
    // CI: the corpus sweeps need the gitignored local corpus and skip without
    // it. It caught two contaminated captures when it was introduced — see the
    // re-freeze notes in manifest.json.
    const health = inspectParseHealth(combined);
    assert.deepEqual(
      health.signals,
      [],
      `${entry.celex}: parse-health contradictions :: ${health.signals.join(" | ")}`,
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
