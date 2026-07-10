const test = require("node:test");
const assert = require("node:assert/strict");

const { findFmx4Uri } = require("./search-build");

function mockCellarRdf(uris) {
  const body = uris.map((u) => `<x rdf:resource="${u}"/>`).join("");
  const original = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => body,
  });
  return () => { global.fetch = original; };
}

test("findFmx4Uri matches the pre-2016 /oj/JOL_..._R_..._NN shape (extra trailing segment)", async () => {
  const restore = mockCellarRdf([
    "http://publications.europa.eu/resource/oj/JOL_2014_002_R_0001_01.ENG.xhtml",
    "http://publications.europa.eu/resource/oj/JOL_2014_002_R_0001_01.ENG.fmx4",
  ]);
  try {
    assert.equal(
      await findFmx4Uri("32014R0004"),
      "http://publications.europa.eu/resource/oj/JOL_2014_002_R_0001_01.ENG.fmx4"
    );
  } finally { restore(); }
});

test("findFmx4Uri matches the /celex/<CELEX> FMX shape some acts use", async () => {
  const restore = mockCellarRdf([
    "http://publications.europa.eu/resource/oj/JOL_2010_001_R_0008_01.ENG.pdfa1a",
    "http://publications.europa.eu/resource/celex/32010D0001.ENG.fmx4",
  ]);
  try {
    assert.equal(
      await findFmx4Uri("32010D0001"),
      "http://publications.europa.eu/resource/celex/32010D0001.ENG.fmx4"
    );
  } finally { restore(); }
});

test("findFmx4Uri still matches the post-2016 /oj/L_<9digits> shape", async () => {
  const restore = mockCellarRdf([
    "http://publications.europa.eu/resource/oj/L_202400123.ENG.fmx4",
  ]);
  try {
    assert.equal(
      await findFmx4Uri("32024R0123"),
      "http://publications.europa.eu/resource/oj/L_202400123.ENG.fmx4"
    );
  } finally { restore(); }
});

test("findFmx4Uri swaps language when only another language's FMX exists", async () => {
  const restore = mockCellarRdf([
    "http://publications.europa.eu/resource/oj/JOL_1968_056_R_0001_004.FRA.fmx4",
  ]);
  try {
    assert.equal(
      await findFmx4Uri("31968R0259", "ENG"),
      "http://publications.europa.eu/resource/oj/JOL_1968_056_R_0001_004.ENG.fmx4"
    );
  } finally { restore(); }
});

test("findFmx4Uri throws when the act genuinely has no FMX manifestation", async () => {
  const restore = mockCellarRdf([
    "http://publications.europa.eu/resource/oj/JOL_1995_281_R_0031_006.ENG.html",
    "http://publications.europa.eu/resource/oj/JOL_1995_281_R_0031_006.ENG.pdfa1b",
  ]);
  try {
    await assert.rejects(() => findFmx4Uri("31995L0046"), /No FMX URI found/);
  } finally { restore(); }
});
