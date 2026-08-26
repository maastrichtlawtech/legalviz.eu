"use strict";

const { Worker } = require("worker_threads");

// Five minutes covers a worst-case fulltext batch: the builder permits up to
// 6 MiB FMX / 4 MiB HTML per act, batches 20 acts by default, and gives each
// parser worker 640 MiB for jsdom. That is deliberately well above the
// observed ~38 seconds for a 20-act batch at the slow-build rate documented in
// fulltext-index-build.test.js, while still bounding a stuck worker.
const DEFAULT_TASK_DEADLINE_MS = 5 * 60 * 1000;

// With the serving pool's default of two workers, eight waiting payloads cap
// retained parent-side input at ten tasks. Parser inputs can be multi-megabyte
// strings, so a finite burst buffer protects memory without making ordinary
// request bursts fail immediately. The fulltext runner schedules its finite
// batch list itself and therefore does not need to enlarge this limit.
const DEFAULT_QUEUE_LIMIT = 8;

class WorkerLossError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "WorkerLossError";
    this.code = "worker_lost";
  }
}

class WorkerStartupError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "WorkerStartupError";
    this.code = "worker_startup_failed";
  }
}

class WorkerDispatchError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "WorkerDispatchError";
    this.code = "worker_dispatch_failed";
  }
}

class WorkerStructuredCloneError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "WorkerStructuredCloneError";
    this.code = "worker_structured_clone_failed";
  }
}

class WorkerResultError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "WorkerResultError";
    this.code = "worker_result_failed";
  }
}

class WorkerPoolOverloadError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkerPoolOverloadError";
    this.code = "worker_pool_overloaded";
  }
}

class WorkerPoolClosedError extends Error {
  constructor(message = "Worker pool is closed") {
    super(message);
    this.name = "WorkerPoolClosedError";
    this.code = "worker_pool_closed";
  }
}

/**
 * Creates a small pool of workers that stay alive until close(). A worker is
 * only given one message at a time, which lets callers keep a large result
 * (and its structured-clone cost) bounded per worker while still making the
 * pool useful for both one-shot build queues and serving requests.
 */
