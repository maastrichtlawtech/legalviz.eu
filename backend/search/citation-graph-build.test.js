const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { buildCitationGraph, buildCitationGraphBatched, createReferenceResolver, DEFAULT_MAX_XML_BYTES, GRAPH_VERSION, formatSummaryReport, listCorpusFiles, parseCliArgs, sourceUnitTypeFor, stripCompleteUppercaseAnnexes } = require("./citation-graph-build");

test("CLI options and source unit types are normalized", () => {
  assert.equal(DEFAULT_MAX_XML_BYTES, 1024 * 1024);
  assert.deepEqual(parseCliArgs(["--corpusDir", "/corpus", "--out", "/graph.json", "--limit", "20", "--fromYear", "2010", "--toYear", "2020", "--maxXmlBytes", "1024", "--batchSize", "25"]), {
    corpusDir: "/corpus", outputPath: "/graph.json", limit: 20, fromYear: 2010, toYear: 2020, maxXmlBytes: 1024, batchSize: 25,
  });
  assert.deepEqual(parseCliArgs(["--noHtml", "--htmlDir", "/html", "--maxHtmlBytes", "2048", "--workerHeapMb", "4096"]), {
    includeHtml: false, htmlDir: "/html", maxHtmlBytes: 2048, workerHeapMb: 4096,
  });
  assert.deepEqual(parseCliArgs(["--pool", "3"]), { poolSize: 3 });
  assert.throws(() => parseCliArgs(["--pool", "0"]), /Invalid value/);
  assert.throws(() => parseCliArgs(["--limit", "0"]), /Invalid value/);
  assert.throws(() => parseCliArgs(["--maxXmlBytes", "0"]), /Invalid value/);
  assert.throws(() => parseCliArgs(["--maxHtmlBytes", "0"]), /Invalid value/);
  assert.throws(() => parseCliArgs(["--batchSize", "0"]), /Invalid value/);
  assert.throws(() => parseCliArgs(["--workerHeapMb", "0"]), /Invalid value/);
  assert.throws(() => parseCliArgs(["--bogus", "1"]), /Unknown argument/);
  assert.equal(sourceUnitTypeFor("recital_12"), "recital");
  assert.equal(sourceUnitTypeFor("annex_1"), "annex");
  assert.equal(sourceUnitTypeFor("6"), "article");
});

test("builder aborts when reference resolution cache is unavailable", async () => {
  await assert.rejects(() => buildCitationGraph({
    files: [], outputPath: null,
    legalCache: { load: () => false, isReady: () => false, getStatus: () => ({ error: "missing" }) },
  }), /Legal search cache is unavailable: missing/);
});

test("listCorpusFiles walks shards deterministically and ignores non-FMX files", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "citation-corpus-"));
  await fsp.mkdir(path.join(dir, "2020"));
  await fsp.mkdir(path.join(dir, "2019"));
  await fsp.writeFile(path.join(dir, "2020", "32020R0002.xml.gz"), "");
  await fsp.writeFile(path.join(dir, "2019", "32019L0001.xml.gz"), "");
  await fsp.writeFile(path.join(dir, "2019", "ignore.html.gz"), "");
  const files = await listCorpusFiles(dir);
  assert.deepEqual(files.map((file) => path.basename(file)), ["32019L0001.xml.gz", "32020R0002.xml.gz"]);
});

test("listCorpusFiles skips AppleDouble sidecars and other dotfiles", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "citation-corpus-dotfiles-"));
  await fsp.mkdir(path.join(dir, "2020"));
  await fsp.writeFile(path.join(dir, "2020", "32020R0002.xml.gz"), "");
  // AppleDouble sidecar: not a gzip stream, must never be treated as an act
  // (see search/corpus-files.js's header comment for the incident history).
  await fsp.writeFile(path.join(dir, "2020", "._32020R0002.xml.gz"), "");
  await fsp.writeFile(path.join(dir, "2020", ".DS_Store"), "");
  const files = await listCorpusFiles(dir);
  assert.deepEqual(files.map((file) => path.basename(file)), ["32020R0002.xml.gz"]);
});

