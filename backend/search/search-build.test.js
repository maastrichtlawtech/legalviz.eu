const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildYearQuery,
  extractTitleFromEurlexHtml,
  harvestPrimaryActs,
  normalizeYearQueryActTypes,
  requestWithRetry,
} = require("./search-build");

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
  assert.match(query, /\/eli\/\(reg\|dir\)\/\[0-9\]\+\/\[0-9\]\+\/oj\$/);
  assert.doesNotMatch(query, /\[RLD\]/);
  assert.doesNotMatch(query, /dec/);
});

test("buildYearQuery does not couple the ELI year to the CELEX year", () => {
  // ECB decisions are adopted (CELEX-dated) one year but ELI-numbered under the
  // following year's OJ (e.g. 32014D0055 -> /eli/dec/2015/425/oj). The harvest
  // for the CELEX year must still accept these, so the ELI filter is year-agnostic.
  const query = buildYearQuery({ year: 2014, limit: 200, offset: 0 });
  assert.match(query, /\^32014\[RLD\]/);
  assert.match(query, /\/eli\/\(reg\|dir\|dec\)\/\[0-9\]\+\/\[0-9\]\+\/oj\$/);
  assert.doesNotMatch(query, /\/eli\/\([^)]+\)\/2014\//);
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
