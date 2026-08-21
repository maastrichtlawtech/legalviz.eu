const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const { backfillCache, readCelexIds } = require("./backfill-cache");
const { buildCelexQuery, harvestActsByCelex } = require("./search-build");

function tempCache(payload, { gzip = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-"));
  const file = path.join(dir, gzip ? "cache.json.gz" : "cache.json");
  const json = JSON.stringify(payload);
  fs.writeFileSync(file, gzip ? zlib.gzipSync(Buffer.from(json)) : json);
  return file;
}

function binding(celex, eli) {
  return { celex: { value: celex }, eli: { value: eli }, title: { value: `Title ${celex}` } };
}

// The whole point of the script: create records the sweep never made. A
// backfill that silently no-ops leaves the gap it was run to close.
test("backfillCache adds a missing record with the shipped record shape", async () => {
  const cachePath = tempCache({ count: 1, records: [{ celex: "32016R0679", eli: "http://data.europa.eu/eli/reg/2016/679/oj" }] });

  const result = await backfillCache({
    cachePath,
    celex: "32014D0055",
    corpusDir: null,
    eurovoc: false,
    inForce: false,
    harvestImpl: async () => [{
      celex: "32014D0055",
      title: "Decision (EU) 2015/425",
      date: "2014-12-15",
      eli: "http://data.europa.eu/eli/dec/2015/425/oj",
      type: "decision"
    }],
    enrichImpl: async () => {}
  });

  assert.equal(result.added, 1);
  // The release notes name the acts a refresh added, so the ids have to come
  // back with the count — rendering the *requested* list instead once claimed
  // "80,465 acts backfilled" on a release that added none.
  assert.deepEqual(result.addedIds, ["32014D0055"]);
  const written = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  assert.equal(written.count, 2);
  const added = written.records.find((r) => r.celex === "32014D0055");
  // enrichSearchRecord's derived fields must be baked in, like the swept records.
  assert.equal(added.isPrimaryAct, true);
  assert.equal(added.normalizedCelex, "32014d0055");
  assert.ok(Array.isArray(added.aliases) && added.aliases.length > 0);
});

// Re-running after a partial failure must not re-fetch what already landed.
test("backfillCache skips CELEX ids already in the cache", async () => {
  const cachePath = tempCache({ count: 1, records: [{ celex: "32014D0055" }] });
  let harvested = false;

  const result = await backfillCache({
    cachePath,
    celex: "32014D0055",
    corpusDir: null,
    eurovoc: false,
    inForce: false,
    harvestImpl: async () => { harvested = true; return []; }
  });

  assert.equal(result.added, 0);
  assert.deepEqual(result.addedIds, []);
  assert.equal(harvested, false, "must not hit the network for an id already present");
});

// The release asset is gzipped; patching it in place is the primary use.
test("backfillCache round-trips a gzipped cache", async () => {
  const cachePath = tempCache({ count: 0, records: [] }, { gzip: true });

  await backfillCache({
    cachePath,
    celex: "32014D0055",
    corpusDir: null,
    eurovoc: false,
    inForce: false,
    harvestImpl: async () => [{
      celex: "32014D0055", title: "Decision", date: "2014-12-15",
      eli: "http://data.europa.eu/eli/dec/2015/425/oj", type: "decision"
    }],
    enrichImpl: async () => {}
  });

  const written = JSON.parse(zlib.gunzipSync(fs.readFileSync(cachePath)).toString("utf8"));
  assert.equal(written.count, 1);
  assert.equal(written.records[0].celex, "32014D0055");
});

// isPrimaryAct is derived from the ELI, so a record without a primary one would
// be written but never served — drop it loudly instead.
test("backfillCache drops records that are not primary acts", async () => {
  const cachePath = tempCache({ count: 0, records: [] });

  const result = await backfillCache({
    cachePath,
    celex: "32014D0055R(01)",
    corpusDir: null,
    eurovoc: false,
    inForce: false,
    harvestImpl: async () => [{
      celex: "32014D0055R(01)", title: "Corrigendum", date: "2014-12-15",
      eli: "http://data.europa.eu/eli/dec/2015/425/oj", type: "decision"
    }],
    enrichImpl: async () => {}
  });

  assert.equal(result.added, 0);
  assert.deepEqual(result.dropped, ["32014D0055R(01)"]);
});

// Miss sidecars and issue lists carry corrigendum ids; one must not sink the batch.
test("backfillCache drops unqueryable ids and still backfills the rest", async () => {
  const cachePath = tempCache({ count: 0, records: [] });
  let queried = null;

  const result = await backfillCache({
    cachePath,
    celex: "32014D0055R(01),32014D0055",
    corpusDir: null,
    eurovoc: false,
    inForce: false,
    harvestImpl: async ({ celexIds }) => {
      queried = celexIds;
      return [{
        celex: "32014D0055", title: "Decision", date: "2014-12-15",
        eli: "http://data.europa.eu/eli/dec/2015/425/oj", type: "decision"
      }];
    },
    enrichImpl: async () => {}
  });

  assert.deepEqual(queried, ["32014D0055"], "the corrigendum id never reaches the query");
  assert.equal(result.added, 1);
  assert.deepEqual(result.dropped, ["32014D0055R(01)"]);
});

test("readCelexIds reads a list or an @file of one id per line", () => {
  assert.deepEqual(readCelexIds("32014D0055,32016D0040"), ["32014D0055", "32016D0040"]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-ids-"));
  const file = path.join(dir, "ids.txt");
  fs.writeFileSync(file, "32014D0055\n32016D0040\n\n32014D0055\n");
  assert.deepEqual(readCelexIds(`@${file}`), ["32014D0055", "32016D0040"], "dedupes");
});

// The query takes ids straight from a file; keep them out of the query body
// unless they look like CELEX ids.
test("buildCelexQuery rejects malformed ids rather than interpolating them", () => {
  assert.match(buildCelexQuery(["32014D0055"]), /VALUES \?celex \{ "32014D0055"\^\^xsd:string \}/);
  assert.throws(() => buildCelexQuery(['" } INJECT {']), /malformed CELEX id/);
});

// A work can carry several ELIs; the record must end up with the /oj one so it
// matches what the year sweep would have produced.
test("harvestActsByCelex prefers the primary /oj ELI and drops ELI-less works", async () => {
  const records = await harvestActsByCelex({
    celexIds: ["32014D0055", "31985R0140"],
    runSparqlImpl: async () => ({
      results: {
        bindings: [
          binding("32014D0055", "http://data.europa.eu/eli/dec/2015/425/oj"),
          binding("32014D0055", "http://data.europa.eu/eli/dec/2015/425/corrigendum/2015-03-11"),
          { celex: { value: "31985R0140" }, title: { value: "No ELI" } }
        ]
      }
    })
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].eli, "http://data.europa.eu/eli/dec/2015/425/oj");
});
