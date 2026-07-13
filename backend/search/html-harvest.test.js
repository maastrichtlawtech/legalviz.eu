const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const { harvestHtml, isEmptyShellHtml } = require("./html-harvest");
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

test("isEmptyShellHtml flags 'does not exist' chrome but keeps real content", () => {
  // The EUR-Lex 200 shell for acts with no HTML rendition.
  const shell = '<html><head><title>The requested document does not exist. - EUR-Lex</title></head>'
    + '<body><footer class="ecl-site-footer__list-item">links</footer></body></html>';
  assert.equal(isEmptyShellHtml(shell), true);

  // A real (old) act: the shell phrase is absent, content container present.
  const real = '<html><body><div id="TexteOnly"><TXT_TE><p>Article 1</p></TXT_TE></div></body></html>';
  assert.equal(isEmptyShellHtml(real), false);

  // Guard: even if the phrase somehow co-occurs with real content, keep it.
  const both = '<html><body>The requested document does not exist.'
    + '<div id="TexteOnly"><TXT_TE><p>x</p></TXT_TE></div></body></html>';
  assert.equal(isEmptyShellHtml(both), false);

  assert.equal(isEmptyShellHtml(""), false);
});

test("harvestHtml records a chrome-only shell as a miss, not a save", async () => {
  await withTempDir(async (dir) => {
    const targetsPath = path.join(dir, "targets.txt");
    const statePath = path.join(dir, "state.json");
    fs.writeFileSync(targetsPath, ["31956D0006", "31995L0046"].join("\n"));

    const fetchLawImpl = async ({ celex }) => {
      if (celex === "31956D0006") {
        return { celex, rawHtml: "<html><title>The requested document does not exist. - EUR-Lex</title><body>chrome</body></html>" };
      }
      return { celex, rawHtml: '<div id="TexteOnly"><TXT_TE><p>Article 1</p></TXT_TE></div>' };
    };

    const r = await harvestHtml({ targets: targetsPath, statePath, corpusDir: dir, delayMs: 0, fetchLawImpl });
    assert.equal(r.saved, 1);
    assert.equal(r.missing, 1);
    assert.equal(hasCorpusHtml(dir, "31956D0006"), false);
    assert.equal(hasCorpusHtml(dir, "31995L0046"), true);
    assert.match(fs.readFileSync(`${statePath}.misses.txt`, "utf8"), /31956D0006/);
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
