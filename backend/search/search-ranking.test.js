const test = require("node:test");
const assert = require("node:assert/strict");

const { determineMatchReason, enrichSearchRecord, parseStructuredQuery } = require("./search-ranking");

test("determineMatchReason treats Law Enforcement Directive aliases as exact matches", () => {
  const law = enrichSearchRecord({
    celex: "32016L0680",
    title: "Directive (EU) 2016/680 of the European Parliament and of the Council of 27 April 2016 on the protection of natural persons with regard to the processing of personal data by competent authorities for the purposes of the prevention, investigation, detection or prosecution of criminal offences or the execution of criminal penalties, and on the free movement of such data",
    type: "directive",
    date: "2016-04-27",
    eli: "http://data.europa.eu/eli/dir/2016/680/oj",
    fmxAvailable: true,
    fmxUnavailable: false,
  });

  for (const query of ["law enforcement directive", "led", "police directive"]) {
    const parsed = parseStructuredQuery(query);
    assert.equal(determineMatchReason(law, parsed), "alias_exact", `Expected alias_exact for ${query}`);
  }
});

test("enrichSearchRecord falls back to the CELEX year when no date is present", () => {
  const record = enrichSearchRecord({
    celex: "31998L0034",
    title: "Directive 98/34/EC",
    type: "directive",
    date: null,
    eli: "http://data.europa.eu/eli/dir/1998/34/oj",
  });
  assert.equal(record.date, "1998");
});

test("enrichSearchRecord keeps a precise ISO date when one is present", () => {
  const record = enrichSearchRecord({
    celex: "32016L0680",
    title: "Directive (EU) 2016/680",
    type: "directive",
    date: "2016-04-27",
    eli: "http://data.europa.eu/eli/dir/2016/680/oj",
  });
  assert.equal(record.date, "2016-04-27");
});
