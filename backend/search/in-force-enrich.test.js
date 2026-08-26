const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildQuery,
  reduceBindings,
  enrichRecordsWithInForce,
  isCompleteEntry,
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
test("buildQuery types CELEX values as xsd:string", () => {
  const query = buildQuery(["32016R0679", "31995L0046"]);
  assert.match(query, /"32016R0679"\^\^xsd:string/);
  assert.match(query, /"31995L0046"\^\^xsd:string/);
});

// Cellar's aggregation mis-assigns values across groups at batch scale (a real
// 100-CELEX batch returned 32006R0988's end-of-validity for 32006R1066 as well).
// The rows must come back raw and be collapsed by reduceBindings instead.
test("buildQuery does not aggregate server-side", () => {
  const query = buildQuery(["32016R0679"]);
  assert.doesNotMatch(query, /GROUP BY/);
  assert.doesNotMatch(query, /SAMPLE\(/);
  assert.doesNotMatch(query, /MIN\(/);
  assert.match(query, /SELECT \?celex \?inForceValue \?endValue/);
});

// entry-into-force is multi-valued (the GDPR has two), so joining it fans each
// act out into duplicate rows. It must stay out of the query.
// Joined deliberately, and only safe because nothing is aggregated server-side:
// the property is multi-valued, so the rows fan out and reduceBindings() picks
// the earliest. Under the old GROUP BY this was a coin flip between the dates.
test("buildQuery joins entry-into-force as an OPTIONAL, unaggregated", () => {
  const query = buildQuery(["32016R0679"]);
  assert.match(query, /OPTIONAL \{ \?work cdm:resource_legal_date_entry-into-force \?entryValue \}/);
  assert.doesNotMatch(query, /GROUP BY/);
  assert.doesNotMatch(query, /SAMPLE|MIN\(/);
});

test("buildQuery joins EEA as an OPTIONAL, unaggregated value", () => {
  const query = buildQuery(["32016R0679"]);
  assert.match(query, /SELECT \?celex \?inForceValue \?endValue \?entryValue \?eeaValue/);
  assert.match(query, /OPTIONAL \{ \?work cdm:resource_legal_eea \?eeaValue \}/);
  assert.doesNotMatch(query, /GROUP BY/);
});

test("parseInForce maps Cellar's boolean literal, and refuses to guess", () => {
  assert.equal(parseInForce("1"), true);
  assert.equal(parseInForce("true"), true);
  assert.equal(parseInForce("0"), false);
  assert.equal(parseInForce("false"), false);
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
    "32016R0679": { inForce: true, endOfValidity: null, entryIntoForce: "2016-05-24", eea: true },
    "31995L0046": { inForce: false, endOfValidity: "2018-05-24", entryIntoForce: "1995-12-13", eea: false },
  });
  const records = [{ celex: "32016R0679" }, { celex: "31995L0046" }];

  const stats = await enrichRecordsWithInForce(records, {
    journalPath,
    runQueryFn: () => assert.fail("must not hit the network"),
  });

  assert.equal(records[0].inForce, true);
  assert.equal(records[0].endOfValidity, null);
  assert.equal(records[0].entryIntoForce, "2016-05-24");
  assert.equal(records[0].eea, true);
  assert.equal(records[1].inForce, false);
  assert.equal(records[1].endOfValidity, "2018-05-24");
  assert.equal(records[1].eea, false);
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
      { celex: { value: "32016R0679" }, inForceValue: { value: "1" }, endValue: { value: "9999-12-31" }, entryValue: { value: "2016-05-24" }, eeaValue: { value: "1" } },
      { celex: { value: "31995L0046" }, inForceValue: { value: "0" }, endValue: { value: "2018-05-24" }, entryValue: { value: "1995-12-13" }, eeaValue: { value: "0" } },
    ]),
  });

  assert.equal(records[0].inForce, true);
  assert.equal(records[0].endOfValidity, null);
  assert.equal(records[0].entryIntoForce, "2016-05-24");
  assert.equal(records[0].eea, true);
  assert.equal(records[1].inForce, false);
  assert.equal(records[1].endOfValidity, "2018-05-24");
  assert.equal(records[1].entryIntoForce, "1995-12-13");
  assert.equal(records[1].eea, false);
  assert.equal(stats.fetched, 2);
  assert.equal(stats.inForce, 1);
  assert.deepEqual(readJournal(journalPath)["31995L0046"], {
    inForce: false,
    endOfValidity: "2018-05-24",
    entryIntoForce: "1995-12-13",
    eea: false,
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
  assert.equal(records[0].entryIntoForce, null);
  assert.equal(records[0].eea, false);
  // Journaled, so a rerun doesn't re-ask for an answer Cellar already withheld.
  assert.deepEqual(
    readJournal(journalPath)["31957E0001"],
    { inForce: null, endOfValidity: null, entryIntoForce: null, eea: null },
  );
});

