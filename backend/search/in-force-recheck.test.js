const test = require("node:test");
const assert = require("node:assert/strict");

const {
  assertStatusNotDegraded,
  classifyFlip,
  hasChanged,
  runRecheck,
} = require("./in-force-recheck");

function bindings(rows) {
  return { results: { bindings: rows } };
}

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
  assert.equal(hasChanged(
    { inForce: true, endOfValidity: null, entryIntoForce: null, eea: true },
    { inForce: true, endOfValidity: null, entryIntoForce: null, eea: false },
  ), true);
});

// An act is harvested when published, normally before it enters into force, so
// Cellar answers "0" and the cache records it. Skipping `inForce: false` would
// strand exactly the newest legislation permanently mislabelled — 13 acts in
// data-v12 had already made that transition unnoticed.
test("runRecheck re-checks out-of-force acts too, so one entering into force is caught", async () => {
  const notYetInForce = { celex: "NEW", inForce: false, endOfValidity: null };
  const inForce = { celex: "OLD", inForce: true, endOfValidity: null };

  const asked = [];
  const result = await runRecheck([notYetInForce, inForce], {
    runQueryFn: async (query) => {
      asked.push(query);
      return bindings([
        { celex: { value: "NEW" }, inForceValue: { value: "1" } },
        { celex: { value: "OLD" }, inForceValue: { value: "1" } },
      ]);
    },
  });

  assert.equal(result.rechecked, 2);
  assert.match(asked.join(""), /NEW/);
  assert.equal(notYetInForce.inForce, true);
  assert.equal(result.flippedToInForce, 1);
});

test("runRecheck counts actual flips and changes, not the number re-queried", async () => {
  const records = [
    { celex: "REPEALED", inForce: true, endOfValidity: "2020-01-01", entryIntoForce: "2000-01-01", eea: false }, // flips to false
    { celex: "STILL_TRUE", inForce: true, endOfValidity: "2020-01-01", entryIntoForce: "2000-01-01", eea: false }, // unchanged
    { celex: "GAINED", inForce: null, endOfValidity: null, entryIntoForce: null, eea: false }, // changes, but is not a flip
  ];

  const result = await runRecheck(records, {
    runQueryFn: async () => bindings([
      { celex: { value: "REPEALED" }, inForceValue: { value: "0" }, entryValue: { value: "2000-01-01" }, eeaValue: { value: "0" } },
      { celex: { value: "STILL_TRUE" }, inForceValue: { value: "1" }, endValue: { value: "2020-01-01" }, entryValue: { value: "2000-01-01" }, eeaValue: { value: "0" } },
      { celex: { value: "GAINED" }, inForceValue: { value: "1" }, eeaValue: { value: "0" } },
    ]),
  });

  assert.equal(result.requeried, 3);
  assert.equal(result.flipped, 1);
  assert.equal(result.flippedToRepealed, 1);
  assert.equal(result.flippedToInForce, 0);
  assert.equal(result.changed, 2);
});

test("runRecheck reports no change when every status is confirmed as-is", async () => {
  const records = [{ celex: "A", inForce: true, endOfValidity: null, entryIntoForce: "2016-05-24", eea: true }];

  const result = await runRecheck(records, {
    runQueryFn: async () => bindings([
      { celex: { value: "A" }, inForceValue: { value: "1" }, entryValue: { value: "2016-05-24" }, eeaValue: { value: "1" } },
    ]),
  });

  assert.equal(result.changed, 0);
  assert.equal(records[0].inForce, true);
  assert.equal(records[0].endOfValidity, null);
});

test("runRecheck refreshes and reports an EEA change", async () => {
  const records = [{
    celex: "A",
    inForce: true,
    endOfValidity: null,
    entryIntoForce: "2016-05-24",
    eea: true,
  }];

  const result = await runRecheck(records, {
    runQueryFn: async () => bindings([{
      celex: { value: "A" },
      inForceValue: { value: "1" },
      entryValue: { value: "2016-05-24" },
      eeaValue: { value: "0" },
    }]),
  });

  assert.equal(records[0].eea, false);
  assert.equal(result.changed, 1);
});

// A record cleared but never refilled would serialise with no `inForce` key at
// all, which is precisely what backend-docker.yml fails the build over. --limit
// must therefore bound the targets, not the enrichment.
test("runRecheck --limit leaves unre-checked records fully intact", async () => {
  const first = { celex: "FIRST", inForce: true, endOfValidity: null, entryIntoForce: "2016-05-24" };
  const second = { celex: "SECOND", inForce: true, endOfValidity: "2030-01-01", entryIntoForce: "2010-01-01" };

  const result = await runRecheck([first, second], {
    limit: 1,
    runQueryFn: async () => bindings([{ celex: { value: "FIRST" }, inForceValue: { value: "1" } }]),
  });

  assert.equal(result.rechecked, 1);
  assert.equal(second.inForce, true);
  assert.equal(second.endOfValidity, "2030-01-01");
  assert.equal(second.entryIntoForce, "2010-01-01");
  // A cleared-but-unrefilled record is what the Docker status guard fails over.
  assert.ok("inForce" in second);
  assert.ok("entryIntoForce" in second);
});

// The sweep that first ships entryIntoForce sees every record change, because
// every record gains the key. That is a real difference in the published asset,
// so it must be reported as changed and written — not hashed as a quiet month.
test("runRecheck treats a newly filled entryIntoForce as a change", async () => {
  const records = [
    { celex: "DATED", inForce: true, endOfValidity: null },
    // Cellar has no entry date for this one; it still gains an explicit null.
    { celex: "UNDATED", inForce: true, endOfValidity: null },
  ];

  const result = await runRecheck(records, {
    runQueryFn: async () => bindings([
      { celex: { value: "DATED" }, inForceValue: { value: "1" }, entryValue: { value: "2016-05-24" } },
      { celex: { value: "UNDATED" }, inForceValue: { value: "1" } },
    ]),
  });

  assert.equal(result.changed, 2);
  assert.equal(result.flipped, 0, "gaining a date is not a status flip");
  assert.equal(records[0].entryIntoForce, "2016-05-24");
  assert.equal(records[1].entryIntoForce, null);
});

test("assertStatusNotDegraded refuses a run that erased known statuses in bulk", () => {
  assert.throws(
    () => assertStatusNotDegraded({ rechecked: 100, lostStatus: 20 }, 0.05),
    /lost a previously known status/,
  );
  // A handful of genuine retractions stays under the threshold.
  assert.equal(assertStatusNotDegraded({ rechecked: 100, lostStatus: 2 }, 0.05), 0.02);
  assert.equal(assertStatusNotDegraded({ rechecked: 0, lostStatus: 0 }, 0.05), 0);
});

test("runRecheck counts a status that Cellar no longer answers for as lost", async () => {
  const records = [{ celex: "A", inForce: true, endOfValidity: null }];

  const result = await runRecheck(records, { runQueryFn: async () => bindings([]) });

  assert.equal(result.lostStatus, 1);
  assert.throws(() => assertStatusNotDegraded(result, 0.05), /refusing to write/);
});
