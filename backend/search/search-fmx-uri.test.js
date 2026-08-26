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

// --- findDownloadUrls: the build copy, and its agreement with the serving one ---
//
// `search-build.js` and `shared/fmx-service.js` each carry a `findDownloadUrls`.
// They cannot share an implementation as they stand (different fetch plumbing,
// different error types), so these tests are what stops them drifting: the build
// copy shipped without the serving copy's dedupe, and the corpus harvest wrote
// 86% of its 28,009 acts two or three times over before anyone noticed
// (issue #219).

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const { findDownloadUrls } = require("./search-build");
const { createFmxService } = require("../shared/fmx-service");

// The serving copy is created by a factory that wants a cache dir. It never
// touches FMX_DIR on the findDownloadUrls path, but give it a real one anyway.
const servingService = createFmxService({
  CELLAR_BASE: "http://publications.europa.eu/resource",
  FMX_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "fmx-service-test-")),
  STORAGE_LIMIT_MB: 10,
  TIMEOUT_MS: 5_000,
});

// Cellar mints a manifestation id per production system, so the same physical
// `.fmx4.<lang>.xml` is listed several times over under different URI prefixes.
const DUPLICATED_MANIFESTATIONS = [
  "http://publications.europa.eu/resource/cellar/abc-1/DOC_1.fmx4.L_2016119EN.01000101.xml",
  "http://publications.europa.eu/resource/oj/L_201611901.ENG.fmx4.L_2016119EN.01000101.xml",
  "http://publications.europa.eu/resource/celex/32016R0679.ENG.fmx4.L_2016119EN.01000101.xml",
];

test("findDownloadUrls returns one URL per distinct file when Cellar lists a manifestation several times", async () => {
  const restore = mockCellarRdf(DUPLICATED_MANIFESTATIONS);
  try {
    const { type, urls } = await findDownloadUrls("http://publications.europa.eu/resource/oj/L_201611901.ENG.fmx4");
    assert.equal(type, "xml");
    assert.deepEqual(urls, [DUPLICATED_MANIFESTATIONS[0]]);
  } finally { restore(); }
});

test("findDownloadUrls keeps every part of a genuinely multi-part act", async () => {
  const parts = [
    "http://publications.europa.eu/resource/cellar/abc-1/DOC_1.fmx4.L_2004134EN.01011401.xml",
    "http://publications.europa.eu/resource/oj/L_200413401.ENG.fmx4.L_2004134EN.01011401.xml",
    "http://publications.europa.eu/resource/cellar/abc-1/DOC_2.fmx4.L_2004134EN.01011402.xml",
    "http://publications.europa.eu/resource/cellar/abc-1/DOC_3.fmx4.L_2004134EN.01011403.xml",
  ];
  const restore = mockCellarRdf(parts);
  try {
    const { urls } = await findDownloadUrls("http://publications.europa.eu/resource/oj/L_200413401.ENG.fmx4");
    assert.deepEqual(urls, [parts[0], parts[2], parts[3]]);
  } finally { restore(); }
});

test("findDownloadUrls prefers a ZIP and falls back to .doc.xml", async () => {
  const zip = mockCellarRdf([
    "http://publications.europa.eu/resource/cellar/abc-1/DOC_1.fmx4.L_2016119EN.01000101.xml",
    "http://publications.europa.eu/resource/cellar/abc-1/DOC_1.zip",
  ]);
  try {
    assert.deepEqual(
      await findDownloadUrls("uri"),
      { type: "zip", urls: ["http://publications.europa.eu/resource/cellar/abc-1/DOC_1.zip"] },
    );
  } finally { zip(); }

  const doc = mockCellarRdf(["http://publications.europa.eu/resource/cellar/abc-1/L_2016119EN.01000101.doc.xml"]);
  try {
    const { type, urls } = await findDownloadUrls("uri");
    assert.equal(type, "xml");
    assert.equal(urls.length, 1);
  } finally { doc(); }
});

test("findDownloadUrls throws when nothing downloadable is listed", async () => {
  const restore = mockCellarRdf(["http://publications.europa.eu/resource/oj/L_201611901.ENG.pdfa1a"]);
  try {
    await assert.rejects(() => findDownloadUrls("uri"), /No downloadable FMX payload/);
  } finally { restore(); }
});

// The drift guard. Both real implementations, one fixture RDF, same answer.
test("the build and serving copies of findDownloadUrls agree on every fixture URI list", async () => {
  const fixtures = [
    ["duplicated manifestations of one file", DUPLICATED_MANIFESTATIONS],
    ["a multi-part act with duplicated parts", [
      "http://publications.europa.eu/resource/cellar/abc-1/DOC_1.fmx4.L_2004134EN.01011401.xml",
      "http://publications.europa.eu/resource/oj/L_200413401.ENG.fmx4.L_2004134EN.01011401.xml",
      "http://publications.europa.eu/resource/cellar/abc-1/DOC_2.fmx4.L_2004134EN.01011402.xml",
      "http://publications.europa.eu/resource/oj/L_200413401.ENG.fmx4.L_2004134EN.01011402.xml",
    ]],
    ["a single manifestation", [
      "http://publications.europa.eu/resource/cellar/abc-1/DOC_1.fmx4.L_202400123EN.01000101.xml",
    ]],
    ["a ZIP alongside the XML parts", [
      "http://publications.europa.eu/resource/cellar/abc-1/DOC_1.fmx4.L_2016119EN.01000101.xml",
      "http://publications.europa.eu/resource/cellar/abc-1/DOC_1.zip",
    ]],
    ["only a .doc.xml wrapper", [
      "http://publications.europa.eu/resource/cellar/abc-1/L_2016119EN.01000101.doc.xml",
    ]],
    ["a .doc.xml wrapper beside the act's own data file", [
      "http://publications.europa.eu/resource/cellar/abc-1/L_2016119EN.01000101.doc.xml",
      "http://publications.europa.eu/resource/cellar/abc-1/DOC_1.fmx4.L_2016119EN.01000101.xml",
    ]],
  ];

  for (const [label, uris] of fixtures) {
    const restore = mockCellarRdf(uris);
    try {
      const build = await findDownloadUrls("http://publications.europa.eu/resource/oj/L_201611901.ENG.fmx4");
      const serving = await servingService.findDownloadUrls("http://publications.europa.eu/resource/oj/L_201611901.ENG.fmx4");
      assert.deepEqual(build, serving, `build and serving findDownloadUrls disagree on: ${label}`);
    } finally { restore(); }
  }
});

test("both copies of findDownloadUrls reject an RDF with nothing downloadable", async () => {
  const restore = mockCellarRdf(["http://publications.europa.eu/resource/oj/L_201611901.ENG.pdfa1a"]);
  try {
    await assert.rejects(() => findDownloadUrls("uri"));
    await assert.rejects(() => servingService.findDownloadUrls("uri"));
  } finally { restore(); }
});