async function writeBothCorpora() {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "citation-coverage-"));
  const laws = path.join(dataDir, "laws", "2020");
  const html = path.join(dataDir, "laws-html", "1999");
  await fsp.mkdir(laws, { recursive: true });
  await fsp.mkdir(html, { recursive: true });
  await fsp.writeFile(path.join(laws, "32020R0001.xml.gz"), "unused");
  await fsp.writeFile(path.join(html, "31999L0001.html.gz"), "unused");
  await fsp.writeFile(path.join(html, "31999L0002.html.gz"), "unused");
  return dataDir;
}

// The pre-2000 corpus only exists as HTML, and its citations live in prose rather
// than <REF.DOC.OJ> markup — so walking it is the only way those acts contribute edges.
test("builder walks the sibling HTML corpus and edges its prose references", async () => {
  const dataDir = await writeBothCorpora();
  const artifact = await buildCitationGraph({
    corpusDir: path.join(dataDir, "laws"), outputPath: null,
    legalCache: { isReady: () => true, getByCelex: () => null },
    readXml: async () => "xml", wrapXml: (xml) => xml,
    parseXml: async () => ({ parserVersion: 4, crossReferences: {} }),
    readHtml: async () => "<html/>",
    parseHtml: async () => ({
      parserVersion: 4,
      crossReferences: { 1: [{ type: "external", targetCelex: "31968R1600", articleNumber: "3", raw: "Regulation (EEC) No 1600/68" }] },
    }),
  });

  assert.equal(artifact.coverage.legislation.corpusFiles, 3);   // 1 FMX + 2 HTML
  assert.equal(artifact.coverage.legislation.htmlLaws, 2);
  assert.equal(artifact.coverage.legislation.htmlTreeSkipped, 0); // walked, not skipped
  assert.deepEqual(artifact.edges.map((edge) => edge.sourceCelex), ["31999L0001", "31999L0002"]);
  assert.equal(artifact.edges[0].targetCelex, "31968R1600");
});

test("builder reports the HTML tree as skipped when --noHtml disables it", async () => {
  const dataDir = await writeBothCorpora();
  const artifact = await buildCitationGraph({
    corpusDir: path.join(dataDir, "laws"), outputPath: null, includeHtml: false,
    legalCache: { isReady: () => true, getByCelex: () => null },
    readXml: async () => "xml", wrapXml: (xml) => xml,
    parseXml: async () => ({ parserVersion: 4, crossReferences: {} }),
    parseHtml: () => assert.fail("HTML must not be parsed when includeHtml is false"),
  });
  assert.equal(artifact.coverage.legislation.corpusFiles, 1);
  assert.equal(artifact.coverage.legislation.htmlLaws, 0);
  assert.equal(artifact.coverage.legislation.htmlTreeSkipped, 2);
});

test("builder skips oversized HTML, which has no annex-stripping fallback", async () => {
  const artifact = await buildCitationGraph({
    files: ["/fake/31999L0001.html.gz"], outputPath: null, maxHtmlBytes: 8,
    legalCache: { isReady: () => true, getByCelex: () => null },
    readHtml: async () => "x".repeat(64),
    parseHtml: () => assert.fail("oversized HTML must not reach the parser"),
  });
  assert.equal(artifact.coverage.legislation.oversizedHtmlSkipped, 1);
  assert.equal(artifact.stats.parsedLaws, 0);
  assert.equal(artifact.failures[0].type, "oversized-html");
});

test("builder skips oversized decompressed XML before parsing and reports progress only when enabled", async () => {
  let parseCalls = 0;
  const messages = [];
  const artifact = await buildCitationGraph({
    files: ["/fake/32020R0001.xml.gz", "/fake/32020R0002.xml.gz"],
    outputPath: null, maxXmlBytes: 5, progress: true, progressInterval: 1,
    log: (message) => messages.push(message),
    legalCache: { isReady: () => true, getByCelex: () => null },
    readXml: async (file) => file.includes("0001") ? "123456" : "12345",
    wrapXml: (xml) => xml,
    parseXml: async () => { parseCalls += 1; return { parserVersion: 4, crossReferences: {} }; },
  });
  assert.equal(parseCalls, 1);
  assert.equal(artifact.stats.oversizedLawsSkipped, 1);
  assert.equal(artifact.coverage.legislation.oversizedLawsSkipped, 1);
  assert.equal(artifact.coverage.legislation.maxXmlBytes, 5);
  assert.deepEqual(artifact.failures, [{
    celex: "32020R0001", type: "oversized", xmlBytes: 6, maxXmlBytes: 5,
    error: "Decompressed FMX exceeds 5 bytes and has no safe operative-only fallback",
  }]);
  assert.equal(messages.length, 2);
  assert.match(messages[0], /1\/2 laws; current=32020R0001/);
});

