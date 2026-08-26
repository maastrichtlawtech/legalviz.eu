const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const {
  DEFAULT_JOURNAL_NAME,
  dedupeXmlBlocks,
  readJournal,
  repairCorpus,
  repairCorpusAct,
  splitTopLevelBlocks,
} = require("./corpus-dedupe");
const { corpusPathFor, readCorpusXml } = require("./law-corpus-store");
const { wrapForParsing } = require("./search-build");
const { parseFmxXml } = require("../shared/fmx-parser-node");

function makeDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "corpus-dedupe-"));
}

async function seed(dataDir, celex, xml) {
  const filePath = corpusPathFor(dataDir, celex);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, zlib.gzipSync(Buffer.from(xml, "utf8")));
  return filePath;
}

const ACT = '<ACT xmlns:fmx="http://opoce"><BIB.INSTANCE><LG.DOC>EN</LG.DOC></BIB.INSTANCE>'
  + "<PREAMBLE><GR.CONSID><CONSID><NP><NO.P>(1)</NO.P><TXT>Whereas one.</TXT></NP></CONSID>"
  + "<CONSID><NP><NO.P>(2)</NO.P><TXT>Whereas two.</TXT></NP></CONSID></GR.CONSID></PREAMBLE>"
  + "<ENACTING.TERMS><ARTICLE><TI.ART>Article 1</TI.ART><PARAG><NO.PARAG>1.</NO.PARAG>"
  + "<ALINEA>Subject matter.</ALINEA></PARAG></ARTICLE></ENACTING.TERMS></ACT>";

const ANNEX_I = "<ANNEX><TITLE><TI>ANNEX I</TI></TITLE><CONTENTS><P>First annex.</P></CONTENTS></ANNEX>";
const ANNEX_II = "<ANNEX><TITLE><TI>ANNEX II</TI></TITLE><CONTENTS><P>Second annex.</P></CONTENTS></ANNEX>";
const GENERAL = "<GENERAL><BIB.INSTANCE><LG.DOC>EN</LG.DOC></BIB.INSTANCE>"
  + "<PREAMBLE><GR.CONSID><CONSID><NP><NO.P>(1)</NO.P><TXT>Legacy whereas.</TXT></NP></CONSID>"
  + "</GR.CONSID></PREAMBLE></GENERAL>";
const PUBLICATION = "<PUBLICATION><NO.OJ>119</NO.OJ></PUBLICATION>";

// --- splitTopLevelBlocks ---

test("splitTopLevelBlocks finds every top-level element and names it", () => {
  const blocks = splitTopLevelBlocks([ACT, ANNEX_I, PUBLICATION].join("\n"));
  assert.deepEqual(blocks.map((block) => block.name), ["ACT", "ANNEX", "PUBLICATION"]);
  assert.equal(blocks[1].text, ANNEX_I);
});

test("splitTopLevelBlocks does not assume the root is ACT", () => {
  // 61 corpus files are legitimately rooted at GENERAL or ANNEX, and block
  // order is not guaranteed — 32002L0083's file starts with an ANNEX.
  const blocks = splitTopLevelBlocks([ANNEX_I, GENERAL, ANNEX_II].join("\n"));
  assert.deepEqual(blocks.map((block) => block.name), ["ANNEX", "GENERAL", "ANNEX"]);
});

test("splitTopLevelBlocks skips declarations, comments and Formex's inline PIs", () => {
  // Formex uses `<?PAGE NO="2"?>` and `<?COL.PAGE?>` inside the body, and the
  // harvest only strips the first XML declaration of each fetched part.
  const xml = `<?xml version="1.0"?>\n<!-- note -->\n`
    + `<ACT><TXT><?PAGE NO="2"?>Body<?COL.PAGE?></TXT></ACT>\n<?xml version="1.0"?>\n<ANNEX/>`;
  const blocks = splitTopLevelBlocks(xml);
  assert.deepEqual(blocks.map((block) => block.name), ["ACT", "ANNEX"]);
});

test("splitTopLevelBlocks tolerates a `>` inside an attribute value", () => {
  const blocks = splitTopLevelBlocks('<ACT note="a > b"><P>x</P></ACT>');
  assert.deepEqual(blocks.map((block) => block.name), ["ACT"]);
});