function createWorkerPool({
  poolSize = 1,
  workerFactory,
  taskDeadlineMs = DEFAULT_TASK_DEADLINE_MS,
  queueLimit = DEFAULT_QUEUE_LIMIT,
} = {}) {
  if (!Number.isInteger(poolSize) || poolSize < 1) {
    throw new Error(`Worker pool size must be a positive integer, got ${poolSize}`);
  }
  if (typeof workerFactory !== "function") {
    throw new Error("Worker pool requires a workerFactory");
  }
  if (!Number.isFinite(taskDeadlineMs) || taskDeadlineMs <= 0) {
    throw new Error(`Worker task deadline must be a positive number, got ${taskDeadlineMs}`);
  }
  if (!Number.isInteger(queueLimit) || queueLimit < 0) {
    throw new Error(`Worker pool queue limit must be a non-negative integer, got ${queueLimit}`);
  }

  const workers = new Set();
  const queue = [];
  let closed = false;
  let closePromise = null;

  function rejectQueued(error) {
    while (queue.length) queue.shift().reject(error);
  }

  function clearJobTimer(job) {
    if (job.timer) {
      clearTimeout(job.timer);
      job.timer = null;
    }
  }

  function isStructuredCloneError(error) {
    return error?.name === "DataCloneError" || error?.code === "ERR_INVALID_ARG_TYPE";
  }

  function isWorkerTransportError(error) {
    return error?.code === "ERR_WORKER_NOT_RUNNING" || error?.code === "ERR_WORKER_MESSAGING_FAILED";
  }

  function attachWorker(thread) {
    const record = { thread, job: null, dead: false };
    workers.add(record);

    thread.on("message", (message) => {
      const job = record.job;
      if (!job || record.dead || job.resultReceived) return;
      job.resultReceived = true;

      // Keep the worker occupied until the result callback has completed. The
      // full-text builder relies on this to keep its parent-side SQLite insert
      // serialized even when several workers finish close together.
      Promise.resolve()
        .then(() => job.onResult?.(message, job.payload, thread))
        .then(() => {
          if (record.job !== job) return;
          clearJobTimer(job);
          record.job = null;
          job.resolve(message);
          dispatch();
        })
        .catch((error) => {
          if (record.job !== job) return;
          clearJobTimer(job);
          record.job = null;
          job.reject(new WorkerResultError(
            `Worker result callback failed: ${error?.message || error}`,
            error,
          ));
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
        if (workers.size === 0) {
          throw new WorkerStartupError(
            `Worker pool could not start a worker: ${error?.message || error}`,
            error,
          );
        }
        break;
      }
    }
  }

  function handleWorkerLoss(record, error, { terminate = false } = {}) {
    if (record.dead) return;
    record.dead = true;
    workers.delete(record);
    const job = record.job;
    record.job = null;
    if (job) {
      clearJobTimer(job);
      job.reject(error instanceof WorkerLossError ? error : new WorkerLossError(
        `Worker was lost: ${error?.message || error}`,
        error,
      ));
    }

    if (terminate) {
      Promise.resolve(record.thread.terminate()).catch(() => {});
    }

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
      job.timer = setTimeout(() => {
        if (record.job !== job || record.dead) return;
        handleWorkerLoss(
          record,
          new Error(`Worker task exceeded the ${taskDeadlineMs}ms deadline`),
          { terminate: true },
        );
      }, taskDeadlineMs);
      try {
        record.thread.postMessage(job.payload);
      } catch (error) {
        if (isWorkerTransportError(error)) {
          // Keep record.job set so handleWorkerLoss rejects this task before
          // replacing the worker. Clearing it first would leave the promise
          // pending forever on a synchronous transport failure.
          handleWorkerLoss(record, error, { terminate: true });
        } else {
          clearJobTimer(job);
          record.job = null;
          if (isStructuredCloneError(error)) {
            job.reject(new WorkerStructuredCloneError(
              `Worker could not receive the task: ${error?.message || error}`,
              error,
            ));
          } else {
            job.reject(new WorkerDispatchError(
              `Worker task dispatch failed: ${error?.message || error}`,
              error,
            ));
          }
        }
        queueMicrotask(dispatch);
      }
    }
  }

  function run(payload, { onResult } = {}) {
    return new Promise((resolve, reject) => {
      if (closed) {
        reject(new WorkerPoolClosedError());
        return;
      }
      try {
        ensureWorkers();
      } catch (error) {
        reject(error);
        return;
      }
      const allWorkersBusy = workers.size > 0 && [...workers].every((record) => record.dead || record.job);
      if (allWorkersBusy && queue.length >= queueLimit) {
        reject(new WorkerPoolOverloadError(
          `Worker pool queue is full (${queueLimit} waiting tasks)`,
        ));
        return;
      }
      queue.push({ payload, onResult, resolve, reject, timer: null, resultReceived: false });
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
    rejectQueued(new WorkerPoolClosedError());
    const active = [...workers];
    for (const record of active) {
      record.dead = true;
      workers.delete(record);
      const job = record.job;
      record.job = null;
      if (job) {
        clearJobTimer(job);
        job.reject(new WorkerPoolClosedError());
      }
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
  const pool = createWorkerPool({
    poolSize,
    workerFactory,
    taskDeadlineMs: options.taskDeadlineMs,
    queueLimit: options.queueLimit,
  });
  const onProgress = options.onProgress || (() => {});

  function handleResult(shard, batch) {
    const startedAt = process.hrtime.bigint();
    onResult(shard, batch);
    const callbackMs = Number((process.hrtime.bigint() - startedAt) / 1000000n);
    options.accumulate?.(totals, shard, { callbackMs });
    onProgress(totals);
  }

  // Keep the runner's own finite batch list from filling the serving-oriented
  // pool queue. Recursive bisection uses the same gate, so a large build never
  // turns the queue-capacity guard into a false build failure.
  let activeTasks = 0;
  const waitingTasks = [];

  async function runInPoolSlot(task) {
    if (activeTasks >= poolSize) await new Promise((resolve) => waitingTasks.push(resolve));
    activeTasks += 1;
    try {
      return await task();
    } finally {
      activeTasks -= 1;
      waitingTasks.shift()?.();
    }
  }

  async function processBatch(batch) {
    try {
      await runInPoolSlot(() => pool.run(batch, {
        onResult: (shard, payload) => handleResult(shard, payload),
      }));
    } catch (error) {
      if (!(error instanceof WorkerLossError)) throw error;
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

module.exports = {
  DEFAULT_QUEUE_LIMIT,
  DEFAULT_TASK_DEADLINE_MS,
  WorkerDispatchError,
  WorkerLossError,
  WorkerPoolClosedError,
  WorkerPoolOverloadError,
  WorkerResultError,
  WorkerStartupError,
  WorkerStructuredCloneError,
  createWorkerPool,
  runPool,
};