test("builder parses an oversized ACT after removing complete uppercase annex siblings", async () => {
  const annex = "x".repeat(200);
  const xml = `<ACT><ENACTING.TERMS/></ACT><ANNEX IDENTIFIER="1">${annex}</ANNEX>`;
  let parsedInput;
  const artifact = await buildCitationGraph({
    files: ["/fake/32020R0001.xml.gz"], outputPath: null, maxXmlBytes: 50,
    legalCache: { isReady: () => true, getByCelex: () => null },
    readXml: async () => xml, wrapXml: (value) => value,
    parseXml: async (value) => { parsedInput = value; return { parserVersion: 4, crossReferences: {} }; },
  });
  assert.equal(parsedInput, "<ACT><ENACTING.TERMS/></ACT>");
  assert.equal(artifact.stats.parsedLaws, 1);
  assert.equal(artifact.stats.oversizedLawsOperativeOnly, 1);
  assert.equal(artifact.stats.oversizedLawsSkipped, 0);
  assert.equal(artifact.stats.annexElementsOmitted, 1);
  assert.equal(artifact.coverage.legislation.annexCoverage, "partial-operative-only");
  assert.deepEqual(artifact.failures, []);
  assert.match(formatSummaryReport(artifact), /1 operative-only \(1 annexes omitted\)/);
});

test("builder does not use operative-only fallback for malformed annex markup", async () => {
  let parseCalls = 0;
  const xml = `<ACT></ACT><ANNEX>${"x".repeat(100)}`;
  const artifact = await buildCitationGraph({
    files: ["/fake/32020R0001.xml.gz"], outputPath: null, maxXmlBytes: 20,
    legalCache: { isReady: () => true, getByCelex: () => null },
    readXml: async () => xml, wrapXml: (value) => value,
    parseXml: async () => { parseCalls += 1; return {}; },
  });
  assert.equal(parseCalls, 0);
  assert.equal(artifact.stats.oversizedLawsSkipped, 1);
  assert.equal(artifact.stats.oversizedLawsOperativeOnly, 0);
  assert.equal(artifact.failures[0].type, "oversized");
  const nested = stripCompleteUppercaseAnnexes("<ACT><ANNEX>x</ANNEX></ACT>");
  assert.equal(nested.annexElementsOmitted, 0);
  assert.equal(nested.hasUnmatchedAnnexMarkup, true);
});

test("builder does not use operative-only fallback for a self-closing annex sibling", async () => {
  let parseCalls = 0;
  // A self-closing <ANNEX ID="1"/> is consumed as an opening tag, and the lazy
  // body scan swallows <IMPORTANT/> and everything up to annex 2's </ANNEX> —
  // silently deleting operative content. The builder must reject this fallback.
  const xml = `<ACT></ACT><ANNEX ID="1"/><IMPORTANT/><ANNEX ID="2">${"x".repeat(200)}</ANNEX>`;
  const artifact = await buildCitationGraph({
    files: ["/fake/32020R0001.xml.gz"], outputPath: null, maxXmlBytes: 50,
    legalCache: { isReady: () => true, getByCelex: () => null },
    readXml: async () => xml, wrapXml: (value) => value,
    parseXml: async () => { parseCalls += 1; return {}; },
  });
  assert.equal(parseCalls, 0);
  assert.equal(artifact.stats.oversizedLawsSkipped, 1);
  assert.equal(artifact.stats.oversizedLawsOperativeOnly, 0);
  assert.equal(artifact.failures[0].type, "oversized");
  const stripped = stripCompleteUppercaseAnnexes(xml);
  assert.equal(stripped.hasSelfClosingAnnex, true);
});

