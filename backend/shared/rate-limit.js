function getIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
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

module.exports = {
  createRateLimitMiddleware
};
