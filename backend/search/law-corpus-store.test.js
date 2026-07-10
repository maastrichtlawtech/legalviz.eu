const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const {
  celexShard,
  corpusPathFor,
  hasCorpusXml,
  readCorpusXml,
  sanitizeCelex,
  writeCorpusXml,
} = require("./law-corpus-store");

async function withTempDir(run) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "legalviz-corpus-test-"));
  try {
    await run(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test("celexShard extracts the 4-digit year after the sector digit", () => {
  assert.equal(celexShard("32024R1234"), "2024");
  assert.equal(celexShard("31998L0034"), "1998");
  assert.equal(celexShard("garbage"), "unknown");
});

test("sanitizeCelex keeps safe chars and cannot escape the directory", () => {
  assert.equal(sanitizeCelex("32016R0679"), "32016R0679");
  assert.equal(sanitizeCelex("32001D0006(01)"), "32001D0006(01)");
  assert.ok(!sanitizeCelex("../../etc/passwd").includes("/"));
});

test("corpusPathFor shards by year under laws/", () => {
  const p = corpusPathFor("/data", "32024R1234");
  assert.equal(p, path.join("/data", "laws", "2024", "32024R1234.xml.gz"));
});

test("write then read round-trips the XML through gzip", async () => {
  await withTempDir(async (dir) => {
    const celex = "32016R0679";
    const xml = "<ACT><TITLE>GDPR</TITLE></ACT>";

    assert.equal(hasCorpusXml(dir, celex), false);
    assert.equal(await readCorpusXml(dir, celex), null);

    const wrote = await writeCorpusXml(dir, celex, xml);
    assert.equal(wrote, true);
    assert.equal(hasCorpusXml(dir, celex), true);
    assert.equal(await readCorpusXml(dir, celex), xml);

    // Stored gzipped, not plaintext.
    const stored = fs.readFileSync(corpusPathFor(dir, celex));
    assert.equal(stored[0], 0x1f);
    assert.equal(stored[1], 0x8b);
  });
});

test("writeCorpusXml skips empty payloads and readCorpusXml misses gracefully", async () => {
  await withTempDir(async (dir) => {
    assert.equal(await writeCorpusXml(dir, "32016R0679", ""), false);
    assert.equal(await readCorpusXml(dir, "32016R0679"), null);
  });
});

test("readCorpusXml treats a corrupt file as a cache miss", async () => {
  await withTempDir(async (dir) => {
    const celex = "32016R0679";
    const filePath = corpusPathFor(dir, celex);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, Buffer.from("not gzip"));
    assert.equal(await readCorpusXml(dir, celex), null);
  });
});
