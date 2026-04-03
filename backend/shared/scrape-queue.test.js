const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { createScrapeQueue, isWafOrNetworkError } = require("./scrape-queue");

describe("createScrapeQueue", () => {
  test("processes tasks with concurrency limit", async () => {
    let maxConcurrent = 0;
    let current = 0;

    const queue = createScrapeQueue({ concurrency: 2, minDelayMs: 0, timeoutMs: 5_000 });

    const results = await queue.enqueueAll(
      Array.from({ length: 6 }, (_, i) => async () => {
        current++;
        maxConcurrent = Math.max(maxConcurrent, current);
        await new Promise((r) => setTimeout(r, 20));
        current--;
        return i;
      }),
    );

    assert.ok(maxConcurrent <= 2, `Expected max concurrency 2, got ${maxConcurrent}`);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 6);
    assert.deepEqual(
      results.map((r) => r.value),
      [0, 1, 2, 3, 4, 5],
    );
    queue.destroy();
  });

  test("retries on retriable errors with backoff", async () => {
    let attempts = 0;

    const queue = createScrapeQueue({
      concurrency: 1,
      minDelayMs: 0,
      maxRetries: 3,
      baseBackoffMs: 50,
      maxBackoffMs: 200,
      timeoutMs: 5_000,
      isRetriable: () => true,
    });

    const result = await queue.enqueue(async () => {
      attempts++;
      if (attempts < 3) throw new Error("transient");
      return "ok";
    });

    assert.equal(result, "ok");
    assert.equal(attempts, 3);
    const stats = queue.getStats();
    assert.equal(stats.completed, 1);
    assert.equal(stats.retried, 2);
    queue.destroy();
  });

  test("rejects after max retries exhausted", async () => {
    const queue = createScrapeQueue({
      concurrency: 1,
      minDelayMs: 0,
      maxRetries: 2,
      baseBackoffMs: 10,
      timeoutMs: 5_000,
      isRetriable: () => true,
    });

    await assert.rejects(
      () => queue.enqueue(async () => { throw new Error("always fails"); }),
      /always fails/,
    );

    const stats = queue.getStats();
    assert.equal(stats.failed, 1);
    assert.equal(stats.retried, 2);
    queue.destroy();
  });

  test("does not retry non-retriable errors", async () => {
    let attempts = 0;

    const queue = createScrapeQueue({
      concurrency: 1,
      minDelayMs: 0,
      maxRetries: 3,
      timeoutMs: 5_000,
      isRetriable: () => false,
    });

    await assert.rejects(
      () => queue.enqueue(async () => { attempts++; throw new Error("fatal"); }),
      /fatal/,
    );
    assert.equal(attempts, 1);
    queue.destroy();
  });

  test("respects priority ordering", async () => {
    const order = [];
    // Use a concurrency of 1 and block the first task to queue up the rest
    const queue = createScrapeQueue({ concurrency: 1, minDelayMs: 0, timeoutMs: 5_000 });

    const blocker = queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push("blocker");
    });

    // These queue up while blocker is running
    const low = queue.enqueue(async () => { order.push("low"); }, { priority: 1 });
    const high = queue.enqueue(async () => { order.push("high"); }, { priority: 10 });

    await Promise.all([blocker, low, high]);
    assert.deepEqual(order, ["blocker", "high", "low"]);
    queue.destroy();
  });

  test("destroy rejects pending tasks", async () => {
    const queue = createScrapeQueue({ concurrency: 1, minDelayMs: 0, timeoutMs: 5_000 });

    // Block the queue
    const blocker = queue.enqueue(() => new Promise((r) => setTimeout(r, 200)));
    const pending = queue.enqueue(async () => "should not run");

    queue.destroy();

    await assert.rejects(() => pending, /Queue destroyed/);
    // Blocker should still resolve (already in-flight)
    await blocker;
  });

  test("getStats tracks counts", async () => {
    const queue = createScrapeQueue({ concurrency: 2, minDelayMs: 0, timeoutMs: 5_000, isRetriable: () => false });

    await queue.enqueue(async () => "ok");
    await assert.rejects(() => queue.enqueue(async () => { throw new Error("fail"); }));

    const stats = queue.getStats();
    assert.equal(stats.completed, 1);
    assert.equal(stats.failed, 1);
    assert.equal(stats.pending, 0);
    assert.equal(stats.inFlight, 0);
    queue.destroy();
  });
});

describe("isWafOrNetworkError", () => {
  test("detects WAF challenge errors", () => {
    assert.ok(isWafOrNetworkError({ message: "WAF challenge detected" }));
    assert.ok(isWafOrNetworkError({ code: "eurlex_html_challenged" }));
    assert.ok(isWafOrNetworkError({ statusCode: 202 }));
  });

  test("detects network errors", () => {
    assert.ok(isWafOrNetworkError({ message: "ECONNRESET" }));
    assert.ok(isWafOrNetworkError({ message: "ETIMEDOUT" }));
    assert.ok(isWafOrNetworkError({ message: "fetch failed" }));
    assert.ok(isWafOrNetworkError({ message: "Task timed out" }));
    assert.ok(isWafOrNetworkError({ status: 429 }));
    assert.ok(isWafOrNetworkError({ status: 503 }));
  });

  test("rejects non-retriable errors", () => {
    assert.ok(!isWafOrNetworkError({ message: "Cannot read property x" }));
    assert.ok(!isWafOrNetworkError({ message: "SyntaxError" }));
    assert.ok(!isWafOrNetworkError({ status: 404 }));
  });
});
