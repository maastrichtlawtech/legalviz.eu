const { parentPort, workerData } = require("worker_threads");
const { buildCitationGraph, createReferenceResolver } = require("./citation-graph-build");

buildCitationGraph({
  files: workerData.files,
  maxXmlBytes: workerData.maxXmlBytes,
  maxHtmlBytes: workerData.maxHtmlBytes,
  // The parent resolves the search cache once and passes the index down; only fall
  // back to loading it here if it did not (which costs a full re-index per batch).
  legalCache: workerData.resolverIndex ? createReferenceResolver(workerData.resolverIndex) : undefined,
  searchCachePath: workerData.searchCachePath,
  outputPath: null,
  htmlTreeSkipped: 0,
  caseLawData: null,
}).then((artifact) => {
  parentPort.postMessage({ ok: true, artifact });
}).catch((error) => {
  parentPort.postMessage({ ok: false, error: String(error?.stack || error?.message || error) });
});
