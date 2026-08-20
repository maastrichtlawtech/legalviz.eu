const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { readJournal } = require("./in-force-enrich");
const {
  classifyFlip,
  isExpiredButInForce,
  primeSliceForRecheck,
  runRecheck,
  selectRecheckSlice,
} = require("./in-force-recheck");

function tempJournal(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "in-force-recheck-"));
  const journalPath = path.join(dir, "in-force.json");
  if (contents !== undefined) fs.writeFileSync(journalPath, JSON.stringify(contents), "utf8");
  return journalPath;
}

function bindings(rows) {
  return { results: { bindings: rows } };
}

test("isExpiredButInForce flags an act flagged in force past its own endOfValidity", () => {
  assert.equal(isExpiredButInForce({ inForce: true, endOfValidity: "2020-01-01" }, "2026-08-20"), true);
  assert.equal(isExpiredButInForce({ inForce: true, endOfValidity: "2030-01-01" }, "2026-08-20"), false);
  assert.equal(isExpiredButInForce({ inForce: false, endOfValidity: "2020-01-01" }, "2026-08-20"), false);
  assert.equal(isExpiredButInForce({ inForce: true, endOfValidity: null }, "2026-08-20"), false);
});

test("selectRecheckSlice puts expired-but-in-force records first, ahead of the rotation", () => {
  const records = [
    { celex: "A", inForce: true, endOfValidity: "2020-01-01", statusCheckedAt: "2026-01-01T00:00:00.000Z" }, // expired, known-wrong
    { celex: "B", inForce: true, endOfValidity: "2030-01-01", statusCheckedAt: "2020-01-01T00:00:00.000Z" }, // oldest checked, not expired
    { celex: "C", inForce: false, endOfValidity: "2018-05-24" }, // never checked (predates field)
    { celex: "D", inForce: true, endOfValidity: "2030-01-01", statusCheckedAt: "2026-06-01T00:00:00.000Z" }, // freshly checked
  ];

  const slice = selectRecheckSlice(records, { batchSize: 3, today: "2026-08-20" });
  const celexes = slice.map((r) => r.celex);

  // A is expired-but-in-force: must be first regardless of its (recent) stamp.
  assert.equal(celexes[0], "A");
  // Remaining budget (2) goes to the two oldest/unstamped records, C and B,
  // ahead of the freshly-checked D.
  assert.deepEqual(new Set(celexes.slice(1)), new Set(["B", "C"]));
  assert.equal(celexes.includes("D"), false);
});

test("selectRecheckSlice includes every expired-but-in-force record even beyond batchSize", () => {
  const records = [
    { celex: "A", inForce: true, endOfValidity: "2020-01-01" },
    { celex: "B", inForce: true, endOfValidity: "2020-01-01" },
    { celex: "C", inForce: true, endOfValidity: "2030-01-01" },
  ];
  const slice = selectRecheckSlice(records, { batchSize: 1, today: "2026-08-20" });
  assert.deepEqual(new Set(slice.map((r) => r.celex)), new Set(["A", "B"]));
});

test("selectRecheckSlice --sweep returns the whole eligible set, ignoring batchSize", () => {
  const records = [{ celex: "A" }, { celex: "B" }, { celex: "C" }, { celex: "D" }];
  const slice = selectRecheckSlice(records, { batchSize: 1, sweep: true });
  assert.equal(slice.length, 4);
});

test("primeSliceForRecheck clears the record fields and drops only the slice's journal entries", () => {
  const journalPath = tempJournal({
    A: { inForce: true, endOfValidity: null },
    B: { inForce: false, endOfValidity: "2018-05-24" },
    UNRELATED: { inForce: true, endOfValidity: null },
  });
  const slice = [
    { celex: "A", inForce: true, endOfValidity: null },
    { celex: "B", inForce: false, endOfValidity: "2018-05-24" },
  ];

  const { journalEntriesDropped } = primeSliceForRecheck(slice, journalPath);

  assert.equal(journalEntriesDropped, 2);
  assert.equal(slice[0].inForce, undefined);
  assert.equal(slice[0].endOfValidity, undefined);
  assert.equal(slice[1].inForce, undefined);

  const journal = readJournal(journalPath);
  assert.equal(journal.A, undefined);
  assert.equal(journal.B, undefined);
  // The unrelated entry, for a celex outside the slice, must survive untouched.
  assert.deepEqual(journal.UNRELATED, { inForce: true, endOfValidity: null });
});

test("classifyFlip only reports true in-force <-> repealed transitions", () => {
  assert.equal(classifyFlip({ inForce: true }, { inForce: false }), "toRepealed");
  assert.equal(classifyFlip({ inForce: false }, { inForce: true }), "toInForce");
  assert.equal(classifyFlip({ inForce: true }, { inForce: true }), null);
  assert.equal(classifyFlip({ inForce: null }, { inForce: true }), null);
  assert.equal(classifyFlip({ inForce: true }, { inForce: null }), null);
});

test("runRecheck leaves a non-slice record entirely untouched", async () => {
  const journalPath = tempJournal({});
  const stale = { celex: "STALE", inForce: true, endOfValidity: "2020-01-01" }; // expired, will be selected
  const fresh = { celex: "FRESH", inForce: true, endOfValidity: "2030-01-01", statusCheckedAt: "2026-08-19T00:00:00.000Z" };
  const records = [stale, fresh];

  await runRecheck(records, {
    journalPath,
    batchSize: 1, // only room for the one expired record; FRESH must not be pulled into the rotation
    today: "2026-08-20",
    runQueryFn: async () => bindings([{ celex: { value: "STALE" }, inForce: { value: "0" } }]),
  });

  assert.equal(fresh.inForce, true);
  assert.equal(fresh.endOfValidity, "2030-01-01");
  assert.equal(fresh.statusCheckedAt, "2026-08-19T00:00:00.000Z");
});

test("runRecheck's flip counter counts actual flips, not the number re-queried", async () => {
  const journalPath = tempJournal({});
  const records = [
    { celex: "REPEALED", inForce: true, endOfValidity: "2020-01-01" }, // will flip to false
    { celex: "STILL_TRUE", inForce: true, endOfValidity: "2020-01-01" }, // stays true (Cellar disagrees with the date)
  ];

  const result = await runRecheck(records, {
    journalPath,
    batchSize: 10,
    today: "2026-08-20",
    runQueryFn: async () => bindings([
      { celex: { value: "REPEALED" }, inForce: { value: "0" } },
      { celex: { value: "STILL_TRUE" }, inForce: { value: "1" } },
    ]),
  });

  assert.equal(result.requeried, 2);
  assert.equal(result.flipped, 1);
  assert.equal(result.flippedToRepealed, 1);
  assert.equal(result.flippedToInForce, 0);
});

test("runRecheck stamps statusCheckedAt on every slice member it actually re-queried", async () => {
  const journalPath = tempJournal({});
  const records = [{ celex: "A", inForce: true, endOfValidity: "2020-01-01" }];

  await runRecheck(records, {
    journalPath,
    batchSize: 10,
    today: "2026-08-20",
    runQueryFn: async () => bindings([{ celex: { value: "A" }, inForce: { value: "1" } }]),
  });

  assert.equal(typeof records[0].statusCheckedAt, "string");
  assert.ok(!Number.isNaN(Date.parse(records[0].statusCheckedAt)));
});
