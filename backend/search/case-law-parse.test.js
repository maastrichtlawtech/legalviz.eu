const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const { parseCaseDetailsFromHtml, CITATION_PARSER_VERSION } = require("../shared/law-queries");
const { parseCaseLawCorpus, celexFromFile, needsParse } = require("./case-law-parse");

async function withTempDir(run) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "legalviz-clparse-"));
  try {
    await run(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

// A modern (post-2016) judgment shape: coj-bold party names + a visible article
// citation in the running text.
const MODERN_JUDGMENT = `<!doctype html><html><body>
<p><span class="coj-bold">Alpha GmbH</span></p>
<p><span class="coj-bold">Beta Data Authority</span></p>
<p>The referring court asks, in essence, whether, on a proper interpretation of
Article 5(3) of Directive 2002/58/EC, consent is required.</p>
<p class="coj-bold">On those grounds, the Court hereby rules:</p>
<p>Article 5(3) of Directive 2002/58/EC must be interpreted as meaning that consent is required.</p>
</body></html>`;

test("parseCaseDetailsFromHtml pulls party name and article citations from modern judgment HTML", () => {
  const details = parseCaseDetailsFromHtml(MODERN_JUDGMENT);
  assert.ok(details, "should parse");
  assert.equal(details.citationParserVersion, CITATION_PARSER_VERSION);
  assert.match(details.name, /Alpha GmbH v Beta Data Authority/);
  assert.ok(Array.isArray(details.articleRefs) && details.articleRefs.length > 0, "should find refs");
  const five = details.articleRefs.find((r) => r.article === "5");
  assert.ok(five, "should cite Article 5");
  assert.equal(five.paragraph, "3");
  assert.match(String(five.act), /2002\/58/);
});

// A pre-1970 judgment: no body name markup (name lives only in the DC.description
// OJ-notice line), uppercase operative part with a clause between "THE COURT" and
// the ruling verb, and "N ." spaced point numbering.
const OLD_JUDGMENT = `<!doctype html><html><head>
<meta name="DC.description" content="Judgment of the Court of 15 July 1964. - Flaminio Costa v E.N.E.L.. - Reference for a preliminary ruling: Giudice conciliatore di Milano. - Case 6/64.">
</head><body>
<p>THE FUNDAMENTAL QUESTION CONCERNS ARTICLE 37 of the EEC Treaty.</p>
<p>ON THOSE GROUNDS, THE COURT, IN ANSWER TO THE QUESTIONS REFERRED TO IT BY THE GIUDICE CONCILIATORE, MILAN, HEREBY RULES:
1 . ARTICLE 102 CONTAINS NO PROVISIONS WHICH ARE CAPABLE OF CREATING INDIVIDUAL RIGHTS .
2 . ARTICLE 53 CONSTITUTES A COMMUNITY RULE CAPABLE OF CREATING INDIVIDUAL RIGHTS .</p>
</body></html>`;

test("parseCaseDetailsFromHtml recovers name + operative declarations from a pre-1970 judgment", () => {
  const details = parseCaseDetailsFromHtml(OLD_JUDGMENT);
  assert.ok(details, "should parse");
  // Name comes from DC.description (there is no body bold markup here).
  assert.match(details.name, /Flaminio Costa v E\.N\.E\.L\./);
  // Operative part is recovered despite the "IN ANSWER TO…" clause and "N ." numbering.
  assert.equal(details.declarations.length, 2);
  assert.equal(details.declarations[0].number, 1);
  assert.match(details.declarations[0].text, /ARTICLE 102 CONTAINS NO PROVISIONS/);
  assert.equal(details.declarations[1].number, 2);
});

test("parseCaseDetailsFromHtml returns null for empty/too-short HTML", () => {
  assert.equal(parseCaseDetailsFromHtml(""), null);
  assert.equal(parseCaseDetailsFromHtml("<html></html>"), null);
});

test("celexFromFile strips the .html.gz suffix", () => {
  assert.equal(celexFromFile("/x/case-law/2019/62017CJ0673.html.gz"), "62017CJ0673");
});

test("needsParse skips entries already at the current parser version", () => {
  assert.equal(needsParse(undefined, false), true);
  assert.equal(needsParse({ citationParserVersion: CITATION_PARSER_VERSION }, false), false);
  assert.equal(needsParse({ citationParserVersion: CITATION_PARSER_VERSION - 1 }, false), true);
  assert.equal(needsParse({ citationParserVersion: CITATION_PARSER_VERSION }, true), true); // --force
});

// Regression: the corpus ships an AppleDouble sidecar beside every judgment.
// They are not gzip streams, so each one used to reach gunzip and come back
// "incorrect header check" — 8,752 errors per pipeline run, every run, since a
// failed parse writes no versioned stub to skip next time.
test("parseCaseLawCorpus ignores AppleDouble sidecars in the corpus", async () => {
  await withTempDir(async (dir) => {
    const corpusDir = path.join(dir, "case-law");
    const cacheDir = path.join(dir, "cache");
    fs.mkdirSync(path.join(corpusDir, "2019"), { recursive: true });
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "case-law-cache-v5.json"), "{}");
    fs.writeFileSync(
      path.join(corpusDir, "2019", "62019CJ0311.html.gz"),
      zlib.gzipSync(Buffer.from(MODERN_JUDGMENT, "utf8")),
    );
    // Finder metadata, not gzip — exactly what the corpus tars carry.
    fs.writeFileSync(
      path.join(corpusDir, "2019", "._62019CJ0311.html.gz"),
      Buffer.from("\x00\x05\x16\x07\x00\x02\x00\x00Mac OS X        ", "binary"),
    );

    const result = await parseCaseLawCorpus({ corpusDir, cacheDir, batchSize: 10 });
    assert.equal(result.total, 1, "the sidecar is not a judgment");
    assert.equal(result.parsed, 1);
    assert.equal(result.errors, 0, "no gunzip failures");

    const cache = JSON.parse(fs.readFileSync(path.join(cacheDir, "case-law-cache-v5.json"), "utf8"));
    assert.deepEqual(Object.keys(cache), ["62019CJ0311"]);
  });
});

