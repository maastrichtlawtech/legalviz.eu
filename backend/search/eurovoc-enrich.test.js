const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildQuery,
  enrichRecordsWithEurovoc,
  parseLabels,
  readJournal,
} = require("./eurovoc-enrich");

function tempJournal(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eurovoc-enrich-"));
  const journalPath = path.join(dir, "eurovoc.json");
  if (contents !== undefined) fs.writeFileSync(journalPath, JSON.stringify(contents), "utf8");
  return journalPath;
}

// Cellar only joins VALUES against explicitly-typed xsd:string literals; a bare
// "..." silently returns nothing. Guard the typing so a refactor can't quietly
// turn every batch into an empty result.
test("buildQuery types CELEX values as xsd:string", () => {
  const query = buildQuery(["32016R0679", "31985L0374"]);
  assert.match(query, /"32016R0679"\^\^xsd:string/);
  assert.match(query, /"31985L0374"\^\^xsd:string/);
  assert.match(query, /GROUP BY \?celex/);
});

test("parseLabels splits, trims and dedupes the GROUP_CONCAT payload", () => {
  assert.deepEqual(parseLabels("data protection| personal data |data protection"), [
    "data protection",
    "personal data",
  ]);
  assert.deepEqual(parseLabels(""), []);
  assert.deepEqual(parseLabels(undefined), []);
});

test("readJournal treats a missing or corrupt journal as empty", () => {
  assert.deepEqual(readJournal(path.join(os.tmpdir(), `nope-${Date.now()}.json`)), {});

  const corrupt = tempJournal();
  fs.writeFileSync(corrupt, "{not json", "utf8");
  assert.deepEqual(readJournal(corrupt), {});

  const arrayJournal = tempJournal(["not", "an", "object"]);
  assert.deepEqual(readJournal(arrayJournal), {});
});

// The journal is what makes a rebuild cheap: labels already fetched for
// unchanged acts must not be refetched.
test("enrich fills topics from the journal without any network call", async () => {
  const journalPath = tempJournal({
    "32016R0679": ["data protection", "personal data"],
    "31985L0374": [],
  });
  const records = [
    { celex: "32016R0679" },
    { celex: "31985L0374" },
  ];

  const stats = await enrichRecordsWithEurovoc(records, { journalPath });

  assert.deepEqual(records[0].eurovoc, ["data protection", "personal data"]);
  assert.deepEqual(records[1].eurovoc, []);
  assert.equal(stats.fromJournal, 2);
  assert.equal(stats.fetched, 0);
  assert.equal(stats.withLabels, 1);
});

test("enrich leaves records that already carry topics alone", async () => {
  const journalPath = tempJournal({ "32016R0679": ["from journal"] });
  const records = [{ celex: "32016R0679", eurovoc: ["already here"] }];

  const stats = await enrichRecordsWithEurovoc(records, { journalPath });

  assert.deepEqual(records[0].eurovoc, ["already here"]);
  assert.equal(stats.alreadyPresent, 1);
  assert.equal(stats.targeted, 0);
  assert.equal(stats.fetched, 0);
});

test("enrich skips records without a CELEX rather than throwing", async () => {
  const journalPath = tempJournal({});
  const records = [{ title: "no celex here" }];

  const stats = await enrichRecordsWithEurovoc(records, { journalPath });

  assert.equal(stats.targeted, 0);
  assert.equal(stats.fetched, 0);
  assert.equal(records[0].eurovoc, undefined);
});

test("enrich is a no-op when every record is covered", async () => {
  const journalPath = tempJournal({ "32016R0679": ["x"] });
  const records = [{ celex: "32016R0679", eurovoc: ["x"] }];

  const stats = await enrichRecordsWithEurovoc(records, { journalPath });
  assert.equal(stats.fetched, 0);
  assert.equal(stats.targeted, 0);
});

function bindingsFor(map) {
  return {
    results: {
      bindings: Object.entries(map).map(([celex, labels]) => ({
        celex: { value: celex },
        labels: { value: labels.join("|") },
      })),
    },
  };
}

test("enrich writes fetched labels onto records and into the journal", async () => {
  const journalPath = tempJournal({});
  const records = [{ celex: "32016R0679" }];

  const stats = await enrichRecordsWithEurovoc(records, {
    journalPath,
    runQueryFn: async () => bindingsFor({ "32016R0679": ["data protection", "personal data"] }),
  });

  assert.deepEqual(records[0].eurovoc, ["data protection", "personal data"]);
  assert.deepEqual(readJournal(journalPath)["32016R0679"], ["data protection", "personal data"]);
  assert.equal(stats.fetched, 1);
  assert.equal(stats.withLabels, 1);
});

// An act with no EuroVoc concepts comes back absent from the results, not as an
// empty row. Journal it as [] or every rerun re-asks Cellar for the same
// non-answer — across ~12k topic-less acts that's a lot of wasted harvest.
test("enrich journals acts with no concepts as empty so reruns skip them", async () => {
  const journalPath = tempJournal({});
  const records = [{ celex: "31960R0011" }];

  await enrichRecordsWithEurovoc(records, {
    journalPath,
    runQueryFn: async () => bindingsFor({}),
  });

  assert.deepEqual(records[0].eurovoc, []);
  assert.deepEqual(readJournal(journalPath), { "31960R0011": [] });

  let called = false;
  await enrichRecordsWithEurovoc([{ celex: "31960R0011" }], {
    journalPath,
    runQueryFn: async () => { called = true; return bindingsFor({}); },
  });
  assert.equal(called, false, "rerun must not refetch a journaled empty result");
});

// A harvest is ~800 batches over a flaky public endpoint; losing everything
// gathered before a mid-run failure would make it practically unfinishable.
test("enrich flushes the journal when a batch throws mid-harvest", async () => {
  const journalPath = tempJournal({});
  const records = Array.from({ length: 150 }, (_, i) => ({ celex: `C${i}` }));
  let batch = 0;

  await assert.rejects(
    enrichRecordsWithEurovoc(records, {
      journalPath,
      runQueryFn: async (query) => {
        batch += 1;
        if (batch > 1) throw new Error("Cellar is down");
        const celexes = [...query.matchAll(/"(C\d+)"\^\^xsd:string/g)].map((m) => m[1]);
        return bindingsFor(Object.fromEntries(celexes.map((c) => [c, ["topic"]])));
      },
    }),
    /Cellar is down/,
  );

  // The first batch's 100 records survive, so a resume starts from batch 2.
  assert.equal(Object.keys(readJournal(journalPath)).length, 100);
});
