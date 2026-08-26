"use strict";

const { Worker } = require("worker_threads");

/**
 * Creates a small pool of workers that stay alive until close(). A worker is
 * only given one message at a time, which lets callers keep a large result
 * (and its structured-clone cost) bounded per worker while still making the
 * pool useful for both one-shot build queues and serving requests.
 */
function createWorkerPool({
  poolSize = 1,
  workerFactory,
} = {}) {
  if (!Number.isInteger(poolSize) || poolSize < 1) {
    throw new Error(`Worker pool size must be a positive integer, got ${poolSize}`);
  }
  if (typeof workerFactory !== "function") {
    throw new Error("Worker pool requires a workerFactory");
  }

  const workers = new Set();
  const queue = [];
  let closed = false;
  let closePromise = null;

  function rejectQueued(error) {
    while (queue.length) queue.shift().reject(error);
  }

  function attachWorker(thread) {
    const record = { thread, job: null, dead: false };
    workers.add(record);

    thread.on("message", (message) => {
      const job = record.job;
      if (!job || record.dead) return;

      // Keep the worker occupied until the result callback has completed. The
      // full-text builder relies on this to keep its parent-side SQLite insert
      // serialized even when several workers finish close together.
      Promise.resolve()
        .then(() => job.onResult?.(message, job.payload, thread))
        .then(() => {
          if (record.job !== job) return;
          record.job = null;
          job.resolve(message);
          dispatch();
        })
        .catch((error) => {
          if (record.job !== job) return;
          record.job = null;
          job.reject(error);
          dispatch();
        });
    });

    thread.on("error", (error) => handleWorkerLoss(record, error));
    thread.on("exit", (code) => {
      if (!record.dead) {
        handleWorkerLoss(record, new Error(`Worker exited with code ${code}`));
      }
    });
    return record;
  }

  function startWorker() {
    return attachWorker(workerFactory());
  }

  function ensureWorkers() {
    while (!closed && workers.size < poolSize) {
      try {
        startWorker();
      } catch (error) {
        // A factory failure is handled by run()'s no-workers path. If another
        // worker is healthy, it can still drain the queue and the next run can
        // retry starting the missing slot.
        if (workers.size === 0) throw error;
        break;
      }
    }
  }

  function handleWorkerLoss(record, error) {
    if (record.dead) return;
    record.dead = true;
    workers.delete(record);
    const job = record.job;
    record.job = null;
    if (job) job.reject(error);

    if (closed) return;
    try {
      ensureWorkers();
    } catch (startError) {
      rejectQueued(startError);
    }
    dispatch();
  }

  function dispatch() {
    if (closed) return;
    for (const record of workers) {
      if (record.dead || record.job || queue.length === 0) continue;
      const job = queue.shift();
      record.job = job;
      try {
        record.thread.postMessage(job.payload);
      } catch (error) {
        record.job = null;
        job.reject(error);
        queueMicrotask(dispatch);
      }
    }
  }

  function run(payload, { onResult } = {}) {
    return new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error("Worker pool is closed"));
        return;
      }
      queue.push({ payload, onResult, resolve, reject });
      try {
        ensureWorkers();
      } catch (error) {
        rejectQueued(error);
        return;
      }
      if (workers.size === 0) {
        rejectQueued(new Error("Worker pool could not start a worker"));
        return;
      }
      dispatch();
    });
  }

  async function close() {
    if (closePromise) return closePromise;
    closed = true;
    rejectQueued(new Error("Worker pool closed"));
    const active = [...workers];
    for (const record of active) {
      record.dead = true;
      workers.delete(record);
      const job = record.job;
      record.job = null;
      if (job) job.reject(new Error("Worker pool closed"));
    }
    closePromise = Promise.allSettled(active.map(({ thread }) => thread.terminate())).then(() => undefined);
    return closePromise;
  }

  return { close, run };
}

/**
 * Run a queue of batches through a persistent worker pool, closing the pool
 * after the queue drains. A failed batch is bisected until a size-one batch
 * can be reported through onWorkerFailure. This is the shared build-side
 * runner; serving callers use createWorkerPool directly so their workers live
 * across requests instead of being torn down after one queue.
 */
async function runPool(initialBatches, onResult, options = {}) {
  const poolSize = options.poolSize || 1;
  const workerHeapMb = options.workerHeapMb;
  const workerFactory = options.spawnWorker || (() => {
    if (!options.workerPath) throw new Error("Worker pool requires workerPath or spawnWorker");
    return new Worker(options.workerPath, {
      workerData: options.workerData,
      resourceLimits: workerHeapMb ? { maxOldGenerationSizeMb: workerHeapMb } : undefined,
    });
  });
  const totals = { ...(options.initialTotals || {}) };
  const pool = createWorkerPool({ poolSize, workerFactory });
  const onProgress = options.onProgress || (() => {});

  function handleResult(shard, batch) {
    const startedAt = process.hrtime.bigint();
    onResult(shard, batch);
    const callbackMs = Number((process.hrtime.bigint() - startedAt) / 1000000n);
    options.accumulate?.(totals, shard, { callbackMs });
    onProgress(totals);
  }

  async function processBatch(batch) {
    try {
      await pool.run(batch, {
        onResult: (shard, payload) => handleResult(shard, payload),
      });
    } catch (error) {
      if (batch.length > 1) {
        const mid = Math.floor(batch.length / 2);
        await Promise.all([
          processBatch(batch.slice(0, mid)),
          processBatch(batch.slice(mid)),
        ]);
      } else if (typeof options.onWorkerFailure === "function") {
        await options.onWorkerFailure(totals, batch, error);
      } else {
        throw error;
      }
    }
  }

  try {
    await Promise.all(initialBatches.map((batch) => processBatch(batch)));
    return totals;
  } finally {
    await pool.close();
  }
}

module.exports = { createWorkerPool, runPool };
