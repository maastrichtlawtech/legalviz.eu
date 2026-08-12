function getIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function createRateLimitMiddleware(options = {}) {
  const windowMs = options.windowMs || 15 * 60 * 1000;
  const max = options.max || 500;
  const ipRequests = new Map();

  function middleware(req, res, next) {
    const ip = getIp(req);
    const now = Date.now();

    let record = ipRequests.get(ip);
    if (!record || now > record.resetAt) {
      record = { count: 0, resetAt: now + windowMs };
      ipRequests.set(ip, record);
    }

    record.count += 1;
    if (record.count > max) {
      return res.status(429).json({ error: 'Too many requests' });
    }

    next();
  }

  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of ipRequests) {
      if (now > record.resetAt) ipRequests.delete(ip);
    }
  }, 5 * 60 * 1000);
  cleanupInterval.unref();

  middleware.close = () => clearInterval(cleanupInterval);
  return middleware;
}

/**
 * Per-IP budget for requests that can trigger a *billed* model call.
 *
 * The generic limiter above is deliberately generous (one law view is several
 * requests), which makes it useless as a spend guard: an abuser can burn the
 * whole OpenRouter budget well inside it. This one is separate, much tighter,
 * and — crucially — charged by the route only when a generation actually
 * happened, via `req.chargeGeneration()`. Cache hits are free, so ordinary
 * readers of already-generated laws never see it.
 */
function createGenerationLimitMiddleware(options = {}) {
  const windowMs = options.windowMs || 60 * 60 * 1000; // 1 hour
  const max = options.max || 10;
  const generations = new Map();

  function middleware(req, res, next) {
    const ip = getIp(req);
    const now = Date.now();

    let record = generations.get(ip);
    if (!record || now > record.resetAt) {
      record = { count: 0, resetAt: now + windowMs };
      generations.set(ip, record);
    }

    if (record.count >= max) {
      return res.status(429).json({
        error: 'Too many AI generations from this IP. Already-generated results are still available; please try again later.',
        code: 'generation_rate_limited',
        retryAfterMs: Math.max(0, record.resetAt - now),
      });
    }

    req.chargeGeneration = () => { record.count += 1; };
    next();
  }

  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of generations) {
      if (now > record.resetAt) generations.delete(ip);
    }
  }, 5 * 60 * 1000);
  cleanupInterval.unref();

  middleware.close = () => clearInterval(cleanupInterval);
  return middleware;
}

module.exports = {
  createRateLimitMiddleware,
  createGenerationLimitMiddleware
};
