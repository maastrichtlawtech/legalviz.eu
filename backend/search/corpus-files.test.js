const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const { isCorpusFileName, celexFromCorpusFileName, listCorpusFiles } = require("./corpus-files");

async function withCorpus(tree, run) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "legalviz-corpus-files-"));
  try {
    for (const [year, names] of Object.entries(tree)) {
      fs.mkdirSync(path.join(dir, year), { recursive: true });
      for (const name of names) fs.writeFileSync(path.join(dir, year, name), "x");
    }
    await run(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test("isCorpusFileName accepts a CELEX file and rejects dotfiles", () => {
  assert.equal(isCorpusFileName("32016R0679.xml.gz", ".xml.gz"), true);
  assert.equal(isCorpusFileName("62019CJ0311.html.gz", ".html.gz"), true);
  // The AppleDouble sidecar that has ridden along in every corpus release.
  assert.equal(isCorpusFileName("._32016R0679.xml.gz", ".xml.gz"), false);
  assert.equal(isCorpusFileName("._62019CJ0311.html.gz", ".html.gz"), false);
  assert.equal(isCorpusFileName(".DS_Store", ".xml.gz"), false);
  // Wrong extension, and a name that is nothing but the extension.
  assert.equal(isCorpusFileName("32016R0679.html.gz", ".xml.gz"), false);
  assert.equal(isCorpusFileName(".xml.gz", ".xml.gz"), false);
  assert.equal(isCorpusFileName(undefined, ".xml.gz"), false);
});

test("celexFromCorpusFileName strips the extension", () => {
  assert.equal(celexFromCorpusFileName("32016R0679.xml.gz", ".xml.gz"), "32016R0679");
});

test("listCorpusFiles skips AppleDouble sidecars sitting beside real acts", async () => {
  await withCorpus(
    {
      2016: ["32016R0679.xml.gz", "._32016R0679.xml.gz", "32016R0680.xml.gz", "._32016R0680.xml.gz"],
      2019: ["32019R0001.xml.gz", ".DS_Store"],
    },
    (dir) => {
      const found = listCorpusFiles({ root: dir, extension: ".xml.gz" });
      assert.deepEqual(found.map((entry) => entry.celex), ["32016R0679", "32016R0680", "32019R0001"]);
      for (const entry of found) assert.equal(fs.existsSync(entry.file), true);
    },
  );
});

test("listCorpusFiles walks years in order and honours maxYearExclusive", async () => {
  await withCorpus(
    { 2019: ["32019R0002.xml.gz", "32019R0001.xml.gz"], 2020: ["32020R0001.xml.gz"], notayear: ["x.xml.gz"] },
    (dir) => {
      assert.deepEqual(
        listCorpusFiles({ root: dir, extension: ".xml.gz" }).map((e) => e.celex),
        ["32019R0001", "32019R0002", "32020R0001"],
      );
      assert.deepEqual(
        listCorpusFiles({ root: dir, extension: ".xml.gz", maxYearExclusive: 2020 }).map((e) => e.celex),
        ["32019R0001", "32019R0002"],
      );
    },
  );
});

test("listCorpusFiles returns nothing for an absent root", () => {
  assert.deepEqual(listCorpusFiles({ root: path.join(os.tmpdir(), "legalviz-no-such-corpus"), extension: ".xml.gz" }), []);
  assert.deepEqual(listCorpusFiles({ root: undefined, extension: ".xml.gz" }), []);
});
