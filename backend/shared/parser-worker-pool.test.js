"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { Worker } = require("node:worker_threads");

const { wrapForParsing } = require("../search/search-build");
const {
  createParserPool,
  DEFAULT_PARSER_POOL_SIZE,
  DEFAULT_PARSER_WORKER_HEAP_MB,
} = require("./parser-worker-pool");

const FIXTURE = path.join(__dirname, "__fixtures__", "corpus", "fmx-v4-2009-32009L0004.xml.gz");
const FMX = wrapForParsing(zlib.gunzipSync(fs.readFileSync(FIXTURE)).toString("utf8"));
const HTML = `<!DOCTYPE html><html lang="EN"><head>
  <meta name="DC.description" content="A test EUR-Lex law">
  </head><body><div id="TexteOnly"><TXT_TE>
    <p>Whereas:</p><p>(1) A test recital.</p><p>Article 1</p>
    <p>Scope</p><p>1. This law applies to tests.</p>
  </TXT_TE></div></body></html>`;

test("parser workers handle FMX and HTML and stay alive across requests", async () => {
  let workerStarts = 0;
  const pool = createParserPool({
    poolSize: 1,
    workerHeapMb: 256,
    spawnWorker: () => {
      workerStarts += 1;
      return new Worker(path.join(__dirname, "parser-worker.js"), {
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      });
    },
  });

  try {
    const first = await pool.parseFmxXml(FMX);
    const second = await pool.parseFmxXml(FMX);
    const html = await pool.parseEurlexHtmlToCombined(HTML, "ENG");

    assert.equal(workerStarts, 1, "the parser worker should be reused across calls");
    assert.equal(first.articles.length, second.articles.length);
    assert.equal(first.recitals.length, second.recitals.length);
    assert.ok(first.articles.length > 0);
    assert.equal(html.articles[0].article_number, "1");
  } finally {
    await pool.close();
  }
});

test("disabled parser pool uses the inline parsers", async () => {
  let fmxCalls = 0;
  let htmlCalls = 0;
  const pool = createParserPool({
    poolSize: 0,
    parseFmxXml: async () => { fmxCalls += 1; return { kind: "inline-fmx" }; },
    parseEurlexHtmlToCombined: async () => { htmlCalls += 1; return { kind: "inline-html" }; },
  });

  assert.equal(pool.enabled, false);
  assert.deepEqual(await pool.parseFmxXml("xml"), { kind: "inline-fmx" });
  assert.deepEqual(await pool.parseEurlexHtmlToCombined("html", "ENG"), { kind: "inline-html" });
  assert.equal(fmxCalls, 1);
  assert.equal(htmlCalls, 1);
  await pool.close();
});

test("worker startup failures fall back inline and eventually disable the pool", async () => {
  let inlineCalls = 0;
  let starts = 0;
  const pool = createParserPool({
    poolSize: 1,
    workerHeapMb: 256,
    spawnWorker: () => {
      starts += 1;
      throw new Error("worker unavailable");
    },
    parseFmxXml: async () => {
      inlineCalls += 1;
      return { kind: "inline" };
    },
  });

  assert.deepEqual(await pool.parseFmxXml("xml"), { kind: "inline" });
  assert.deepEqual(await pool.parseFmxXml("xml"), { kind: "inline" });
  assert.deepEqual(await pool.parseFmxXml("xml"), { kind: "inline" });
  assert.equal(inlineCalls, 3);
  assert.equal(starts, 3);
  await pool.close();
});

test("parser pool defaults retain the builder-sized worker budget", () => {
  assert.equal(DEFAULT_PARSER_POOL_SIZE, 2);
  assert.equal(DEFAULT_PARSER_WORKER_HEAP_MB, 640);
});
