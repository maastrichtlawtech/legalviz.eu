const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  attachEurovocTopics,
  buildYearQuery,
  extractTitleFromEurlexHtml,
  harvestPrimaryActs,
  normalizeYearQueryActTypes,
  requestWithRetry,
} = require("./search-build");

// EuroVoc runs as the last step of the build so a finished cache is complete
// (a CELEX-keyed pass bolted on afterwards strands records silently). But
// topics are a nice-to-have riding on a multi-hour harvest, so the contract is
// best-effort: never throw away a build over them.
test("attachEurovocTopics skips enrichment when opted out", async () => {
  const records = [{ celex: "32016R0679" }];
  const logs = [];

  await attachEurovocTopics(records, { eurovoc: false }, (m) => logs.push(m));

  assert.equal(records[0].eurovoc, undefined);
  assert.match(logs.join(" "), /skipped/);
});

test("attachEurovocTopics swallows a SPARQL failure rather than failing the build", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eurovoc-build-fail-"));
  const records = [{ celex: "32016R0679" }];
  const logs = [];

  // Must resolve, not reject — a thrown error here would discard a multi-hour
  // harvest over metadata the cache can ship without.
  await attachEurovocTopics(
    records,
    {
      eurovocJournalPath: path.join(dir, "eurovoc.json"),
      eurovocRunQueryFn: async () => { throw new Error("Cellar is down"); },
    },
    (m) => logs.push(m),
  );

  assert.match(logs.join(" "), /EuroVoc enrichment failed/);
  assert.match(logs.join(" "), /Cellar is down/);
  assert.equal(records[0].eurovoc, undefined);
});

test("attachEurovocTopics is a no-op when every record already has topics", async () => {
  const records = [{ celex: "32016R0679", eurovoc: ["data protection"] }];
  const logs = [];

  await attachEurovocTopics(records, {}, (m) => logs.push(m));

  assert.deepEqual(records[0].eurovoc, ["data protection"]);
});

test("extractTitleFromEurlexHtml prefers WT.z_docTitle metadata", () => {
  const html = `
    <html>
      <head>
        <meta name="WT.z_docTitle" content="Directive (EU) 2015/2366 on payment services in the internal market" />
      </head>
      <body>
        <p id="title">Ignored fallback title</p>
      </body>
    </html>
  `;

  assert.equal(
    extractTitleFromEurlexHtml(html),
    "Directive (EU) 2015/2366 on payment services in the internal market"
  );
});

test("extractTitleFromEurlexHtml falls back to the title element in the page body", () => {
  const html = `
    <html>
      <body>
        <p id="title">
          Directive (EU) 2015/2366 of the European Parliament and of the Council
          on payment services in the internal market
        </p>
      </body>
    </html>
  `;

  assert.equal(
    extractTitleFromEurlexHtml(html),
    "Directive (EU) 2015/2366 of the European Parliament and of the Council on payment services in the internal market"
  );
});

test("buildYearQuery can target only directives and regulations", () => {
  const query = buildYearQuery({ year: 2001, limit: 200, offset: 0, actTypes: ["regulation", "directive"] });
  assert.match(query, /\^32001\[RL\]/);
  assert.match(query, /\/eli\/\(reg\|dir\)\/2001\/\[0-9\]\+\/oj\$/);
  assert.doesNotMatch(query, /\[RLD\]/);
  assert.doesNotMatch(query, /dec/);
});

test("normalizeYearQueryActTypes drops unknown values and deduplicates", () => {
  assert.deepEqual(
    normalizeYearQueryActTypes(["directive", "decision", "directive", "weird"]),
    ["directive", "decision"]
  );
});

test("harvestPrimaryActs paginates based on raw SPARQL bindings", async () => {
  const pages = [
    {
      results: {
        bindings: [
          { celex: { value: "32001D0006(01)" }, eli: { value: "http://data.europa.eu/eli/dec/2001/566/oj" } },
          { celex: { value: "32001D0011" }, eli: { value: "http://data.europa.eu/eli/dec/2001/912/oj" } },
        ],
      },
    },
    {
      results: {
        bindings: [
          { celex: { value: "32001R0045" }, eli: { value: "http://data.europa.eu/eli/reg/2001/45/oj" } },
        ],
      },
    },
  ];
  let calls = 0;
  const records = await harvestPrimaryActs({
    fromYear: 2001,
    toYear: 2001,
    limit: 2,
    runSparqlImpl: async () => pages[calls++] || { results: { bindings: [] } },
  });
  assert.equal(calls, 2);
  assert.deepEqual(records.map((record) => record.celex), ["32001D0006(01)", "32001D0011", "32001R0045"]);
});

test("requestWithRetry does not sleep after its final failed attempt", async () => {
  const originalFetch = global.fetch;
  let sleeps = 0;
  global.fetch = async () => ({
    ok: false,
    status: 503,
    headers: { get: () => null },
  });

  try {
    await assert.rejects(
      requestWithRetry("https://example.test/unavailable", {
        maxAttempts: 1,
        sleepImpl: async () => { sleeps += 1; },
      }),
      /Exhausted 1 attempts/
    );
    assert.equal(sleeps, 0);
  } finally {
    global.fetch = originalFetch;
  }
});
