"use strict";

const { parentPort } = require("worker_threads");

const { parseFmxXml } = require("./fmx-parser-node");
const { parseEurlexHtmlToCombined } = require("./eurlex-html-parser");

parentPort.on("message", async ({ kind, input, lang }) => {
  try {
    const result = kind === "fmx"
      ? await parseFmxXml(input)
      : await parseEurlexHtmlToCombined(input, lang);
    parentPort.postMessage({ ok: true, result });
  } catch (error) {
    // Parser errors are sent back as data so the parent can preserve the
    // existing inline error behavior. A worker failure itself remains an
    // uncaught worker event, which the pool can replace and the serving
    // wrapper can fall back from.
    parentPort.postMessage({ ok: false, error: String(error?.stack || error?.message || error) });
  }
});
