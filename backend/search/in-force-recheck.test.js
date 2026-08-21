const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { readJournal } = require("./in-force-enrich");
const {
  assertStatusNotDegraded,
  classifyFlip,
  hasChanged,
  isExpiredButInForce,
  isRecheckable,
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

test("isRecheckable treats out-of-force as terminal and everything else as open", () => {
  assert.equal(isRecheckable({ inForce: true }), true);
  assert.equal(isRecheckable({ inForce: null }), true);
  assert.equal(isRecheckable({}), true); // predates the field
  assert.equal(isRecheckable({ inForce: false }), false);
});

test("selectRecheckSlice sweeps everything not already out of force", () => {
  const records = [
    { celex: "IN_FORCE", inForce: true, endOfValidity: null },
    { celex: "UNKNOWN", inForce: null, endOfValidity: null },
    { celex: "NO_FIELD" },
    { celex: "OUT_OF_FORCE", inForce: false, endOfValidity: "2018-05-24" },
  ];

  const slice = selectRecheckSlice(records, { today: "2026-08-20" });

  assert.deepEqual(
    new Set(slice.map((r) => r.celex)),
    new Set(["IN_FORCE", "UNKNOWN", "NO_FIELD"]),
  );
});

test("selectRecheckSlice --all also re-checks out-of-force records", () => {
  const records = [
    { celex: "IN_FORCE", inForce: true },
    { celex: "OUT_OF_FORCE", inForce: false },
  ];
  assert.equal(selectRecheckSlice(records, { all: true }).length, 2);
});

test("selectRecheckSlice orders known-wrong records first so a partial run fixes those", () => {
  const records = [
    { celex: "FINE", inForce: true, endOfValidity: "2030-01-01" },
    { celex: "EXPIRED", inForce: true, endOfValidity: "2020-01-01" },
    { celex: "UNKNOWN", inForce: null },
  ];

  const slice = selectRecheckSlice(records, { today: "2026-08-20" });

  assert.equal(slice[0].celex, "EXPIRED");
  assert.equal(slice.length, 3);
});

test("selectRecheckSlice --limit caps the sweep, keeping the known-wrong ones", () => {
  const records = [
    { celex: "FINE", inForce: true, endOfValidity: "2030-01-01" },
    { celex: "EXPIRED", inForce: true, endOfValidity: "2020-01-01" },
  ];
  const slice = selectRecheckSlice(records, { today: "2026-08-20", limit: 1 });
  assert.deepEqual(slice.map((r) => r.celex), ["EXPIRED"]);
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

test("hasChanged catches null transitions and end-of-validity corrections a flip misses", () => {
  assert.equal(hasChanged({ inForce: true, endOfValidity: null }, { inForce: true, endOfValidity: null }), false);
  assert.equal(hasChanged({ inForce: null, endOfValidity: null }, { inForce: true, endOfValidity: null }), true);
  assert.equal(hasChanged(
    { inForce: true, endOfValidity: null },
    { inForce: true, endOfValidity: "2027-01-01" },
  ), true);
});

test("runRecheck leaves an out-of-force record entirely untouched", async () => {
  const journalPath = tempJournal({});
  const stale = { celex: "STALE", inForce: true, endOfValidity: "2020-01-01" };
  const terminal = { celex: "TERMINAL", inForce: false, endOfValidity: "2018-05-24" };

  await runRecheck([stale, terminal], {
    journalPath,
    today: "2026-08-20",
    runQueryFn: async () => bindings([{ celex: { value: "STALE" }, inForceValue: { value: "0" } }]),
  });

  assert.equal(terminal.inForce, false);
  assert.equal(terminal.endOfValidity, "2018-05-24");
  assert.equal(stale.inForce, false);
});

test("runRecheck counts actual flips and changes, not the number re-queried", async () => {
  const journalPath = tempJournal({});
  const records = [
    { celex: "REPEALED", inForce: true, endOfValidity: "2020-01-01" }, // flips to false
    { celex: "STILL_TRUE", inForce: true, endOfValidity: "2020-01-01" }, // unchanged
    { celex: "GAINED", inForce: null, endOfValidity: null }, // changes, but is not a flip
  ];

  const result = await runRecheck(records, {
    journalPath,
    today: "2026-08-20",
    runQueryFn: async () => bindings([
      { celex: { value: "REPEALED" }, inForceValue: { value: "0" } },
      { celex: { value: "STILL_TRUE" }, inForceValue: { value: "1" }, endValue: { value: "2020-01-01" } },
      { celex: { value: "GAINED" }, inForceValue: { value: "1" } },
    ]),
  });

  assert.equal(result.requeried, 3);
  assert.equal(result.flipped, 1);
  assert.equal(result.flippedToRepealed, 1);
  assert.equal(result.flippedToInForce, 0);
  assert.equal(result.changed, 2);
});

test("runRecheck reports no change when every status is confirmed as-is", async () => {
  const journalPath = tempJournal({});
  const records = [{ celex: "A", inForce: true, endOfValidity: null }];

  const result = await runRecheck(records, {
    journalPath,
    today: "2026-08-20",
    runQueryFn: async () => bindings([{ celex: { value: "A" }, inForceValue: { value: "1" } }]),
  });

  assert.equal(result.changed, 0);
  assert.equal(records[0].inForce, true);
  assert.equal(records[0].endOfValidity, null);
});

test("assertStatusNotDegraded refuses a run that erased known statuses in bulk", () => {
  assert.throws(
    () => assertStatusNotDegraded({ sliceSize: 100, lostStatus: 20 }, 0.05),
    /lost a previously known status/,
  );
  // A handful of genuine retractions stays under the threshold.
  assert.equal(assertStatusNotDegraded({ sliceSize: 100, lostStatus: 2 }, 0.05), 0.02);
  assert.equal(assertStatusNotDegraded({ sliceSize: 0, lostStatus: 0 }, 0.05), 0);
});

test("runRecheck counts a status that Cellar no longer answers for as lost", async () => {
  const journalPath = tempJournal({});
  const records = [{ celex: "A", inForce: true, endOfValidity: null }];

  const result = await runRecheck(records, {
    journalPath,
    today: "2026-08-20",
    runQueryFn: async () => bindings([]),
  });

  assert.equal(result.lostStatus, 1);
  assert.throws(() => assertStatusNotDegraded(result, 0.05), /refusing to write/);
});