test("builder resolves, deduplicates, reports failures/unresolved refs, and marks case law partial", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "citation-build-"));
  const outputPath = path.join(dir, "graph.json");
  const files = ["/fake/32024R0002.xml.gz", "/fake/32024R0001.xml.gz", "/fake/32024R0003.xml.gz"];
  const parsed = {
    parserVersion: 4,
    title: "Source law",
    crossReferences: {
      7: [
        { type: "external", actType: "regulation", year: "2016", number: "679", articleNumber: "6", paragraph: "1", point: "a" },
        { type: "external", actType: "regulation", year: "2016", number: "679", articleNumber: "6", paragraph: "1", point: "a" },
        { type: "external", target: "TFEU", articleNumber: "267", treaty: true },
        { type: "article", target: "8" },
      ],
      8: [{ type: "external", actType: "regulation", year: "2016", number: "679" }],
    },
  };
  const legalCache = {
    isReady: () => true,
    getByCelex: () => ({ title: "Canonical source title" }),
    getByOfficialReference: ({ year, number }) => year === "2016" && number === "679" ? { celex: "32016R0679" } : null,
  };
  const artifact = await buildCitationGraph({
    files,
    outputPath,
    legalCache,
    wrapXml: (xml) => `wrapped:${xml}`,
    readXml: async (file) => path.basename(file),
    parseXml: async (xml) => {
      if (xml.includes("0003")) throw new Error("bad FMX");
      return parsed;
    },
    caseLawData: {
      "62020CJ0001": { name: "Example judgment", articleRefs: [
        { actCelex: "32016R0679", article: "6", paragraph: "1", point: "a" },
        { actCelex: "32016R0679", article: "6", paragraph: "1", point: "a" },
      ] },
    },
    now: () => new Date("2026-01-02T03:04:05.000Z"),
  });

  assert.equal(artifact.graphVersion, GRAPH_VERSION);
  assert.equal(artifact.parserVersion, 4);
  assert.equal(artifact.coverage.caseLaw.status, "partial-cache");
  assert.equal(artifact.stats.parseFailures, 1);
  assert.equal(artifact.stats.unresolvedReferences, 2);
  // Reference stats count parsed mentions; edge stats below count deduplicated edges.
  assert.equal(artifact.stats.resolvedReferences, 6);
  assert.equal(artifact.stats.legislationEdges, 4);
  assert.equal(artifact.stats.judgmentEdges, 1);
  assert.deepEqual(artifact.failures, [{ celex: "32024R0003", error: "bad FMX" }]);
  const articleEdge = artifact.edges.find((edge) => edge.kind === "legislation" && edge.targetArticle === "6");
  assert.deepEqual({
    unitType: articleEdge.sourceUnitType, unit: articleEdge.sourceUnit,
    article: articleEdge.targetArticle, paragraph: articleEdge.targetParagraph, point: articleEdge.targetPoint,
  }, { unitType: "article", unit: "7", article: "6", paragraph: "1", point: "a" });
  assert.equal(fs.readFileSync(outputPath, "utf8"), JSON.stringify(artifact));
  assert.equal(fs.readdirSync(dir).filter((name) => name.includes(".tmp")).length, 0);
  const report = formatSummaryReport(artifact);
  assert.match(report, /Top cited articles:/);
  assert.match(report, /32016R0679 Article 6/);
});

