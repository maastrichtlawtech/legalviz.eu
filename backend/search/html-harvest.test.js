const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const { harvestHtml } = require("./html-harvest");
const { hasCorpusHtml, readCorpusHtml } = require("./law-corpus-store");

async function withTempDir(run) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "html-harvest-test-"));
  try { await run(dir); } finally { await fsp.rm(dir, { recursive: true, force: true }); }
}

class NotFound extends Error {
  constructor(msg) { super(msg); this.code = "law_not_found"; }
}

test("harvestHtml saves HTML, records 404 misses and transient fails, then resumes", async () => {
  await withTempDir(async (dir) => {
    const targetsPath = path.join(dir, "targets.txt");
    const statePath = path.join(dir, "state.json");
    fs.writeFileSync(targetsPath, ["31995L0046", "31968R0259", "39999X0001", "31990L0001"].join("\n"));

    const calls = [];
    const fetchLawImpl = async ({ celex }) => {
      calls.push(celex);
      if (celex === "39999X0001") throw new NotFound("No EUR-Lex HTML law found");
      if (celex === "31990L0001") throw new Error("network reset");
      return { celex, rawHtml: `<html>${celex}</html>` };
    };

    const r1 = await harvestHtml({ targets: targetsPath, statePath, corpusDir: dir, delayMs: 0, fetchLawImpl });
    assert.equal(r1.saved, 2);
    assert.equal(r1.missing, 1);
    assert.equal(r1.failed, 1);
    assert.equal(r1.finished, true);

    assert.equal(hasCorpusHtml(dir, "31995L0046"), true);
    assert.equal(await readCorpusHtml(dir, "31968R0259"), "<html>31968R0259</html>");
    assert.equal(hasCorpusHtml(dir, "39999X0001"), false);

    // Sidecar files record what to revisit later.
    assert.match(fs.readFileSync(`${statePath}.misses.txt`, "utf8"), /39999X0001/);
    assert.match(fs.readFileSync(`${statePath}.fails.txt`, "utf8"), /31990L0001/);

    // A second pass is a no-op for already-saved acts (corpus-first skip): the
    // finished state means nothing new is fetched.
    calls.length = 0;
    const r2 = await harvestHtml({ targets: targetsPath, statePath, corpusDir: dir, delayMs: 0, fetchLawImpl });
    assert.equal(calls.length, 0, "resume from finished state fetches nothing");
    assert.equal(r2.finished, true);
  });
});

test("harvestHtml honours maxRecords and resumes from nextIndex", async () => {
  await withTempDir(async (dir) => {
    const targetsPath = path.join(dir, "targets.txt");
    const statePath = path.join(dir, "state.json");
    fs.writeFileSync(targetsPath, ["3A", "3B", "3C"].join("\n"));
    const fetchLawImpl = async ({ celex }) => ({ celex, rawHtml: `<p>${celex}</p>` });

    const r1 = await harvestHtml({ targets: targetsPath, statePath, corpusDir: dir, delayMs: 0, maxRecords: 2, fetchLawImpl });
    assert.equal(r1.nextIndex, 2);
    assert.equal(r1.finished, false);

    const r2 = await harvestHtml({ targets: targetsPath, statePath, corpusDir: dir, delayMs: 0, fetchLawImpl });
    assert.equal(r2.finished, true);
    assert.equal(r2.saved, 3);
  });
});
