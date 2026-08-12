const DEFAULT_ALLOWED_ORIGINS = [
  'https://legalviz.eu',
  'https://www.legalviz.eu',
  'http://localhost:5173',
  'http://localhost:4173',
];

function parseOriginList(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/**
 * Restrict a route to browser pages served from known origins.
 *
 * `app.use(cors())` reflects every origin, which is what makes the public API
 * and MCP endpoint pleasant to consume — but it also lets any third-party page
 * spend this deployment's model budget through its visitors' IPs. This guard
 * is applied to the generation routes only; everything else stays open.
 *
 * A missing `Origin` header is allowed: that's a non-browser client (curl, the
 * CLI, an MCP session), which cannot borrow someone else's IP and is bounded
 * by the per-IP generation limit like everyone else. The point is to stop a
 * hostile *page*, not to authenticate callers.
 */
function createOriginAllowlistMiddleware(options = {}) {
  const configured = parseOriginList(options.allowedOrigins ?? process.env.AI_ALLOWED_ORIGINS);
  const allowAll = configured.includes('*');
  const allowed = new Set(configured.length ? configured : DEFAULT_ALLOWED_ORIGINS);

  return function middleware(req, res, next) {
    if (allowAll) return next();
    const origin = req.headers.origin;
    if (!origin) return next();
    if (allowed.has(String(origin).replace(/\/+$/, ''))) return next();
    return res.status(403).json({
      error: 'This endpoint is not available to third-party origins.',
      code: 'origin_not_allowed',
    });
  };
}

module.exports = {
  DEFAULT_ALLOWED_ORIGINS,
  createOriginAllowlistMiddleware,
};
