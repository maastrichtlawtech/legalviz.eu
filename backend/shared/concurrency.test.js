const test = require("node:test");
const assert = require("node:assert/strict");

const { CapacityError, createSemaphore } = require("./concurrency");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("createSemaphore never runs more than `limit` tasks at once", async () => {
  const semaphore = createSemaphore({ limit: 2 });
  const gates = [deferred(), deferred(), deferred()];
  let running = 0;
  let peak = 0;

  const runs = gates.map((gate) => semaphore.run(async () => {
    running += 1;
    peak = Math.max(peak, running);
    await gate.promise;
    running -= 1;
  }));

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peak, 2, "third task must wait for a free slot");
  assert.equal(semaphore.queued, 1);

  gates.forEach((gate) => gate.resolve());
  await Promise.all(runs);
  assert.equal(peak, 2);
  assert.equal(semaphore.active, 0);
  assert.equal(semaphore.queued, 0);
});

test("createSemaphore releases the slot when a task throws", async () => {
  const semaphore = createSemaphore({ limit: 1 });

  await assert.rejects(
    semaphore.run(async () => { throw new Error("boom"); }),
    /boom/,
  );
  assert.equal(semaphore.active, 0);

  assert.equal(await semaphore.run(async () => "next task still runs"), "next task still runs");
});

test("createSemaphore rejects once the queue is full instead of growing without bound", async () => {
  const semaphore = createSemaphore({ limit: 1, maxQueue: 1, name: "test pool" });
  const gate = deferred();

  const active = semaphore.run(() => gate.promise);
  const queued = semaphore.run(async () => "queued");

  await assert.rejects(
    semaphore.run(async () => "overflow"),
    (err) => {
      assert.ok(err instanceof CapacityError);
      assert.equal(err.code, "capacity_exceeded");
      assert.match(err.message, /test pool/);
      return true;
    },
  );

  gate.resolve("active");
  assert.equal(await active, "active");
  assert.equal(await queued, "queued");
});

test("createSemaphore runs queued tasks in FIFO order", async () => {
  const semaphore = createSemaphore({ limit: 1 });
  const gate = deferred();
  const order = [];

  const first = semaphore.run(() => gate.promise.then(() => order.push("first")));
  const second = semaphore.run(async () => { order.push("second"); });
  const third = semaphore.run(async () => { order.push("third"); });

  gate.resolve();
  await Promise.all([first, second, third]);
  assert.deepEqual(order, ["first", "second", "third"]);
});
