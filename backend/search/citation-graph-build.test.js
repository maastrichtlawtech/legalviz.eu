const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { buildCitationGraph, buildCitationGraphBatched, DEFAULT_MAX_XML_BYTES, formatSummaryReport, listCorpusFiles, parseCliArgs, sourceUnitTypeFor, stripCompleteUppercaseAnnexes } = require("./citation-graph-build");

test("CLI options and source unit types are normalized", () => {
  assert.equal(DEFAULT_MAX_XML_BYTES, 1024 * 1024);
  assert.deepEqual(parseCliArgs(["--corpusDir", "/corpus", "--out", "/graph.json", "--limit", "20", "--fromYear", "2010", "--toYear", "2020", "--maxXmlBytes", "1024", "--batchSize", "25"]), {
    corpusDir: "/corpus", outputPath: "/graph.json", limit: 20, fromYear: 2010, toYear: 2020, maxXmlBytes: 1024, batchSize: 25,
  });
  assert.throws(() => parseCliArgs(["--maxXmlBytes", "0"]), /Invalid value/);
  assert.throws(() => parseCliArgs(["--batchSize", "0"]), /Invalid value/);
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

test("builder dynamically records the skipped sibling HTML corpus", async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "citation-coverage-"));
  const laws = path.join(dataDir, "laws", "2020");
  const html = path.join(dataDir, "laws-html", "1999");
  await fsp.mkdir(laws, { recursive: true });
  await fsp.mkdir(html, { recursive: true });
  await fsp.writeFile(path.join(laws, "32020R0001.xml.gz"), "unused");
  await fsp.writeFile(path.join(html, "31999L0001.html.gz"), "unused");
  await fsp.writeFile(path.join(html, "31999L0002.html.gz"), "unused");
  const artifact = await buildCitationGraph({
    corpusDir: path.join(dataDir, "laws"), outputPath: null,
    legalCache: { isReady: () => true, getByCelex: () => null },
    readXml: async () => "xml", wrapXml: (xml) => xml,
    parseXml: async () => ({ parserVersion: 4, crossReferences: {} }),
  });
  assert.equal(artifact.coverage.legislation.htmlTreeSkipped, 2);
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

  assert.equal(artifact.graphVersion, 1);
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
