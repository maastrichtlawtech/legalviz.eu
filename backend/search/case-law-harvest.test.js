const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const { harvestHtml } = require("./html-harvest");
const { hasCorpusCaseLaw, hasCorpusHtml, readCorpusCaseLaw } = require("./law-corpus-store");
const { discoverCaseLawTargets, buildPageQuery } = require("./case-law-discover");

async function withTempDir(run) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "legalviz-caselaw-test-"));
  try {
    await run(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test("harvestHtml with variant caselaw writes judgment HTML into the case-law/ tree", async () => {
  await withTempDir(async (dir) => {
    const targetsPath = path.join(dir, "targets.txt");
    const statePath = path.join(dir, "state.json");
    fs.writeFileSync(targetsPath, "62017CJ0673\n62019CJ0311\n", "utf8");

    const fetchLawImpl = async ({ celex }) => ({
      celex,
      rawHtml: `<html><body>Judgment ${celex} interprets Article 5</body></html>`,
    });

    const r = await harvestHtml({
      variant: "caselaw",
      targets: targetsPath,
      statePath,
      corpusDir: dir,
      delayMs: 0,
      fetchLawImpl,
    });

    assert.equal(r.saved, 2);
    assert.equal(r.finished, true);
    // Written to the case-law/ tree, NOT the laws-html/ tree.
    assert.equal(hasCorpusCaseLaw(dir, "62017CJ0673"), true);
    assert.equal(hasCorpusHtml(dir, "62017CJ0673"), false);
    assert.match(await readCorpusCaseLaw(dir, "62017CJ0673"), /interprets Article 5/);
  });
});

test("harvestHtml caselaw is corpus-first: a fresh pass over a populated corpus re-fetches nothing", async () => {
  await withTempDir(async (dir) => {
    const targetsPath = path.join(dir, "targets.txt");
    fs.writeFileSync(targetsPath, "62017CJ0673\n62019CJ0311\n", "utf8");
    let calls = 0;
    const fetchLawImpl = async ({ celex }) => {
      calls += 1;
      return { celex, rawHtml: `<html><body>${celex}</body></html>` };
    };

    await harvestHtml({ variant: "caselaw", targets: targetsPath, statePath: path.join(dir, "s1.json"), corpusDir: dir, delayMs: 0, fetchLawImpl });
    assert.equal(calls, 2);
    // Fresh state over the now-populated corpus: walks all targets, finds each
    // already stored, fetches none.
    const r2 = await harvestHtml({ variant: "caselaw", targets: targetsPath, statePath: path.join(dir, "s2.json"), corpusDir: dir, delayMs: 0, fetchLawImpl });
    assert.equal(calls, 2);
    assert.equal(r2.skipped, 2);
    assert.equal(r2.saved, 0);
  });
});

test("discoverCaseLawTargets pages, de-dupes, sorts and writes the targets file", async () => {
  await withTempDir(async (dir) => {
    const outPath = path.join(dir, "case-law-targets.txt");
    // Two full pages then a short page => stops. Include a duplicate across pages.
    const pages = [
      ["62019CJ0311", "62017CJ0673"],
      ["62017CJ0673", "62001CJ0101"],
      [],
    ];
    let call = 0;
    const runSparqlQuery = async () => {
      const rows = (pages[call] || []).map((c) => ({ c: { value: c } }));
      call += 1;
      return { results: { bindings: rows } };
    };

    const ids = await discoverCaseLawTargets({ outPath, pageSize: 2, runSparqlQuery, log: () => {} });

    assert.deepEqual(ids, ["62001CJ0101", "62017CJ0673", "62019CJ0311"]);
    assert.equal(fs.readFileSync(outPath, "utf8"), "62001CJ0101\n62017CJ0673\n62019CJ0311\n");
  });
});

test("buildPageQuery filters to CJ/TJ judgments that interpret a legal resource", () => {
  const q = buildPageQuery(2000, 4000);
  assert.match(q, /case-law_interpretes_resource_legal/);
  assert.match(q, /\^6\[0-9\]\{4\}\(CJ\|TJ\)\[0-9\]/);
  assert.match(q, /LIMIT 2000 OFFSET 4000/);
});
