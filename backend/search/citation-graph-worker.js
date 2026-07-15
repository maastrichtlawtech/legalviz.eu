const { parentPort, workerData } = require("worker_threads");
const { buildCitationGraph } = require("./citation-graph-build");

buildCitationGraph({
  files: workerData.files,
  maxXmlBytes: workerData.maxXmlBytes,
  maxHtmlBytes: workerData.maxHtmlBytes,
  searchCachePath: workerData.searchCachePath,
  outputPath: null,
  htmlTreeSkipped: 0,
  caseLawData: null,
}).then((artifact) => {
  parentPort.postMessage({ ok: true, artifact });
}).catch((error) => {
  parentPort.postMessage({ ok: false, error: String(error?.stack || error?.message || error) });
});