test("enrich skips records that already carry a status, including a known-false one", async () => {
  const journalPath = tempJournal();
  const records = [
    { celex: "32016R0679", inForce: true, endOfValidity: null, entryIntoForce: "2016-05-24", eea: true },
    { celex: "31995L0046", inForce: false, endOfValidity: "2018-05-24", entryIntoForce: "1995-12-13", eea: false },
    // null is a real answer ("Cellar has no status"), not a gap to refill.
    { celex: "31957E0001", inForce: null, endOfValidity: null, entryIntoForce: null, eea: false },
  ];

  const stats = await enrichRecordsWithInForce(records, {
    journalPath,
    runQueryFn: () => assert.fail("must not refetch known status"),
  });

  assert.equal(stats.alreadyPresent, 3);
  assert.equal(stats.targeted, 0);
});

// Records and journal entries written before entryIntoForce existed carry a
// status but no entry date. Counting those as "already known" would strand the
// field on every act already in the cache — it would only ever reach acts
// harvested after the change, which is no use to the 80k already there.
test("enrich refetches a record whose status predates entryIntoForce", async () => {
  const journalPath = tempJournal({
    // Same shortfall in the journal: present, but written before the field.
    "31995L0046": { inForce: false, endOfValidity: "2018-05-24" },
  });
  const records = [
    { celex: "32016R0679", inForce: true, endOfValidity: null },
    { celex: "31995L0046", inForce: false, endOfValidity: "2018-05-24" },
  ];
  let asked = [];

  await enrichRecordsWithInForce(records, {
    journalPath,
    runQueryFn: async (query) => {
      asked = ["32016R0679", "31995L0046"].filter((celex) => query.includes(celex));
      return bindings([
        { celex: { value: "32016R0679" }, inForceValue: { value: "1" }, entryValue: { value: "2016-05-24" } },
        { celex: { value: "31995L0046" }, inForceValue: { value: "0" }, endValue: { value: "2018-05-24" }, entryValue: { value: "1995-12-13" } },
      ]);
    },
  });

  assert.deepEqual(asked, ["32016R0679", "31995L0046"], "both must be re-asked");
  assert.equal(records[0].entryIntoForce, "2016-05-24");
  assert.equal(records[1].entryIntoForce, "1995-12-13");
  // And the status they already had must survive the refill unchanged.
  assert.equal(records[0].inForce, true);
  assert.equal(records[1].inForce, false);
  assert.equal(records[1].endOfValidity, "2018-05-24");
});

test("enrich refetches a record carrying status and entryIntoForce but no eea", async () => {
  const records = [{
    celex: "32016R0679",
    inForce: true,
    endOfValidity: null,
    entryIntoForce: "2016-05-24",
  }];
  let queries = 0;

  await enrichRecordsWithInForce(records, {
    journalPath: tempJournal(),
    runQueryFn: async (query) => {
      queries += 1;
      assert.match(query, /32016R0679/);
      return bindings([{
        celex: { value: "32016R0679" },
        inForceValue: { value: "1" },
        entryValue: { value: "2016-05-24" },
        eeaValue: { value: "0" },
      }]);
    },
  });

  assert.equal(queries, 1);
  assert.equal(records[0].eea, false);
});

test("isCompleteEntry treats a journal entry predating eea as incomplete", () => {
  assert.equal(isCompleteEntry({ inForce: true, endOfValidity: null, entryIntoForce: null }), false);
  assert.equal(isCompleteEntry({ inForce: true, endOfValidity: null, entryIntoForce: null, eea: null }), true);
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
      return bindings([{ celex: { value: "32016R0679" }, inForceValue: { value: "1" } }]);
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
        return bindings([{ celex: { value: celex }, inForceValue: { value: "1" } }]);
      },
    }),
    /Cellar down/,
  );

  assert.equal(Object.keys(readJournal(journalPath)).length, 100);
});

test("reduceBindings collapses fan-out to one entry per CELEX", () => {
  const reduced = reduceBindings([
    { celex: { value: "A" }, inForceValue: { value: "1" }, endValue: { value: "2030-01-01" } },
    { celex: { value: "A" }, inForceValue: { value: "1" }, endValue: { value: "2027-06-30" } },
    { celex: { value: "B" }, inForceValue: { value: "0" } },
  ]);

  assert.equal(reduced.size, 2);
  // Earliest real end-of-validity wins, as MIN() used to do.
  assert.deepEqual(reduced.get("A"), { inForce: true, endOfValidity: "2027-06-30", entryIntoForce: null, eea: null });
  assert.deepEqual(reduced.get("B"), { inForce: false, endOfValidity: null, entryIntoForce: null, eea: null });
});