test("batched builder recursively isolates a failing law and merges case law once", async () => {
  const files = [
    "/fake/32020R0001.xml.gz", "/fake/32020R0002.xml.gz",
    "/fake/32020R0003.xml.gz", "/fake/32020R0004.xml.gz",
  ];
  const calls = [];
  const workerRunner = async (batch) => {
    calls.push(batch.map((file) => path.basename(file)));
    if (batch.some((file) => file.includes("0002"))) throw new Error("worker OOM");
    return {
      graphVersion: 1,
      parserVersion: 4,
      stats: {
        corpusFiles: batch.length, parsedLaws: batch.length, parseFailures: 0,
        oversizedLawsSkipped: 0, oversizedLawsOperativeOnly: 0, annexElementsOmitted: 0,
        externalReferences: batch.length, unresolvedReferences: 0,
      },
      failures: [],
      edges: batch.map((file) => ({
        kind: "legislation", sourceCelex: path.basename(file).slice(0, -7), sourceTitle: null,
        sourceUnitType: "article", sourceUnit: "1", targetCelex: "32016R0679",
        targetArticle: "6", targetParagraph: null, targetPoint: null, raw: "Article 6",
      })),
    };
  };
  const artifact = await buildCitationGraphBatched({
    files, batchSize: 4, outputPath: null, workerRunner, htmlTreeSkipped: 9,
    // Supplied so the parent does not go looking for a real search cache; the
    // fake workerRunner above never resolves anything with it.
    resolverIndex: { officialRef: {}, celexTitle: {} },
    caseLawData: { "62020CJ0001": { name: "Case", articleRefs: [{ actCelex: "32016R0679", article: "6" }] } },
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  assert.deepEqual(calls.map((batch) => batch.length), [4, 2, 1, 1, 2]);
  assert.equal(artifact.stats.corpusFiles, 4);
  assert.equal(artifact.stats.parsedLaws, 3);
  assert.equal(artifact.stats.parseFailures, 1);
  assert.equal(artifact.stats.legislationEdges, 3);
  assert.equal(artifact.stats.judgmentEdges, 1);
  assert.equal(artifact.coverage.legislation.htmlTreeSkipped, 9);
  assert.deepEqual(artifact.failures, [{ celex: "32020R0002", type: "worker_failure", error: "worker OOM" }]);
  assert.deepEqual(artifact.edges.map((edge) => edge.sourceCelex), ["62020CJ0001", "32020R0001", "32020R0003", "32020R0004"]);
});

// Regression guard for the build's dominant cost: each worker used to construct its
// own JsonLegalCacheStore, re-reading the cache and rebuilding a MiniSearch index it
// never queries — ~800 reloads over a full corpus. The parent must resolve once and
// hand every batch the same index.
test("batched builder resolves the search cache once and shares it with every worker", async () => {
  let exports = 0;
  const legalCache = {
    isReady: () => true,
    exportReferenceIndex: () => { exports += 1; return { officialRef: { "regulation|2016|679": "32016R0679" }, celexTitle: {} }; },
  };
  const seen = [];
  const workerRunner = async (batch, options) => {
    seen.push(options.resolverIndex);
    return { parserVersion: 4, stats: { corpusFiles: batch.length, parsedLaws: batch.length }, failures: [], edges: [] };
  };
  await buildCitationGraphBatched({
    files: ["/fake/32020R0001.xml.gz", "/fake/32020R0002.xml.gz", "/fake/32020R0003.xml.gz"],
    batchSize: 1, outputPath: null, workerRunner, legalCache, caseLawData: null,
  });
  assert.equal(exports, 1, "search cache must be reduced to an index exactly once");
  assert.equal(seen.length, 3);
  assert.ok(seen.every((index) => index === seen[0]), "every worker gets the same index instance");
  assert.equal(seen[0].officialRef["regulation|2016|679"], "32016R0679");
});

test("createReferenceResolver resolves exactly like the cache it was exported from", () => {
  const resolver = createReferenceResolver({
    officialRef: { "regulation|2016|679": "32016R0679" },
    celexTitle: { "32020R0001": "Widgets", "32020R0002": null },
  });
  assert.equal(resolver.isReady(), true);
  assert.deepEqual(resolver.getByOfficialReference({ actType: "regulation", year: "2016", number: "679" }), { celex: "32016R0679" });
  // padded/odd-cased input must normalise the same way the store does
  assert.deepEqual(resolver.getByOfficialReference({ actType: "Regulation", year: "2016", number: "0679" }), { celex: "32016R0679" });
  assert.equal(resolver.getByOfficialReference({ actType: "directive", year: "2016", number: "679" }), null);
  assert.equal(resolver.getByCelex("32020r0001").title, "Widgets");
  assert.equal(resolver.getByCelex("32020R0002").title, null);
  assert.equal(resolver.getByCelex("39999R9999"), null);
  assert.equal(createReferenceResolver({ officialRef: {}, celexTitle: {} }).isReady(), false);
});

// The default path must run the real worker pool: persistent workers pulling
// batches from a queue (this is what makes a full-corpus build ~2x faster than
// spawn-per-batch and amortises jsdom startup). Runs actual worker threads over
// a tiny gzipped FMX corpus — several batches across two workers.
test("batched builder's default pool parses a real corpus through persistent workers", async () => {
  const fixture = await fsp.readFile(path.join(__dirname, "..", "shared", "__fixtures__", "corpus", "fmx-v4-2009-32009L0004.xml.gz"));
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "citation-pool-"));
  const files = [];
  for (let index = 0; index < 5; index += 1) {
    const year = String(2010 + Math.floor(index / 4));
    await fsp.mkdir(path.join(dir, year), { recursive: true });
    const file = path.join(dir, year, `32010L000${index + 1}.xml.gz`);
    await fsp.writeFile(file, fixture);
    files.push(file);
  }
  const messages = [];
  const artifact = await buildCitationGraphBatched({
    files, batchSize: 2, outputPath: null, progress: true,
    log: (message) => messages.push(message),
    legalCache: {
      isReady: () => true,
      // The workers build their resolver from this index; createReferenceResolver
      // reports ready only when officialRef is non-empty, so seed one entry.
      exportReferenceIndex: () => ({ officialRef: { "directive|2009|4": "32009L0004" }, celexTitle: {} }),
    },
    caseLawData: null,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  assert.equal(artifact.stats.corpusFiles, 5);
  assert.equal(artifact.stats.parsedLaws, 5);
  assert.equal(artifact.stats.parseFailures, 0);
  assert.ok(Number.isInteger(artifact.parserVersion), "real parser stamps its version on every shard");
  // Three batches of two/two/one, pulled by two workers concurrently, so the
  // cumulative "N/5" counts are logged in completion order, not batch order
  // (e.g. 2/5 → 3/5 → 5/5 when the single-file batch lands between the two
  // two-file ones). Assert the stable invariants: one message per batch, the
  // completed-in-isolated-workers wording, strictly increasing counts that
  // finish at 5/5, and each batch naming its trailing law.
  assert.equal(messages.length, 3);
  assert.ok(messages.every((message) => /^\[citation-graph\] \d+\/5 laws completed in isolated workers; last=32010L000[1-5]$/.test(message)));
  const counts = messages.map((message) => Number(message.match(/^\[citation-graph\] (\d+)\/5/)[1]));
  assert.deepEqual(counts, [...counts].sort((a, b) => a - b), "cumulative counts are reported in increasing order");
  assert.equal(counts[counts.length - 1], 5, "progress finishes at 5/5");
});

test("pool recycling retires workers between batches without losing or duplicating laws", async () => {
  const fixture = await fsp.readFile(path.join(__dirname, "..", "shared", "__fixtures__", "corpus", "fmx-v4-2009-32009L0004.xml.gz"));
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "citation-recycle-"));
  const files = [];
  await fsp.mkdir(path.join(dir, "2010"), { recursive: true });
  for (let index = 0; index < 6; index += 1) {
    const file = path.join(dir, "2010", `32010L000${index + 1}.xml.gz`);
    await fsp.writeFile(file, fixture);
    files.push(file);
  }
  const messages = [];
  // One law per batch and a worker retired after every batch: each of the six
  // batches is served by a freshly spawned worker, so this exercises the
  // retire-then-recursively-assign path on every single hand-off.
  const artifact = await buildCitationGraphBatched({
    files, batchSize: 1, recycleBatches: 1, poolSize: 2, outputPath: null, progress: true,
    log: (message) => messages.push(message),
    legalCache: {
      isReady: () => true,
      exportReferenceIndex: () => ({ officialRef: { "directive|2009|4": "32009L0004" }, celexTitle: {} }),
    },
    caseLawData: null,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  assert.equal(artifact.stats.corpusFiles, 6, "every law is accounted for exactly once");
  assert.equal(artifact.stats.parsedLaws, 6);
  assert.equal(artifact.stats.parseFailures, 0, "retiring a worker never strands its batch");
  assert.equal(messages.length, 6, "one progress message per batch, none lost to recycling");
  const counts = messages.map((message) => Number(message.match(/^\[citation-graph\] (\d+)\/6/)[1]));
  assert.deepEqual(counts, [1, 2, 3, 4, 5, 6], "cumulative progress is unbroken across recycles");
});

test("recycling can be disabled with --recycleBatches 0", () => {
  // Unlike --pool and --batchSize, zero is meaningful here rather than invalid.
  assert.equal(parseCliArgs(["--recycleBatches", "0"]).recycleBatches, 0);
  assert.equal(parseCliArgs(["--recycleBatches", "12"]).recycleBatches, 12);
  assert.equal(parseCliArgs([]).recycleBatches, undefined, "absent flag leaves the builder default in force");
  assert.throws(() => parseCliArgs(["--recycleBatches", "-1"]), /Invalid value for --recycleBatches/);
});