test("parseCaseLawCorpus parses a corpus into the cache, is resumable, and merges", async () => {
  await withTempDir(async (dir) => {
    const corpusDir = path.join(dir, "case-law");
    const cacheDir = path.join(dir, "cache");
    fs.mkdirSync(path.join(corpusDir, "2019"), { recursive: true });
    fs.mkdirSync(cacheDir, { recursive: true });
    // This test exercises a deliberately empty local cache rather than the
    // production bundled corpus seed.
    fs.writeFileSync(path.join(cacheDir, "case-law-cache-v5.json"), "{}");
    fs.writeFileSync(
      path.join(corpusDir, "2019", "62019CJ0311.html.gz"),
      zlib.gzipSync(Buffer.from(MODERN_JUDGMENT, "utf8")),
    );

    const r1 = await parseCaseLawCorpus({ corpusDir, cacheDir, batchSize: 10 });
    assert.equal(r1.total, 1);
    assert.equal(r1.parsed, 1);
    assert.equal(r1.withRefs, 1);
    assert.equal(r1.errors, 0);

    // Cache written with the parsed entry.
    const cacheFile = path.join(cacheDir, `case-law-cache-v5.json`);
    const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    assert.ok(cache["62019CJ0311"]);
    assert.equal(cache["62019CJ0311"].citationParserVersion, CITATION_PARSER_VERSION);

    // Re-run: already at current version -> skipped, no re-parse.
    const r2 = await parseCaseLawCorpus({ corpusDir, cacheDir, batchSize: 10 });
    assert.equal(r2.skipped, 1);
    assert.equal(r2.parsed, 0);
  });
});
