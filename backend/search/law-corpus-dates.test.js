const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  corpusDatesPath,
  mergeCorpusDates,
  normalizeCelexKey,
  readCorpusDates,
} = require("./law-corpus-dates");

async function withTempDir(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "law-dates-"));
  try {
    await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test("readCorpusDates returns {} when the manifest is absent", async () => {
  await withTempDir((dir) => {
    assert.deepEqual(readCorpusDates(dir), {});
  });
});

test("mergeCorpusDates persists CELEX -> date and reads back", async () => {
  await withTempDir(async (dir) => {
    const total = await mergeCorpusDates(dir, [
      { celex: "31998L0034", date: "1998-06-22" },
      { celex: "31968R0259", date: "1968-02-29" },
    ]);
    assert.equal(total, 2);
    assert.deepEqual(readCorpusDates(dir), {
      "31998L0034": "1998-06-22",
      "31968R0259": "1968-02-29",
    });
    assert.ok(fs.existsSync(corpusDatesPath(dir)));
  });
});

test("mergeCorpusDates normalizes CELEX keys and skips entries without a date", async () => {
  await withTempDir(async (dir) => {
    await mergeCorpusDates(dir, [
      { celex: " 31998l0034 ", date: "1998-06-22" },
      { celex: "31999L0044", date: null },
      { celex: "", date: "2000-01-01" },
    ]);
    assert.deepEqual(readCorpusDates(dir), { "31998L0034": "1998-06-22" });
    assert.equal(normalizeCelexKey(" 31998l0034 "), "31998L0034");
  });
});

test("mergeCorpusDates is additive: a null date never clobbers an existing one", async () => {
  await withTempDir(async (dir) => {
    await mergeCorpusDates(dir, [{ celex: "31998L0034", date: "1998-06-22" }]);
    await mergeCorpusDates(dir, [
      { celex: "31998L0034", date: null },
      { celex: "32016R0679", date: "2016-04-27" },
    ]);
    assert.deepEqual(readCorpusDates(dir), {
      "31998L0034": "1998-06-22",
      "32016R0679": "2016-04-27",
    });
  });
});

test("mergeCorpusDates lets a newer non-empty date win", async () => {
  await withTempDir(async (dir) => {
    // A later harvest with a corrected precise date replaces the earlier one.
    await mergeCorpusDates(dir, [{ celex: "31998L0034", date: "1998-06-20" }]);
    await mergeCorpusDates(dir, [{ celex: "31998L0034", date: "1998-06-22" }]);
    assert.deepEqual(readCorpusDates(dir), { "31998L0034": "1998-06-22" });
  });
});

test("readCorpusDates treats a corrupt manifest as empty", async () => {
  await withTempDir(async (dir) => {
    await fsp.writeFile(corpusDatesPath(dir), "{ not json", "utf8");
    assert.deepEqual(readCorpusDates(dir), {});
  });
});

test("mergeCorpusDates preserves a corrupt manifest instead of silently losing it", async () => {
  await withTempDir(async (dir) => {
    await fsp.writeFile(corpusDatesPath(dir), "{ not json", "utf8");
    await mergeCorpusDates(dir, [{ celex: "32016R0679", date: "2016-04-27" }]);
    // The rebuilt manifest holds the new batch...
    assert.deepEqual(readCorpusDates(dir), { "32016R0679": "2016-04-27" });
    // ...and the corrupt original was moved aside, not discarded.
    const salvaged = (await fsp.readdir(dir)).filter((f) => f.includes(".corrupt."));
    assert.equal(salvaged.length, 1);
  });
});
