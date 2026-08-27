const { parentPort, workerData } = require("worker_threads");
const { buildCitationGraph, createReferenceResolver } = require("./citation-graph-build");

// Persistent worker: the parent's pool sends one batch per message and expects
// exactly one reply per message. Serving many batches from one process amortises
// module loading and jsdom startup (roughly a second per spawn, previously paid
// once per batch). fmx-parser-node.js recycles its DOM-shim window every
// FMX_DOM_SHIM_RECYCLE parses (default 25), but that does not cover the HTML
// fallback parser's per-act JSDOM retention; citation-graph-build.js therefore
// retires this worker before it takes another batch after its recycle interval.
const legalCache = workerData.resolverIndex
  ? createReferenceResolver(workerData.resolverIndex)
  : undefined;

parentPort.on("message", (files) => {
  buildCitationGraph({
    files,
    maxXmlBytes: workerData.maxXmlBytes,
    maxHtmlBytes: workerData.maxHtmlBytes,
    // The parent resolves the search cache once and passes the index down; only fall
    // back to loading it here if it did not (which costs a full re-index per batch).
    legalCache,
    searchCachePath: workerData.searchCachePath,
    outputPath: null,
    htmlTreeSkipped: 0,
    caseLawData: null,
  }).then((artifact) => {
    parentPort.postMessage({ ok: true, artifact });
  }).catch((error) => {
    parentPort.postMessage({ ok: false, error: String(error?.stack || error?.message || error) });
  });
});