// Entry-into-force is the genuinely multi-valued one — 32026R1818 carries ten
// dates out to 2036. The earliest is when the act enters into force; the rest
// stage individual provisions and say nothing about the act as a whole.
test("reduceBindings takes the earliest of several entry-into-force dates", () => {
  const reduced = reduceBindings([
    { celex: { value: "32026R1818" }, inForceValue: { value: "0" }, entryValue: { value: "2030-07-01" } },
    { celex: { value: "32026R1818" }, inForceValue: { value: "0" }, entryValue: { value: "2026-08-30" } },
    { celex: { value: "32026R1818" }, inForceValue: { value: "0" }, entryValue: { value: "2036-08-31" } },
  ]);

  assert.equal(reduced.get("32026R1818").entryIntoForce, "2026-08-30");
});

// Cellar returns placeholders here as well as the sentinel: 32026D1296 comes
// back as 1001-01-01, which is not a date any act entered into force on.
test("reduceBindings drops placeholder and sentinel entry-into-force dates", () => {
  const reduced = reduceBindings([
    { celex: { value: "32026D1296" }, inForceValue: { value: "0" }, entryValue: { value: "1001-01-01" } },
    { celex: { value: "SENTINEL" }, inForceValue: { value: "1" }, entryValue: { value: "9999-12-31" } },
    { celex: { value: "GOOD" }, inForceValue: { value: "1" }, entryValue: { value: "2016-05-24" } },
  ]);

  assert.equal(reduced.get("32026D1296").entryIntoForce, null);
  assert.equal(reduced.get("SENTINEL").entryIntoForce, null);
  assert.equal(reduced.get("GOOD").entryIntoForce, "2016-05-24");
});

// The exact shape that made the aggregated query leak: an act whose only date is
// the sentinel must reduce to null, never to a value from another row.
test("reduceBindings keeps a sentinel-only act null and never borrows another act's date", () => {
  const reduced = reduceBindings([
    { celex: { value: "32006R0988" }, inForceValue: { value: "1" }, endValue: { value: "2020-12-31" } },
    { celex: { value: "32006R1066" }, inForceValue: { value: "1" }, endValue: { value: "9999-12-31" } },
  ]);

  assert.deepEqual(reduced.get("32006R0988"), { inForce: true, endOfValidity: "2020-12-31", entryIntoForce: null, eea: null });
  assert.deepEqual(reduced.get("32006R1066"), { inForce: true, endOfValidity: null, entryIntoForce: null, eea: null });
});

test("reduceBindings collapses EEA per CELEX without cross-act leakage", () => {
  const reduced = reduceBindings([
    // The first row is absent, so the later non-null value is used for A.
    { celex: { value: "A" }, eeaValue: undefined },
    { celex: { value: "A" }, eeaValue: { value: "true" } },
    // B has an explicit false; a neighbouring true must not overwrite it.
    { celex: { value: "B" }, eeaValue: { value: "0" } },
    { celex: { value: "B" }, eeaValue: { value: "1" } },
    // C has no EEA value of its own and must remain internally unknown.
    { celex: { value: "C" } },
  ]);

  assert.equal(reduced.get("A").eea, true);
  assert.equal(reduced.get("B").eea, false);
  assert.equal(reduced.get("C").eea, null);
});

test("reduceBindings ignores rows without a celex", () => {
  assert.equal(reduceBindings([{ inForceValue: { value: "1" } }]).size, 0);
  assert.equal(reduceBindings(undefined).size, 0);
});

// The re-check writes its cache once at the end, so it has nothing to resume
// from; journalling would only rewrite a 30k-entry file every few batches.
test("enrich with useJournal false neither reads nor writes the journal", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "in-force-nojournal-"));
  const journalPath = path.join(dir, "in-force.json");
  fs.writeFileSync(journalPath, JSON.stringify({ A: { inForce: false, endOfValidity: null } }), "utf8");

  const records = [{ celex: "A" }];
  const stats = await enrichRecordsWithInForce(records, {
    journalPath,
    useJournal: false,
    runQueryFn: async () => ({
      results: { bindings: [{ celex: { value: "A" }, inForceValue: { value: "1" } }] },
    }),
  });

  // The on-disk answer was ignored in favour of a fresh query...
  assert.equal(stats.fromJournal, 0);
  assert.equal(stats.fetched, 1);
  assert.equal(records[0].inForce, true);
  // ...and the file is left exactly as it was.
  assert.deepEqual(
    JSON.parse(fs.readFileSync(journalPath, "utf8")),
    { A: { inForce: false, endOfValidity: null } },
  );
});
