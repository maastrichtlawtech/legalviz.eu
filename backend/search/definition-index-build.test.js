const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  buildDefinitionIndex,
  buildDefinitionShard,
  classifyDefinition,
  compactOccurrence,
  dedupeCorpusFiles,
  definitionHash,
  normalizeDefinition,
  normalizeTerm,
  parseCliArgs,
  INDEX_VERSION,
} = require("./definition-index-build");

test("definition normalization is conservative and stable", () => {
  assert.equal(normalizeTerm("  ‘Energy–Poverty’  "), "energy-poverty");
  assert.equal(normalizeDefinition("A   lack of affordable energy. "), "A lack of affordable energy");
  assert.equal(definitionHash("The same wording."), definitionHash("The  same wording"));
  assert.notEqual(definitionHash("The same wording"), definitionHash("Different wording"));
});

test("compact occurrences resolve definition references and assemble definition-level edges", () => {
  const imported = compactOccurrence("32024R0001", { langCode: "EN" }, {
    term: "risk",
    definition: "risk as defined in Article 6 of Directive (EU) 2022/2555",
    sourceArticle: "2",
    sourcePoint: "(1)",
    references: [{ type: "external", actCelex: "32022L2555", articleNumber: "6", raw: "Article 6 of Directive (EU) 2022/2555", start: 19, end: 61 }],
  });
  assert.equal(imported.classification, "imported");
  assert.equal(imported.sourcePoint, "1");
  assert.equal(imported.referenceEdges[0].edgeType, "definition_import");
  assert.equal(imported.referenceEdges[0].targetArticle, "6");

  const target = compactOccurrence("32022L2555", { langCode: "EN" }, {
    term: "risk", definition: "the potential for loss", sourceArticle: "6",
  });
  const artifact = require("./definition-index-build").assembleArtifact([
    { occurrences: [imported, target], failures: [], stats: {} },
  ], () => new Date("2026-01-01T00:00:00.000Z"));
  assert.equal(artifact.usageEdges[0].resolution, "definition");
  assert.equal(artifact.usageEdges[0].targetOccurrenceId, target.occurrenceId);
});

test("FMX wins when a CELEX exists in both corpus trees", () => {
  const files = dedupeCorpusFiles([
    "/data/laws-html/2020/32020R0001.html.gz",
    "/data/laws/2020/32020R0001.xml.gz",
    "/data/laws-html/1990/31990L0002.html.gz",
  ]);
  assert.deepEqual(files, [
    "/data/laws-html/1990/31990L0002.html.gz",
    "/data/laws/2020/32020R0001.xml.gz",
  ]);
});

test("definition shard preserves source article provenance", async () => {
  const shard = await buildDefinitionShard({
    files: ["/laws/2024/32024R0001.xml.gz"],
    readFile: async () => "<ACT />",
    wrapXml: (value) => value,
    parseXml: async () => ({
      parserVersion: 17,
      langCode: "EN",
      definitions: [{ term: " risk ", definition: "the potential for loss;", sourceArticle: "2" }],
    }),
  });
  assert.equal(shard.stats.definitions, 1);
  assert.deepEqual(shard.occurrences[0], {
    occurrenceId: shard.occurrences[0].occurrenceId,
    celex: "32024R0001", lang: "EN", sourceArticle: "2", sourcePoint: null, term: "risk",
    normalizedTerm: "risk", definition: "the potential for loss;",
    definitionHash: definitionHash("the potential for loss;"),
    classification: "substantive", classificationReason: null, referenceEdges: [],
  });
});

test("definition classification distinguishes imports from referenced local wording", () => {
  const resolved = [{ targetCelex: "32016R0679", targetArticle: "4", end: 58 }];
  assert.equal(classifyDefinition(
    "personal data", "personal data as defined in Article 4 of Regulation (EU) 2016/679", resolved, "EN"
  ).classification, "imported");
  assert.equal(classifyDefinition(
    "cyber threat", "a cyber threat as defined in Article 2 of Regulation (EU) 2019/881", resolved, "EN"
  ).classification, "imported");
  assert.equal(classifyDefinition(
    "renewable gas", "renewable gas as defined in Article 2 of Regulation (EU) 2020/1, which meets the threshold", resolved, "EN"
  ).classification, "hybrid");
  assert.equal(classifyDefinition(
    "low-carbon fuels",
    "recycled carbon fuels as defined in Article 2 of Directive (EU) 2018/2001, plus locally specified synthetic fuels that meet a separate greenhouse gas threshold and methodology under Article 29a of Directive (EU) 2018/2001",
    [
      { targetCelex: "32018L2001", targetArticle: "2", start: 36, end: 75 },
      { targetCelex: "32018L2001", targetArticle: "29a", start: 177, end: 225 },
    ],
    "EN"
  ).classification, "hybrid");
  assert.equal(classifyDefinition(
    "service", "a service referred to in Article 5", resolved, "EN"
  ).classification, "hybrid");
  assert.equal(classifyDefinition(
    "service", "service as defined in that Regulation", [{ targetCelex: null, end: 37 }], "EN"
  ).classification, "unclassified");
});

test("resumable build reads its checkpoint and only runs pending laws", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "definition-index-"));
  const outputPath = path.join(directory, "definitions.json");
  const checkpointPath = `${outputPath}.checkpoint`;
  const completedShard = {
    parserVersion: 17,
    stats: { corpusFiles: 1, parsedLaws: 1, definitions: 0 },
    failures: [], occurrences: [],
  };
  await fs.writeFile(checkpointPath, JSON.stringify({
    indexVersion: INDEX_VERSION,
    processedCelex: ["32020R0001"],
    shards: [completedShard],
  }));
  const seen = [];
  const artifact = await buildDefinitionIndex({
    files: ["/laws/2020/32020R0001.xml.gz", "/laws/2021/32021R0002.xml.gz"],
    outputPath,
    batchSize: 1,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    workerRunner: async (files) => {
      seen.push(...files);
      return {
        parserVersion: 17,
        stats: { corpusFiles: 1, parsedLaws: 1, definitions: 1 }, failures: [],
        occurrences: [{ celex: "32021R0002", lang: "EN", sourceArticle: "3", term: "risk", normalizedTerm: "risk", definition: "a risk", definitionHash: definitionHash("a risk") }],
      };
    },
  });
  assert.deepEqual(seen, ["/laws/2021/32021R0002.xml.gz"]);
  assert.equal(artifact.stats.corpusFiles, 2);
  assert.equal(artifact.stats.uniqueTerms, 1);
  await assert.rejects(fs.access(checkpointPath));
  assert.deepEqual(JSON.parse(await fs.readFile(outputPath, "utf8")), artifact);
});

test("CLI accepts corpus build controls", () => {
  assert.deepEqual(parseCliArgs(["--noHtml", "--limit", "5", "--batchSize", "2", "--out", "/tmp/defs.json"]), {
    includeHtml: false, limit: 5, batchSize: 2, outputPath: "/tmp/defs.json",
  });
  assert.throws(() => parseCliArgs(["--batchSize", "0"]), /Invalid value/);
});
