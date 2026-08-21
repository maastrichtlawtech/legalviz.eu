const test = require("node:test");
const assert = require("node:assert/strict");

const {
  assertStatusNotDegraded,
  classifyFlip,
  hasChanged,
  isRecheckable,
  runRecheck,
} = require("./in-force-recheck");

function bindings(rows) {
  return { results: { bindings: rows } };
}

test("isRecheckable treats out-of-force as terminal and everything else as open", () => {
  assert.equal(isRecheckable({ inForce: true }), true);
  assert.equal(isRecheckable({ inForce: null }), true);
  assert.equal(isRecheckable({}), true); // predates the field
  assert.equal(isRecheckable({ inForce: false }), false);
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

test("runRecheck re-checks everything not already out of force, and leaves the rest untouched", async () => {
  const stale = { celex: "STALE", inForce: true, endOfValidity: "2020-01-01" };
  const unknown = { celex: "UNKNOWN", inForce: null, endOfValidity: null };
  const terminal = { celex: "TERMINAL", inForce: false, endOfValidity: "2018-05-24" };

  const asked = [];
  const result = await runRecheck([stale, unknown, terminal], {
    runQueryFn: async (query) => {
      asked.push(query);
      return bindings([{ celex: { value: "STALE" }, inForceValue: { value: "0" } }]);
    },
  });

  assert.equal(result.rechecked, 2);
  assert.equal(stale.inForce, false);
  assert.equal(unknown.inForce, null);
  // The terminal record is neither cleared nor re-queried.
  assert.equal(terminal.inForce, false);
  assert.equal(terminal.endOfValidity, "2018-05-24");
  assert.doesNotMatch(asked.join(""), /TERMINAL/);
});

test("runRecheck --all re-checks the out-of-force records too", async () => {
  const terminal = { celex: "TERMINAL", inForce: false, endOfValidity: "2018-05-24" };

  const result = await runRecheck([terminal], {
    all: true,
    runQueryFn: async () => bindings([{ celex: { value: "TERMINAL" }, inForceValue: { value: "1" } }]),
  });

  assert.equal(result.rechecked, 1);
  assert.equal(result.flippedToInForce, 1);
  assert.equal(terminal.inForce, true);
});

test("runRecheck counts actual flips and changes, not the number re-queried", async () => {
  const records = [
    { celex: "REPEALED", inForce: true, endOfValidity: "2020-01-01" }, // flips to false
    { celex: "STILL_TRUE", inForce: true, endOfValidity: "2020-01-01" }, // unchanged
    { celex: "GAINED", inForce: null, endOfValidity: null }, // changes, but is not a flip
  ];

  const result = await runRecheck(records, {
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
  const records = [{ celex: "A", inForce: true, endOfValidity: null }];

  const result = await runRecheck(records, {
    runQueryFn: async () => bindings([{ celex: { value: "A" }, inForceValue: { value: "1" } }]),
  });

  assert.equal(result.changed, 0);
  assert.equal(records[0].inForce, true);
  assert.equal(records[0].endOfValidity, null);
});

// A record cleared but never refilled would serialise with no `inForce` key at
// all, which is precisely what backend-docker.yml fails the build over. --limit
// must therefore bound the targets, not the enrichment.
test("runRecheck --limit leaves unre-checked records fully intact", async () => {
  const first = { celex: "FIRST", inForce: true, endOfValidity: null };
  const second = { celex: "SECOND", inForce: true, endOfValidity: "2030-01-01" };

  const result = await runRecheck([first, second], {
    limit: 1,
    runQueryFn: async () => bindings([{ celex: { value: "FIRST" }, inForceValue: { value: "1" } }]),
  });

  assert.equal(result.rechecked, 1);
  assert.equal(second.inForce, true);
  assert.equal(second.endOfValidity, "2030-01-01");
  assert.ok("inForce" in second);
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
