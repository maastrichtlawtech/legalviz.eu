"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { Worker } = require("node:worker_threads");

const { wrapForParsing } = require("../search/search-build");
const { ClientError } = require("./api-utils");
const {
  createWorkerPool,
  runPool,
  DEFAULT_TASK_DEADLINE_MS,
  WorkerLossError,
  WorkerPoolOverloadError,
  WorkerResultError,
} = require("./worker-pool");
const {
  createParserPool,
  DEFAULT_PARSER_POOL_SIZE,
  DEFAULT_PARSER_WORKER_HEAP_MB,
  DEFAULT_PARSER_WORKER_RECYCLE_TASKS,
} = require("./parser-worker-pool");

const FIXTURE = path.join(__dirname, "__fixtures__", "corpus", "fmx-v4-2009-32009L0004.xml.gz");
const FMX = wrapForParsing(zlib.gunzipSync(fs.readFileSync(FIXTURE)).toString("utf8"));
const HTML = `<!DOCTYPE html><html lang="EN"><head>
  <meta name="DC.description" content="A test EUR-Lex law">
  </head><body><div id="TexteOnly"><TXT_TE>
    <p>Whereas:</p><p>(1) A test recital.</p><p>Article 1</p>
    <p>Scope</p><p>1. This law applies to tests.</p>
  </TXT_TE></div></body></html>`;

class FakeWorker extends EventEmitter {
  constructor(onPostMessage = () => {}) {
    super();
    this.onPostMessage = onPostMessage;
    this.terminated = false;
    this.posts = 0;
  }

  postMessage(payload) {
    this.posts += 1;
    this.onPostMessage(payload);
  }

  terminate() {
    this.terminated = true;
    return Promise.resolve(0);
  }
}

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

test("worker loss surfaces a 503 and never retries the parse inline", async () => {
  let inlineCalls = 0;
  let starts = 0;
  const pool = createParserPool({
    poolSize: 1,
    spawnWorker: () => {
      starts += 1;
      let worker;
      worker = new FakeWorker(() => queueMicrotask(() => worker.emit("error", new Error("simulated OOM"))));
      return worker;
    },
    parseFmxXml: async () => {
      inlineCalls += 1;
      return { kind: "inline" };
    },
  });

  await assert.rejects(
    pool.parseFmxXml("xml"),
    (error) => {
      assert.ok(error instanceof ClientError);
      assert.equal(error.statusCode, 503);
      assert.equal(error.code, "parser_worker_unavailable");
      return true;
    },
  );
  assert.equal(inlineCalls, 0);
  assert.equal(starts, 2, "the lost worker should be replaced for the next request");
  await pool.close();
});

test("parser recycling is transparent to queued callers and does not disable the pool", async () => {
  let starts = 0;
  let inlineCalls = 0;
  const workers = [];
  const pool = createParserPool({
    poolSize: 1,
    recycleAfter: 1,
    spawnWorker: () => {
      starts += 1;
      const worker = new FakeWorker((payload) => queueMicrotask(() => {
        worker.emit("message", { ok: true, result: { kind: "worker", payload } });
      }));
      workers.push(worker);
      return worker;
    },
    parseFmxXml: async () => {
      inlineCalls += 1;
      return { kind: "inline" };
    },
  });

  try {
    const results = await Promise.all(["one", "two", "three", "four"].map((input) => pool.parseFmxXml(input)));
    assert.deepEqual(results, [
      { kind: "worker", payload: { kind: "fmx", input: "one", lang: undefined } },
      { kind: "worker", payload: { kind: "fmx", input: "two", lang: undefined } },
      { kind: "worker", payload: { kind: "fmx", input: "three", lang: undefined } },
      { kind: "worker", payload: { kind: "fmx", input: "four", lang: undefined } },
    ]);
    assert.equal(starts, 4, "each completed task retires before the next queued task");
    assert.equal(inlineCalls, 0, "retirement is not classified as a startup or worker failure");
    assert.ok(workers.slice(0, -1).every((worker) => worker.terminated));
  } finally {
    await pool.close();
  }
});

test("never-replying workers are killed at the deadline and replaced", { timeout: 1000 }, async () => {
  assert.ok(DEFAULT_TASK_DEADLINE_MS > 1000, "the production deadline should cover real parse batches");
  let starts = 0;
  let first;
  let second;
  const pool = createWorkerPool({
    poolSize: 1,
    taskDeadlineMs: 25,
    workerFactory: () => {
      starts += 1;
      if (starts === 1) {
        first = new FakeWorker();
        return first;
      }
      second = new FakeWorker((payload) => queueMicrotask(() => second.emit("message", { ok: true, payload })));
      return second;
    },
  });

  await assert.rejects(
    pool.run("first"),
    (error) => {
      assert.ok(error instanceof WorkerLossError);
      assert.equal(error.code, "worker_lost");
      assert.match(error.message, /deadline/);
      return true;
    },
  );
  assert.equal(first.terminated, true);
  assert.equal(starts, 2);
  assert.deepEqual(await pool.run("second"), { ok: true, payload: "second" });
  await pool.close();
});