test("splitTopLevelBlocks refuses documents it cannot split with certainty", () => {
  assert.equal(splitTopLevelBlocks("<ACT><P>unbalanced</ACT>"), null, "unbalanced nesting");
  assert.equal(splitTopLevelBlocks("<ACT/></ACT>"), null, "stray closing tag");
  assert.equal(splitTopLevelBlocks("<ACT/>loose text<ANNEX/>"), null, "text outside any element");
  assert.equal(splitTopLevelBlocks("<ACT><P>x</P>"), null, "never closed");
});

// --- dedupeXmlBlocks ---

test("dedupeXmlBlocks reduces N identical blocks to one", () => {
  const result = dedupeXmlBlocks([ACT, ACT, ACT].join("\n"));
  assert.equal(result.changed, true);
  assert.equal(result.blocks, 3);
  assert.equal(result.unique, 1);
  assert.equal(result.xml, ACT);
});

test("dedupeXmlBlocks compares blocks trimmed, since the repeats differ only in trailing whitespace", () => {
  const result = dedupeXmlBlocks(`${ACT}\n${ACT}   \n\n${ACT}\n`);
  assert.equal(result.unique, 1);
  assert.equal(result.xml, ACT);
});

test("dedupeXmlBlocks keeps every distinct block, in its original order", () => {
  const xml = [ANNEX_I, GENERAL, ANNEX_II].join("\n");
  const result = dedupeXmlBlocks(xml);
  assert.equal(result.changed, false);
  assert.equal(result.blocks, 3);
  assert.equal(result.unique, 3);
  assert.equal(result.xml, xml, "an already-clean document is returned byte-for-byte");
});

test("dedupeXmlBlocks de-interleaves without reordering", () => {
  const result = dedupeXmlBlocks([ACT, ANNEX_I, ACT, ANNEX_I, ACT, ANNEX_I].join("\n"));
  assert.equal(result.xml, `${ACT}\n${ANNEX_I}`);
});

test("dedupeXmlBlocks leaves a document it cannot split alone", () => {
  const xml = "<ACT><P>unbalanced</ACT>";
  const result = dedupeXmlBlocks(xml);
  assert.equal(result.skipped, true);
  assert.equal(result.changed, false);
  assert.equal(result.xml, xml);
});

test("dedupeXmlBlocks is idempotent", () => {
  const once = dedupeXmlBlocks([ACT, ACT, ANNEX_I, ANNEX_I].join("\n"));
  const twice = dedupeXmlBlocks(once.xml);
  assert.equal(twice.changed, false);
  assert.equal(twice.xml, once.xml);
});

// --- repairCorpusAct / repairCorpus ---

