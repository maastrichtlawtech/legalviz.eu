const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const {
  celexShard,
  corpusPathFor,
  corpusHtmlPathFor,
  corpusCaseLawPathFor,
  hasCorpusXml,
  hasCorpusHtml,
  hasCorpusCaseLaw,
  readCorpusXml,
  readCorpusHtml,
  readCorpusCaseLaw,
  sanitizeCelex,
  writeCorpusXml,
  writeCorpusHtml,
  writeCorpusCaseLaw,
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

test("HTML variant round-trips in a separate laws-html/ tree", async () => {
  await withTempDir(async (dir) => {
    const celex = "31995L0046";
    const html = "<html><body>Directive 95/46/EC</body></html>";

    assert.equal(hasCorpusHtml(dir, celex), false);
    assert.equal(await readCorpusHtml(dir, celex), null);

    assert.equal(await writeCorpusHtml(dir, celex, html), true);
    assert.equal(hasCorpusHtml(dir, celex), true);
    assert.equal(await readCorpusHtml(dir, celex), html);

    // HTML lives under laws-html/, XML under laws/ — separate trees.
    assert.match(corpusHtmlPathFor(dir, celex), /\/laws-html\/1995\/31995L0046\.html\.gz$/);
    assert.match(corpusPathFor(dir, celex), /\/laws\/1995\/31995L0046\.xml\.gz$/);
    // Writing HTML must not create an XML entry (and vice versa).
    assert.equal(hasCorpusXml(dir, celex), false);
  });
});

test("case-law variant round-trips in a separate case-law/ tree keyed by judgment CELEX", async () => {
  await withTempDir(async (dir) => {
    const celex = "62017CJ0673"; // Planet49
    const html = "<html><body>Judgment of the Court</body></html>";

    assert.equal(hasCorpusCaseLaw(dir, celex), false);
    assert.equal(await readCorpusCaseLaw(dir, celex), null);

    assert.equal(await writeCorpusCaseLaw(dir, celex, html), true);
    assert.equal(hasCorpusCaseLaw(dir, celex), true);
    assert.equal(await readCorpusCaseLaw(dir, celex), html);

    // Judgments shard on the same 4-digit year group and live under case-law/.
    assert.match(corpusCaseLawPathFor(dir, celex), /\/case-law\/2017\/62017CJ0673\.html\.gz$/);
    // Isolated from the act trees.
    assert.equal(hasCorpusHtml(dir, celex), false);
    assert.equal(hasCorpusXml(dir, celex), false);
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