test("synchronous worker transport failures reject the active task and replace the worker", async () => {
  let starts = 0;
  let first;
  let second;
  const pool = createWorkerPool({
    poolSize: 1,
    workerFactory: () => {
      starts += 1;
      if (starts === 1) {
        first = new FakeWorker(() => {
          throw Object.assign(new Error("worker is not running"), { code: "ERR_WORKER_NOT_RUNNING" });
        });
        return first;
      }
      second = new FakeWorker((payload) => queueMicrotask(() => second.emit("message", { ok: true, payload })));
      return second;
    },
  });

  await assert.rejects(pool.run("first"), (error) => {
    assert.ok(error instanceof WorkerLossError);
    assert.equal(error.code, "worker_lost");
    return true;
  });
  assert.equal(first.terminated, true);
  assert.equal(starts, 2);
  assert.deepEqual(await pool.run("second"), { ok: true, payload: "second" });
  await pool.close();
});

test("worker pool rejects a task when its queue is full", { timeout: 1000 }, async () => {
  const worker = new FakeWorker();
  const pool = createWorkerPool({ poolSize: 1, queueLimit: 1, workerFactory: () => worker });
  const active = pool.run("active").catch((error) => error);
  const queued = pool.run("queued").catch((error) => error);

  await assert.rejects(
    pool.run("overflow"),
    (error) => {
      assert.ok(error instanceof WorkerPoolOverloadError);
      assert.equal(error.code, "worker_pool_overloaded");
      assert.match(error.message, /queue is full/);
      return true;
    },
  );

  await pool.close();
  assert.equal((await active).code, "worker_pool_closed");
  assert.equal((await queued).code, "worker_pool_closed");
});

test("opt-in recycling replaces idle workers before queued work and preserves every result", async () => {
  const workers = [];
  const pool = createWorkerPool({
    poolSize: 1,
    recycleAfter: 2,
    workerFactory: () => {
      const worker = new FakeWorker((payload) => queueMicrotask(() => {
        worker.emit("message", { ok: true, result: payload });
      }));
      workers.push(worker);
      return worker;
    },
  });

  try {
    const results = await Promise.all([1, 2, 3, 4, 5].map((payload) => pool.run(payload)));
    assert.deepEqual(results.map((message) => message.result), [1, 2, 3, 4, 5]);
    assert.equal(workers.length, 3, "one replacement per two completed tasks");
    assert.equal(workers[0].posts, 2);
    assert.equal(workers[1].posts, 2);
    assert.equal(workers[2].posts, 1);
    assert.equal(workers[0].terminated, true);
    assert.equal(workers[1].terminated, true);
  } finally {
    await pool.close();
  }
});

test("close() waits for workers already retired for recycling", async () => {
  // A retired worker leaves `workers` the instant retirement starts, so close()
  // could resolve while its thread is still alive and still holding the event
  // loop open -- for the fulltext CLI that is a build that finishes and then
  // hangs.
  const workers = [];
  const pool = createWorkerPool({
    poolSize: 1,
    recycleAfter: 1,
    workerFactory: () => {
      const worker = new FakeWorker((payload) => queueMicrotask(() => {
        worker.emit("message", { ok: true, result: payload });
      }));
      // Each worker's termination is released individually, so the retired
      // one can be left outstanding while the live one has already settled.
      worker.terminate = () => {
        worker.terminated = true;
        return new Promise((resolve) => { worker.release = () => resolve(0); });
      };
      workers.push(worker);
      return worker;
    },
  });

  await pool.run(1);
  await pool.run(2);
  assert.equal(workers.length, 2, "the first worker retired after its single task");
  const [retired, live] = workers;
  assert.equal(retired.terminated, true, "the retired worker's termination is in flight");

  let closed = false;
  const closing = pool.close().then(() => { closed = true; });
  live.release();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    closed,
    false,
    "close() must not resolve once the live worker is gone but a retired thread is still terminating",
  );

  retired.release();
  await closing;
  assert.equal(closed, true);
});

test("onResult errors propagate without bisecting into a skipped batch", async () => {
  let worker;
  let skipped = 0;
  worker = new FakeWorker(() => queueMicrotask(() => worker.emit("message", { ok: true, result: "shard" })));

  await assert.rejects(
    runPool([["first", "second"]], () => {
      throw new Error("SQLite insert failed");
    }, {
      poolSize: 1,
      spawnWorker: () => worker,
      onWorkerFailure: () => { skipped += 1; },
    }),
    (error) => {
      assert.ok(error instanceof WorkerResultError);
      assert.equal(error.code, "worker_result_failed");
      assert.match(error.message, /SQLite insert failed/);
      return true;
    },
  );
  assert.equal(worker.posts, 1, "a callback failure must not trigger batch bisection");
  assert.equal(skipped, 0);
});

test("parser pool defaults retain the builder-sized worker budget", () => {
  assert.equal(DEFAULT_PARSER_POOL_SIZE, 2);
  assert.equal(DEFAULT_PARSER_WORKER_HEAP_MB, 640);
  assert.equal(DEFAULT_PARSER_WORKER_RECYCLE_TASKS, 40);
});
