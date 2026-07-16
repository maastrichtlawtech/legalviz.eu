const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildQuery,
  enrichRecordsWithInForce,
  parseEndOfValidity,
  parseInForce,
  readJournal,
} = require("./in-force-enrich");

function tempJournal(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "in-force-enrich-"));
  const journalPath = path.join(dir, "in-force.json");
  if (contents !== undefined) fs.writeFileSync(journalPath, JSON.stringify(contents), "utf8");
  return journalPath;
}

function bindings(rows) {
  return { results: { bindings: rows } };
}

// Cellar only joins VALUES against explicitly-typed xsd:string literals; a bare
// "..." silently returns nothing. Guard the typing so a refactor can't quietly
// turn every batch into an empty result.
test("buildQuery types CELEX values as xsd:string and aggregates per CELEX", () => {
  const query = buildQuery(["32016R0679", "31995L0046"]);
  assert.match(query, /"32016R0679"\^\^xsd:string/);
  assert.match(query, /"31995L0046"\^\^xsd:string/);
  assert.match(query, /GROUP BY \?celex/);
});

// entry-into-force is multi-valued (the GDPR has two), so joining it fans each
// act out into duplicate rows. It must stay out of the query.
test("buildQuery does not join the multi-valued entry-into-force property", () => {
  assert.doesNotMatch(buildQuery(["32016R0679"]), /entry-into-force/);
});

test("parseInForce maps Cellar's boolean literal, and refuses to guess", () => {
  assert.equal(parseInForce("1"), true);
  assert.equal(parseInForce("0"), false);
  assert.equal(parseInForce(undefined), null);
  assert.equal(parseInForce(""), null);
  // A shape change upstream must surface as "unknown", never as a default.
  assert.equal(parseInForce("yes"), null);
});

// 9999-12-31 is a sentinel meaning "no end of validity". Letting it through
// would render the year 9999 in the UI.
test("parseEndOfValidity normalises the 9999 sentinel to null", () => {
  assert.equal(parseEndOfValidity("9999-12-31"), null);
  assert.equal(parseEndOfValidity("9999-12-31T00:00:00"), null);
  assert.equal(parseEndOfValidity("2018-05-24"), "2018-05-24");
  assert.equal(parseEndOfValidity(""), null);
  assert.equal(parseEndOfValidity(undefined), null);
  assert.equal(parseEndOfValidity("not-a-date"), null);
});

test("readJournal treats a missing or corrupt journal as empty", () => {
  assert.deepEqual(readJournal(path.join(os.tmpdir(), `nope-${Date.now()}.json`)), {});

  const corrupt = tempJournal();
  fs.writeFileSync(corrupt, "{not json", "utf8");
  assert.deepEqual(readJournal(corrupt), {});

  assert.deepEqual(readJournal(tempJournal(["not", "an", "object"])), {});
});

// The journal is what makes a rebuild cheap: status already fetched for
// unchanged acts must not be refetched.
test("enrich fills status from the journal without any network call", async () => {
  const journalPath = tempJournal({
    "32016R0679": { inForce: true, endOfValidity: null },
    "31995L0046": { inForce: false, endOfValidity: "2018-05-24" },
  });
  const records = [{ celex: "32016R0679" }, { celex: "31995L0046" }];

  const stats = await enrichRecordsWithInForce(records, {
    journalPath,
    runQueryFn: () => assert.fail("must not hit the network"),
  });

  assert.equal(records[0].inForce, true);
  assert.equal(records[0].endOfValidity, null);
  assert.equal(records[1].inForce, false);
  assert.equal(records[1].endOfValidity, "2018-05-24");
  assert.equal(stats.fromJournal, 2);
  assert.equal(stats.fetched, 0);
  assert.equal(stats.withStatus, 2);
  assert.equal(stats.inForce, 1);
});

test("enrich writes status from a SPARQL response and journals it", async () => {
  const journalPath = tempJournal();
  const records = [{ celex: "32016R0679" }, { celex: "31995L0046" }];

  const stats = await enrichRecordsWithInForce(records, {
    journalPath,
    runQueryFn: async () => bindings([
      { celex: { value: "32016R0679" }, inForce: { value: "1" }, endOfValidity: { value: "9999-12-31" } },
      { celex: { value: "31995L0046" }, inForce: { value: "0" }, endOfValidity: { value: "2018-05-24" } },
    ]),
  });

  assert.equal(records[0].inForce, true);
  assert.equal(records[0].endOfValidity, null);
  assert.equal(records[1].inForce, false);
  assert.equal(records[1].endOfValidity, "2018-05-24");
  assert.equal(stats.fetched, 2);
  assert.equal(stats.inForce, 1);
  assert.deepEqual(readJournal(journalPath)["31995L0046"], {
    inForce: false,
    endOfValidity: "2018-05-24",
  });
});

// An act Cellar returns nothing for is "unknown", not "not in force" — the UI
// draws no badge rather than asserting an act is dead.
test("enrich records an unanswered CELEX as unknown, not as out of force", async () => {
  const journalPath = tempJournal();
  const records = [{ celex: "31957E0001" }];

  await enrichRecordsWithInForce(records, {
    journalPath,
    runQueryFn: async () => bindings([]),
  });

  assert.equal(records[0].inForce, null);
  assert.equal(records[0].endOfValidity, null);
  // Journaled, so a rerun doesn't re-ask for an answer Cellar already withheld.
  assert.deepEqual(readJournal(journalPath)["31957E0001"], { inForce: null, endOfValidity: null });
});

test("enrich skips records that already carry a status, including a known-false one", async () => {
  const journalPath = tempJournal();
  const records = [
    { celex: "32016R0679", inForce: true, endOfValidity: null },
    { celex: "31995L0046", inForce: false, endOfValidity: "2018-05-24" },
    // null is a real answer ("Cellar has no status"), not a gap to refill.
    { celex: "31957E0001", inForce: null, endOfValidity: null },
  ];

  const stats = await enrichRecordsWithInForce(records, {
    journalPath,
    runQueryFn: () => assert.fail("must not refetch known status"),
  });

  assert.equal(stats.alreadyPresent, 3);
  assert.equal(stats.targeted, 0);
});

test("enrich honours --limit for smoke tests", async () => {
  const journalPath = tempJournal();
  const records = [{ celex: "32016R0679" }, { celex: "31995L0046" }];
  let queries = 0;

  await enrichRecordsWithInForce(records, {
    journalPath,
    limit: 1,
    runQueryFn: async () => {
      queries += 1;
      return bindings([{ celex: { value: "32016R0679" }, inForce: { value: "1" } }]);
    },
  });

  assert.equal(queries, 1);
  assert.equal(records[0].inForce, true);
  assert.equal(records[1].inForce, undefined);
});

// A Cellar outage mid-run must not throw away the batches that did land: the
// caller retries and resumes from the journal.
test("enrich flushes the journal even when a batch throws", async () => {
  const journalPath = tempJournal();
  const records = Array.from({ length: 150 }, (_, i) => ({ celex: `3202${i}R000${i}` }));
  let calls = 0;

  await assert.rejects(
    enrichRecordsWithInForce(records, {
      journalPath,
      saveEvery: 1000, // never hit — proves the flush comes from the finally block
      runQueryFn: async (query) => {
        calls += 1;
        if (calls > 1) throw new Error("Cellar down");
        const celex = query.match(/"(3202\dR000\d)"/)[1];
        return bindings([{ celex: { value: celex }, inForce: { value: "1" } }]);
      },
    }),
    /Cellar down/,
  );

  assert.equal(Object.keys(readJournal(journalPath)).length, 100);
});