test("repairCorpusAct rewrites a duplicated act and leaves a clean one alone", async () => {
  const dataDir = makeDataDir();
  try {
    await seed(dataDir, "32016R0679", [ACT, ACT, ACT].join("\n"));
    await seed(dataDir, "32004L0018", [GENERAL, ANNEX_I].join("\n"));

    const repaired = await repairCorpusAct(dataDir, "32016R0679");
    assert.equal(repaired.status, "repaired");
    assert.equal(repaired.removed, 2);
    assert.equal(await readCorpusXml(dataDir, "32016R0679"), ACT);

    const cleanBytes = fs.readFileSync(corpusPathFor(dataDir, "32004L0018"));
    const clean = await repairCorpusAct(dataDir, "32004L0018");
    assert.equal(clean.status, "clean");
    assert.deepEqual(fs.readFileSync(corpusPathFor(dataDir, "32004L0018")), cleanBytes, "no-op must not rewrite the file");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("repairCorpusAct reports an unreadable file rather than throwing", async () => {
  const dataDir = makeDataDir();
  try {
    // An AppleDouble sidecar's payload: not a gzip stream. `listCorpusFiles`
    // keeps these out of the walk; this covers a genuinely corrupt act file.
    const filePath = corpusPathFor(dataDir, "31953D0004");
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, Buffer.from("\x00\x05\x16\x07not gzip"));
    assert.equal((await repairCorpusAct(dataDir, "31953D0004")).status, "unreadable");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("repairCorpus sweeps the tree, skips AppleDouble sidecars, and is idempotent", async () => {
  const dataDir = makeDataDir();
  try {
    await seed(dataDir, "32016R0679", [ACT, ACT].join("\n"));
    await seed(dataDir, "32004R1721", [ACT, ACT, ACT, ANNEX_I, ANNEX_I, ANNEX_I].join("\n"));
    await seed(dataDir, "32002L0083", [ANNEX_I, GENERAL, ANNEX_II].join("\n"));
    await seed(dataDir, "32003D0251", "<ACT><P>unbalanced</ACT>");

    // The sidecar that has broken every extension-only corpus walk in this repo.
    const sidecar = path.join(dataDir, "laws", "2016", "._32016R0679.xml.gz");
    await fsp.writeFile(sidecar, Buffer.from("\x00\x05\x16\x07"));

    const first = await repairCorpus({ dataDir });
    assert.equal(first.total, 4, "the sidecar is not walked as an act");
    assert.equal(first.scanned, 4);
    assert.equal(first.repaired, 2);
    assert.equal(first.clean, 1);
    assert.equal(first.unsplittable, 1);
    assert.deepEqual(first.unsplittableCelex, ["32003D0251"]);
    assert.equal(first.blocksRemoved, 5);
    assert.ok(first.bytesSaved > 0);

    assert.equal(await readCorpusXml(dataDir, "32016R0679"), ACT);
    assert.equal(await readCorpusXml(dataDir, "32004R1721"), `${ACT}\n${ANNEX_I}`);
    assert.equal(await readCorpusXml(dataDir, "32003D0251"), "<ACT><P>unbalanced</ACT>");

    // Resume: the journal replays as skips, and nothing is rewritten.
    const journal = readJournal(path.join(dataDir, DEFAULT_JOURNAL_NAME));
    assert.equal(journal.size, 4);
    const second = await repairCorpus({ dataDir });
    assert.equal(second.scanned, 0);
    assert.equal(second.skipped, 4);

    // Idempotent without the journal too.
    const third = await repairCorpus({ dataDir, resume: false });
    assert.equal(third.scanned, 4);
    assert.equal(third.repaired, 0);
    assert.equal(third.clean, 3);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("repairCorpus --dry-run reports what it would do and writes nothing", async () => {
  const dataDir = makeDataDir();
  try {
    await seed(dataDir, "32016R0679", [ACT, ACT].join("\n"));
    const before = fs.readFileSync(corpusPathFor(dataDir, "32016R0679"));

    const stats = await repairCorpus({ dataDir, dryRun: true });
    assert.equal(stats.repaired, 1);
    assert.deepEqual(fs.readFileSync(corpusPathFor(dataDir, "32016R0679")), before);
    assert.equal(fs.existsSync(path.join(dataDir, DEFAULT_JOURNAL_NAME)), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("repairCorpus honours --limit so a sweep can be run in slices", async () => {
  const dataDir = makeDataDir();
  try {
    await seed(dataDir, "32016R0679", [ACT, ACT].join("\n"));
    await seed(dataDir, "32017R0001", [ACT, ACT].join("\n"));
    const first = await repairCorpus({ dataDir, limit: 1 });
    assert.equal(first.scanned, 1);
    const second = await repairCorpus({ dataDir });
    assert.equal(second.skipped, 1);
    assert.equal(second.scanned, 1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// --- what the repair is for ---

test("a repaired act parses to its true unit counts, annexes included", async () => {
  const dataDir = makeDataDir();
  try {
    const duplicated = [ACT, ACT, ACT, ANNEX_I, ANNEX_I, ANNEX_I, ANNEX_II, ANNEX_II, ANNEX_II].join("\n");
    await seed(dataDir, "32004R1721", duplicated);

    const before = await parseFmxXml(wrapForParsing(duplicated));
    assert.equal(before.recitals.length, 6, "three copies of a two-recital act");
    assert.equal(before.annexes.length, 6);

    await repairCorpusAct(dataDir, "32004R1721");
    const after = await parseFmxXml(wrapForParsing(await readCorpusXml(dataDir, "32004R1721")));
    assert.equal(after.recitals.length, 2);
    assert.equal(after.articles.length, 1);
    assert.equal(after.annexes.length, 2, "sibling annexes survive the unwrap to a single ACT");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
