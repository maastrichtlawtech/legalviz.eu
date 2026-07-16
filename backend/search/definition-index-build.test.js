const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  buildDefinitionIndex,
  buildDefinitionShard,
  dedupeCorpusFiles,
  definitionHash,
  normalizeDefinition,
  normalizeTerm,
  parseCliArgs,
} = require("./definition-index-build");

test("definition normalization is conservative and stable", () => {
  assert.equal(normalizeTerm("  ‘Energy–Poverty’  "), "energy-poverty");
  assert.equal(normalizeDefinition("A   lack of affordable energy. "), "A lack of affordable energy");
  assert.equal(definitionHash("The same wording."), definitionHash("The  same wording"));
  assert.notEqual(definitionHash("The same wording"), definitionHash("Different wording"));
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
    celex: "32024R0001", lang: "EN", sourceArticle: "2", term: "risk",
    normalizedTerm: "risk", definition: "the potential for loss;",
    definitionHash: definitionHash("the potential for loss;"),
  });
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
    indexVersion: 1,
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
