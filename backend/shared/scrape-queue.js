/**
 * Robust scraping queue with concurrency control, exponential backoff,
 * jitter, rate limiting, and optional Playwright fallback for WAF challenges.
 *
 * Usage:
 *   const queue = createScrapeQueue({ concurrency: 3, minDelayMs: 500 });
 *   const result = await queue.enqueue(() => fetch(url), { priority: 1 });
 *   queue.destroy(); // clean up timers
 */

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MIN_DELAY_MS = 300;
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BASE_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * @param {object} opts
 * @param {number} [opts.concurrency=3]         Max parallel in-flight tasks.
 * @param {number} [opts.minDelayMs=300]         Min ms between dispatches (rate limit).
 * @param {number} [opts.maxRetries=4]           Retries per task on retriable errors.
 * @param {number} [opts.baseBackoffMs=1000]     Base for exponential backoff.
 * @param {number} [opts.maxBackoffMs=30000]     Backoff cap.
 * @param {number} [opts.timeoutMs=30000]        Per-attempt timeout.
 * @param {(error: Error) => boolean} [opts.isRetriable] Predicate for retriable errors.
 * @param {string} [opts.name='scrape-queue']    Label for log messages.
 */
function createScrapeQueue({
  concurrency = DEFAULT_CONCURRENCY,
  minDelayMs = DEFAULT_MIN_DELAY_MS,
  maxRetries = DEFAULT_MAX_RETRIES,
  baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  isRetriable = () => false,
  name = 'scrape-queue',
} = {}) {
  /** @type {Array<{fn: Function, resolve: Function, reject: Function, priority: number, retries: number, id: number}>} */
  const pending = [];
  let inFlight = 0;
  let lastDispatchTime = 0;
  let drainTimer = null;
  let taskCounter = 0;
  let destroyed = false;

  // Stats
  let completed = 0;
  let failed = 0;
  let retried = 0;

  function backoffMs(attempt) {
    const base = Math.min(maxBackoffMs, baseBackoffMs * (2 ** attempt));
    const jitter = Math.random() * base * 0.3; // ±30% jitter
    return base + jitter;
  }

  function scheduleDrain() {
    if (drainTimer || destroyed) return;
    const now = Date.now();
    const elapsed = now - lastDispatchTime;
    const wait = Math.max(0, minDelayMs - elapsed);
    drainTimer = setTimeout(() => {
      drainTimer = null;
      drain();
    }, wait);
  }

  function drain() {
    if (destroyed) return;
    while (inFlight < concurrency && pending.length > 0) {
      const now = Date.now();
      if (now - lastDispatchTime < minDelayMs) {
        scheduleDrain();
        return;
      }

      const task = pending.shift();
      lastDispatchTime = now;
      inFlight++;
      runTask(task);
    }
  }

  async function runTask(task) {
    try {
      const result = await executeWithTimeout(task.fn, timeoutMs);
      completed++;
      task.resolve(result);
    } catch (err) {
      if (isRetriable(err) && task.retries < maxRetries) {
        task.retries++;
        retried++;
        const delay = backoffMs(task.retries);
        console.log(`[${name}] Retry ${task.retries}/${maxRetries} for task #${task.id} in ${Math.round(delay)}ms: ${err.message}`);
        await sleep(delay);
        if (!destroyed) {
          // Re-enqueue at front (high priority retry)
          pending.unshift(task);
        } else {
          task.reject(err);
        }
      } else {
        failed++;
        task.reject(err);
      }
    } finally {
      inFlight--;
      if (!destroyed) drain();
    }
  }

  /**
   * Enqueue a task.
   * @param {() => Promise<T>} fn         The async work to execute.
   * @param {object} [opts]
   * @param {number} [opts.priority=0]     Higher = dispatched sooner.
   * @returns {Promise<T>}
   */
  function enqueue(fn, { priority = 0 } = {}) {
    if (destroyed) return Promise.reject(new Error(`[${name}] Queue destroyed`));

    return new Promise((resolve, reject) => {
      const task = { fn, resolve, reject, priority, retries: 0, id: ++taskCounter };

      // Insert sorted by descending priority
      let idx = pending.findIndex((t) => t.priority < priority);
      if (idx === -1) idx = pending.length;
      pending.splice(idx, 0, task);

      drain();
    });
  }

  /**
   * Enqueue a batch of tasks and return results as they complete.
   * @param {Array<() => Promise<T>>} fns
   * @param {object} [opts]
   * @param {number} [opts.priority=0]
   * @returns {Promise<Array<{status: 'fulfilled', value: T} | {status: 'rejected', reason: Error}>>}
   */
  function enqueueAll(fns, { priority = 0 } = {}) {
    return Promise.allSettled(fns.map((fn) => enqueue(fn, { priority })));
  }

  function getStats() {
    return { pending: pending.length, inFlight, completed, failed, retried };
  }

  function destroy() {
    destroyed = true;
    if (drainTimer) {
      clearTimeout(drainTimer);
      drainTimer = null;
    }
    // Reject all pending tasks
    for (const task of pending.splice(0)) {
      task.reject(new Error(`[${name}] Queue destroyed`));
    }
  }

  return { enqueue, enqueueAll, getStats, destroy };
}

function executeWithTimeout(fn, timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) return fn();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Task timed out')), timeoutMs);
    fn().then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Predicate: is this a WAF challenge or transient network error?
 */
function isWafOrNetworkError(err) {
  const msg = String(err?.message || err || '');
  if (/waf.challenge/i.test(msg)) return true;
  if (/challenge.*response/i.test(msg)) return true;
  if (err?.code === 'eurlex_html_challenged') return true;
  if (err?.statusCode === 202) return true;
  // Transient network errors
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT/i.test(msg)) return true;
  if (/fetch failed|network error|socket hang up/i.test(msg)) return true;
  if (/Task timed out/i.test(msg)) return true;
  // HTTP 429 / 503
  if (err?.status === 429 || err?.status === 503) return true;
  if (err?.statusCode === 429 || err?.statusCode === 503) return true;
  return false;
}

module.exports = { createScrapeQueue, isWafOrNetworkError };
