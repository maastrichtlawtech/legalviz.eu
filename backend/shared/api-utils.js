const VALID_LANGS = new Set([
  'BUL', 'CES', 'DAN', 'DEU', 'ELL', 'ENG', 'EST', 'FIN', 'FRA', 'GLE',
  'HRV', 'HUN', 'ITA', 'LAV', 'LIT', 'MLT', 'NLD', 'POL', 'POR', 'RON',
  'SLK', 'SLV', 'SPA', 'SWE'
]);

function validateLang(lang) {
  const upper = (lang || 'ENG').toUpperCase();
  return VALID_LANGS.has(upper) ? upper : null;
}

const LANG_3_TO_2 = {
  BUL: 'bg', CES: 'cs', DAN: 'da', DEU: 'de', ELL: 'el', ENG: 'en',
  EST: 'et', FIN: 'fi', FRA: 'fr', GLE: 'ga', HRV: 'hr', HUN: 'hu',
  ITA: 'it', LAV: 'lv', LIT: 'lt', MLT: 'mt', NLD: 'nl', POL: 'pl',
  POR: 'pt', RON: 'ro', SLK: 'sk', SLV: 'sl', SPA: 'es', SWE: 'sv',
};

function toSearchLang(lang) {
  const upper = (lang || 'ENG').toUpperCase();
  return LANG_3_TO_2[upper] || upper.slice(0, 2).toLowerCase();
}

const DEFAULT_CACHE_MAX_ENTRIES = 10_000;

function cacheGet(cache, key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(cache, key, value, ttlMs, maxEntries = DEFAULT_CACHE_MAX_ENTRIES) {
  if (cache.size >= maxEntries) {
    // Evict oldest entry (first inserted key in Map iteration order)
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

class ClientError extends Error {
  constructor(message, statusCode = 500, code = null, details = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function safeErrorResponse(res, err, fallbackMessage = 'Internal server error') {
  if (err instanceof ClientError) {
    return res.status(err.statusCode).json({
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
      ...(err.details ? { details: err.details } : {}),
    });
  }
  console.error(`[API] ${fallbackMessage}:`, err.message);
  return res.status(500).json({ error: fallbackMessage });
}

module.exports = {
  ClientError,
  VALID_LANGS,
  cacheGet,
  cacheSet,
  safeErrorResponse,
  toSearchLang,
  validateLang
};
