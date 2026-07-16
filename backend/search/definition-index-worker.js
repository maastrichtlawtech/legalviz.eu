const { parentPort, workerData } = require("worker_threads");
const { buildDefinitionShard } = require("./definition-index-build");

buildDefinitionShard(workerData)
  .then((shard) => parentPort.postMessage({ ok: true, shard }))
  .catch((error) => parentPort.postMessage({ ok: false, error: String(error?.stack || error?.message || error) }));
