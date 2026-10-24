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

function getPersistentStore(cache) {
  const store = cache?.persistentStore;
  return store && typeof store.get === 'function' ? store : null;
}

// cacheGet drops an expired entry only when that same key is read again, so
// without a sweep every distinct key a visitor or crawler touches stays resident
// until the cache reaches its entry cap: measured at ~1.4 MB of heap per law
// viewed, none of it released once its TTL had passed. Each cache gets a timer
// the first time an entry is stored in it. The timer is unref'd and holds the
// cache weakly, so it neither keeps the process alive nor outlives the cache.
const CACHE_SWEEP_INTERVAL_MS = 60 * 1000;
const sweptCaches = new WeakSet();

function sweepExpiredEntries(cache, now = Date.now()) {
  for (const [key, entry] of cache) {
    if (now > entry.expiresAt) cache.delete(key);
  }
}

function scheduleSweep(cache) {
  if (sweptCaches.has(cache)) return;
  sweptCaches.add(cache);
  const cacheRef = new WeakRef(cache);
  const timer = setInterval(() => {
    const target = cacheRef.deref();
    if (!target) {
      clearInterval(timer);
      return;
    }
    sweepExpiredEntries(target);
  }, CACHE_SWEEP_INTERVAL_MS);
  timer.unref?.();
}

function cacheRemember(cache, key, entry, maxEntries) {
  scheduleSweep(cache);
  if (cache.size >= maxEntries && !cache.has(key)) {
    // Evict oldest entry (first inserted key in Map iteration order)
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
  cache.set(key, entry);
}

function cacheGet(cache, key) {
  const entry = cache.get(key);
  if (entry) {
    if (Date.now() > entry.expiresAt) {
      cache.delete(key);
    } else {
      return entry.value;
    }
  }

  const persistentStore = getPersistentStore(cache);
  if (!persistentStore) return null;

  const persistedEntry = persistentStore.get(key);
  if (!persistedEntry || Date.now() > persistedEntry.expiresAt) return null;
  const maxEntries = Number.isSafeInteger(persistentStore.maxEntries) && persistentStore.maxEntries > 0
    ? persistentStore.maxEntries
    : DEFAULT_CACHE_MAX_ENTRIES;
  cacheRemember(cache, key, persistedEntry, maxEntries);
  return persistedEntry.value;
}

function cacheSet(cache, key, value, ttlMs, maxEntries = DEFAULT_CACHE_MAX_ENTRIES) {
  const entry = { value, expiresAt: Date.now() + ttlMs };
  cacheRemember(cache, key, entry, maxEntries);

  const persistentStore = getPersistentStore(cache);
  if (persistentStore) {
    persistentStore.set(key, value, entry.expiresAt, maxEntries);
  }
}

class ClientError extends Error {
  constructor(message, statusCode = 500, code = null, details = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function requireCitationGraph(store) {
  if (!store || (typeof store.isReady === 'function' && !store.isReady())) {
    throw new ClientError(
      'The citation graph is not loaded on the server yet. Please try again shortly.',
      503,
      'citation_graph_unavailable'
    );
  }
  return store;
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
  CACHE_SWEEP_INTERVAL_MS,
  ClientError,
  LANG_3_TO_2,
  VALID_LANGS,
  cacheGet,
  cacheSet,
  requireCitationGraph,
  safeErrorResponse,
  sweepExpiredEntries,
  toSearchLang,
  validateLang
};
