const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const { auditCellarGap, defaultYearRange } = require("./cellar-gap-audit");

function tempPaths(payload, { gzip = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cellar-gap-audit-"));
  const cachePath = path.join(dir, gzip ? "search-cache.json.gz" : "search-cache.json");
  const outPath = path.join(dir, "missing.txt");
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  fs.writeFileSync(cachePath, gzip ? zlib.gzipSync(body) : body);
  return { cachePath, outPath };
}

test("audits a gzipped cache and writes de-duplicated sorted CELEX ids", async () => {
  const { cachePath, outPath } = tempPaths({
    records: [{ celex: "32025R0002" }, { celex: " 32025r0001 " }, { celex: "32025R0002" }]
  }, { gzip: true });
  let query;

  const result = await auditCellarGap({
    cachePath,
    outPath,
    fromYear: 2025,
    toYear: 2024,
    harvestImpl: async (options) => {
      query = options;
      return [{ celex: "32025r0003" }, { celex: "32025R0001" }, { celex: "32024D0002" }, { celex: "32025R0003" }];
    },
  });

  assert.deepEqual(result.missing, ["32024D0002", "32025R0003"]);
  assert.equal(fs.readFileSync(outPath, "utf8"), "32024D0002\n32025R0003\n");
  assert.deepEqual(query, { fromYear: 2025, toYear: 2024, limit: 200 });
});

test("defaults the harvest to the current and previous UTC years", async () => {
  const { cachePath, outPath } = tempPaths({ records: [] });
  const calls = [];

  await auditCellarGap({
    cachePath,
    outPath,
    now: new Date("2031-01-02T00:00:00Z"),
    harvestImpl: async (options) => { calls.push(options); return []; },
  });

  assert.deepEqual(defaultYearRange(new Date("2031-01-02T00:00:00Z")), { fromYear: 2031, toYear: 2030 });
  assert.deepEqual(calls, [{ fromYear: 2031, toYear: 2030, limit: 200 }]);
  assert.equal(fs.readFileSync(outPath, "utf8"), "");
});

test("writes an empty file when every harvested act is already cached", async () => {
  const { cachePath, outPath } = tempPaths({ records: [{ celex: "32030R0001" }] });

  const result = await auditCellarGap({
    cachePath,
    outPath,
    fromYear: 2030,
    toYear: 2029,
    harvestImpl: async () => [{ celex: "32030r0001" }, { celex: "32030R0001" }],
  });

  assert.deepEqual(result.missing, []);
  assert.equal(fs.readFileSync(outPath, "utf8"), "");
});
