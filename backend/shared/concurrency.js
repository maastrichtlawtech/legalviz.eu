/**
 * Minimal FIFO semaphore for work that must not run unboundedly in parallel —
 * Playwright launches and outbound model calls, both of which are far more
 * expensive than the HTTP request that triggers them.
 *
 * `maxQueue` is the part that actually protects the process: without it a
 * flood of requests still queues one object per request and every caller ends
 * up waiting past its own timeout. Rejecting the overflow immediately gives
 * clients a fast, honest 503 instead.
 */
class CapacityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CapacityError';
    this.code = 'capacity_exceeded';
  }
}

function createSemaphore({ limit = 1, maxQueue = Infinity, name = 'semaphore' } = {}) {
  const maxActive = Math.max(1, Number(limit) || 1);
  const queueLimit = Number(maxQueue) > 0 ? Number(maxQueue) : Infinity;
  const waiters = [];
  let active = 0;

  function release() {
    active -= 1;
    const next = waiters.shift();
    if (next) next();
  }

  function acquire() {
    if (active < maxActive) {
      active += 1;
      return Promise.resolve();
    }
    if (waiters.length >= queueLimit) {
      return Promise.reject(new CapacityError(`${name} is at capacity (${maxActive} active, ${waiters.length} queued)`));
    }
    return new Promise((resolve) => {
      waiters.push(() => {
        active += 1;
        resolve();
      });
    });
  }

  async function run(fn) {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return {
    run,
    get active() { return active; },
    get queued() { return waiters.length; },
    limit: maxActive,
    maxQueue: queueLimit,
  };
}

module.exports = {
  CapacityError,
  createSemaphore,
};
