/**
 * Formex API client with local caching (IndexedDB).
 *
 * Fetches EU legislation in Formex XML format from api.legalviz.eu and
 * caches responses locally so repeated loads are instant.
 */

import { PARSER_VERSION, parseFmxToCombined, isFmxDocument } from "./fmxParser.js";
import lawSummaryCacheVersion from "../../backend/shared/law-summary-cache-version.json" with { type: "json" };
import digestCacheVersion from "../../backend/shared/digest-cache-version.json" with { type: "json" };

export const API_BASE = (() => {
  if (typeof import.meta !== "undefined" && import.meta.env?.VITE_FORMEX_API_BASE) {
    return import.meta.env.VITE_FORMEX_API_BASE;
  }

  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1") {
      return "http://localhost:3000";
    }
  }

  return "https://api.legalviz.eu";
})();

/**
 * fetch() wrapper for backend calls. Tags every request with the "web" channel
 * so server-side analytics can tell frontend traffic apart from direct REST API
 * and MCP callers. Use this for all API_BASE requests.
 */
export function apiFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), "x-legalviz-client": "web" },
  });
}

// Cache version — bump to invalidate all cached entries
const CACHE_VERSION = 3;
const RECITAL_TITLE_CACHE_VERSION = 2;
const DB_NAME = "formex-cache";
const STORE_NAME = "laws";
const META_STORE_NAME = "lawMeta";
const MAX_CACHED_CELEX_LAWS = 100;
const PROTECTED_BUNDLED_CELEXES = [];
const IN_FLIGHT_LAW_REQUESTS = new Map();
const KNOWN_MISSING_FMX = new Set();

export class FormexApiError extends Error {
  constructor(message, { status = 500, code = null, details = null, fallback = null } = {}) {
    super(message);
    this.name = "FormexApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.fallback = fallback;
  }
}

// Railway may return a transient gateway/service error while waking the API
// process after an idle period. Keep the retry window bounded so ordinary API
// failures still reach the caller promptly, while giving a cold start time to
// become ready without requiring a page reload (15s total: 1s + 2s + 4s + 8s).
const SEARCH_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

function isTransientSearchError(error) {
  // backend/server.js calls legalCacheStore.load() synchronously before
  // app.listen(), so by the time a request is accepted the store is either
  // ready or permanently failed. legal-cache-store.js's searchLaws() throws
  // this code (via readApiError reading body.code) when isReady() is false —
  // that's a terminal 503, not a cold-start signal, so retrying it only
  // delays the final error by the whole backoff window.
  if (error?.code === "search_cache_unavailable") return false;

  const status = Number(error?.status);
  return (status >= 500 && status <= 599)
    || error?.name === "TypeError"
    || error?.name === "NetworkError";
}

function createAbortError() {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function waitForSearchRetry(delayMs, signal) {
  return new Promise((resolve, reject) => {
    let timeoutId = null;

    const cleanup = () => {
      if (timeoutId !== null) clearTimeout(timeoutId);
      signal?.removeEventListener("abort", handleAbort);
    };

    const handleAbort = () => {
      cleanup();
      reject(createAbortError());
    };

    if (signal?.aborted) {
      handleAbort();
      return;
    }

    timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// IndexedDB helpers
// ---------------------------------------------------------------------------

// A pending indexedDB.deleteDatabase() (e.g. the "reset whole app" flow in
// another tab) queues every later open() behind it, so an open that never
// settles would otherwise hang all cache/meta operations indefinitely.
const OPEN_DB_TIMEOUT_MS = 3000;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;

  const promise = new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    try {
      const req = indexedDB.open(DB_NAME, CACHE_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
        if (!db.objectStoreNames.contains(META_STORE_NAME)) {
          db.createObjectStore(META_STORE_NAME, { keyPath: "celex" });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        if (settled) {
          // The timeout already rejected this attempt; don't leak the handle.
          try { db.close(); } catch { /* ignore */ }
          return;
        }
        // Release the connection when another tab (or the reset flow) asks to
        // delete or upgrade the database. Without this, deleteDatabase() blocks
        // forever and wedges IndexedDB for every tab until browser restart.
        db.onversionchange = () => {
          try { db.close(); } catch { /* ignore */ }
          if (dbPromise === promise) dbPromise = null;
        };
        db.onclose = () => {
          if (dbPromise === promise) dbPromise = null;
        };
        settle(resolve, db);
      };
      req.onerror = () => settle(reject, req.error);
      req.onblocked = () => settle(reject, new Error("IndexedDB open blocked"));
      setTimeout(() => settle(reject, new Error("IndexedDB open timed out")), OPEN_DB_TIMEOUT_MS);
    } catch (err) {
      settle(reject, err);
    }
  });

  dbPromise = promise;
  promise.catch(() => {
    if (dbPromise === promise) dbPromise = null;
  });
  return promise;
}

/**
 * Close this tab's shared IndexedDB connection so a following
 * deleteDatabase() is not blocked by our own handle.
 */
export async function closeFormexDb() {
  const promise = dbPromise;
  dbPromise = null;
  if (!promise) return;
  try {
    const db = await promise;
    db.close();
  } catch {
    // ignore — connection never opened or already closed
  }
}

// `version` is an optional dimension on top of celex+lang (e.g. "current" for
// the consolidated/as-amended reading, added for #149). Omitted, the key is
// unchanged from before this dimension existed, so the as-adopted cache entry
// keeps its historical key. A versioned key still starts with the bare CELEX
// (`32013R0575_ENG_current`), which is all `pruneCacheIfNeeded` and
// `listCachedCelexes` key off (`key.split("_")[0]`) — so the two versions of
// an act group under one library entry and evict together, they just don't
// share a cache slot and can't overwrite one another.
function makeCacheKey(celex, lang = "EN", version = null) {
  const base = `${celex}_${toApiLang(lang)}`;
  return version ? `${base}_${version}` : base;
}

function makeRecitalTitleCacheKey(celex, lang = "EN") {
  return `${makeCacheKey(celex, lang)}_recital_titles`;
}

// Callers must not wire their own AbortSignal into a request made through
// this helper: the underlying fetch is shared by every caller for the same
// key, so one caller unmounting and aborting would cancel the request for
// everyone else waiting on it (including a caller with a fresh signal that
// re-requests the same key before the aborted one has cleared). Consumers
// should instead track their own `cancelled` flag to ignore stale results.
function getInFlightRequest(key, factory) {
  if (IN_FLIGHT_LAW_REQUESTS.has(key)) {
    return IN_FLIGHT_LAW_REQUESTS.get(key);
  }

  const promise = (async () => factory())().finally(() => {
    IN_FLIGHT_LAW_REQUESTS.delete(key);
  });
  IN_FLIGHT_LAW_REQUESTS.set(key, promise);
  return promise;
}

function markMissingFmx(celex, lang = "EN") {
  KNOWN_MISSING_FMX.add(makeCacheKey(celex, lang));
}

function hasKnownMissingFmx(celex, lang = "EN") {
  return KNOWN_MISSING_FMX.has(makeCacheKey(celex, lang));
}

function payloadHasContent(payload) {
  return Boolean(payload && (
    payload.articles?.length || payload.recitals?.length || payload.annexes?.length
  ));
}

function isCombinedLawEnvelope(value) {
  return !!value
    && typeof value === "object"
    && value.format === "combined-v1"
    && typeof value.payload === "object"
    && value.payload != null
    && payloadHasContent(value.payload);
}

function createCombinedLawEnvelope(payload, rawXml = null) {
  // Stamp the envelope with the parser version the payload itself reports
  // (both the Formex and the EUR-Lex HTML parser embed `parserVersion` in
  // their output). For locally-parsed laws this equals the bundled
  // PARSER_VERSION, but a backend `/parsed` response may come from an older
  // (or newer) deploy during a staggered rollout — labeling it with the
  // bundled constant would cache an old-shape payload as "current", and with
  // no rawXml to re-parse it could never self-heal. Fall back to the frontend
  // constant only when the payload doesn't report a version at all.
  //
  // No cache-constant bump is needed for this stamping change: combined-v1
  // envelopes are versioned by `parserVersion` itself (not by
  // API_JSON_CACHE_VERSION, which guards the separate api-json-v1 format, nor
  // by CACHE_VERSION, which is the IndexedDB schema version — neither shape
  // changed). Every envelope the old logic mis-stamped carries the bundled
  // constant of an earlier deploy (≤ 18; PARSER_VERSION became 19 in the same
  // branch as this fix), so the parserVersion-mismatch check in
  // getCachedLawPayload/fetchParsedLaw already re-parses or discards them.
  const reported = payload?.parserVersion;
  const envelope = {
    format: "combined-v1",
    parserVersion: Number.isFinite(reported) ? reported : PARSER_VERSION,
    cachedAt: Date.now(),
    payload,
  };
  if (rawXml) envelope.rawXml = rawXml;
  return envelope;
}

// A consolidated version is addressed as "current", so unlike an as-adopted
// CELEX it can change when EUR-Lex publishes a newer manifestation. Keep the
// offline convenience bounded; otherwise the first successful (or fallback)
// response would be served forever.
const CURRENT_VERSION_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Bump whenever the shape of a cached API payload changes (e.g. renaming a
// summary field) so stale cache-first entries are invalidated rather than
// served for up to API_JSON_CACHE_MAX_AGE_MS under the old shape.
const API_JSON_CACHE_VERSION = 5;
// After this age, cache-first entries are revalidated against the network
// (still served from cache if the network is unavailable).
const API_JSON_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function isApiJsonEnvelope(value) {
  return !!value
    && typeof value === "object"
    && value.format === "api-json-v1"
    && value.version === API_JSON_CACHE_VERSION
    && typeof value.payload === "object"
    && value.payload != null;
}

function createApiJsonEnvelope(payload) {
  return {
    format: "api-json-v1",
    version: API_JSON_CACHE_VERSION,
    cachedAt: Date.now(),
    payload,
  };
}

function shouldFallBackToCache(error) {
  // Offline / network failures surface as TypeError from fetch; server-side
  // trouble (5xx, rate limiting) is also worth papering over with a cached
  // copy. Deliberate 4xx answers (e.g. 404) are not.
  if (!(error instanceof FormexApiError)) return true;
  return error.status >= 500 || error.status === 429;
}

/**
 * Fetch a JSON API response with IndexedDB caching so previously opened
 * laws stay readable offline.
 *
 * `cacheFirst: true` serves a cached copy immediately (revalidating only
 * once it is older than `maxAgeMs`); otherwise the network is tried first
 * and the cache is used as an offline fallback.
 */
async function fetchJsonWithCache({
  cacheKey,
  url,
  errorLabel,
  cacheFirst = false,
  maxAgeMs = API_JSON_CACHE_MAX_AGE_MS,
  validatePayload = null,
}) {
  const cached = await cacheGet(cacheKey);
  const envelope = isApiJsonEnvelope(cached) ? cached : null;

  if (cacheFirst && envelope && Date.now() - envelope.cachedAt < maxAgeMs) {
    console.log(`[FormexAPI] Cache hit: ${cacheKey}`);
    return { ...envelope.payload, cached: true, localCached: true };
  }

  try {
    const res = await apiFetch(url);
    if (!res.ok) {
      await readApiError(res, `${errorLabel} (${res.status})`);
    }
    const payload = await res.json();
    if (typeof validatePayload === "function" && !validatePayload(payload)) {
      throw new FormexApiError(`${errorLabel} returned an incompatible version`, {
        status: 409,
        code: "cache_version_mismatch",
      });
    }
    await cacheSet(cacheKey, createApiJsonEnvelope(payload));
    return payload;
  } catch (error) {
    if (envelope && shouldFallBackToCache(error)) {
      console.log(`[FormexAPI] Serving stale cache after fetch failure: ${cacheKey}`);
      return { ...envelope.payload, cached: true, localCached: true };
    }
    throw error;
  }
}

function isRecitalTitleEnvelope(value) {
  return !!value
    && typeof value === "object"
    && value.format === "recital-titles-v1"
    && value.version === RECITAL_TITLE_CACHE_VERSION
    && value.payload
    && typeof value.payload === "object"
    && value.payload.titles
    && typeof value.payload.titles === "object"
    && Object.keys(value.payload.titles).length > 0;
}

function createRecitalTitleEnvelope(payload) {
  return {
    format: "recital-titles-v1",
    version: RECITAL_TITLE_CACHE_VERSION,
    cachedAt: Date.now(),
    payload,
  };
}

async function cacheGet(key) {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function cacheSet(key, value) {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Silently ignore cache write failures
  }
}

async function cacheDeleteKeys(keys) {
  if (!Array.isArray(keys) || keys.length === 0) return;
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      keys.forEach((key) => store.delete(key));
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // ignore
  }
}

async function metaGet(celex) {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(META_STORE_NAME, "readonly");
      const store = tx.objectStore(META_STORE_NAME);
      const req = store.get(celex);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

// Persists user data (library entries, resume positions), so failures must
// surface as rejections rather than silently masquerading as success — a save
// that vanishes under quota pressure/private browsing would otherwise be
// indistinguishable from one that succeeded.
async function metaPut(value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE_NAME, "readwrite");
    const store = tx.objectStore(META_STORE_NAME);
    store.put(value);
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error || new Error("IndexedDB meta write failed"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB meta write aborted"));
  });
}

async function metaDelete(celex) {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(META_STORE_NAME, "readwrite");
      const store = tx.objectStore(META_STORE_NAME);
      store.delete(celex);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // ignore
  }
}

async function metaGetAll() {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(META_STORE_NAME, "readonly");
      const store = tx.objectStore(META_STORE_NAME);
      if (typeof store.getAll === "function") {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result ?? []);
        req.onerror = () => resolve([]);
        return;
      }

      const rows = [];
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve(rows);
          return;
        }
        rows.push(cursor.value);
        cursor.continue();
      };
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

export async function listCachedCelexes() {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);

      const finalize = (keys) => {
        const celexes = Array.from(new Set(
          (keys || [])
            .map((key) => String(key || ""))
            .map((key) => key.split("_")[0])
            .filter(Boolean)
        ));
        resolve(celexes);
      };

      if (typeof store.getAllKeys === "function") {
        const req = store.getAllKeys();
        req.onsuccess = () => finalize(req.result);
        req.onerror = () => resolve([]);
        return;
      }

      const keys = [];
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          finalize(keys);
          return;
        }
        keys.push(cursor.key);
        cursor.continue();
      };
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

async function listCachedKeys() {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);

      const finalize = (keys) => resolve((keys || []).map((key) => String(key || "")).filter(Boolean));

      if (typeof store.getAllKeys === "function") {
        const req = store.getAllKeys();
        req.onsuccess = () => finalize(req.result);
        req.onerror = () => resolve([]);
        return;
      }

      const keys = [];
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          finalize(keys);
          return;
        }
        keys.push(cursor.key);
        cursor.continue();
      };
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

export async function getLawMeta(celex) {
  if (!celex) return null;
  return metaGet(celex);
}

export async function getAllLawMeta() {
  return metaGetAll();
}

export async function upsertLawMeta(celex, updates = {}) {
  if (!celex) return null;
  const existing = await metaGet(celex);
  const next = {
    ...(existing || {}),
    ...updates,
    celex,
  };
  return metaPut(next);
}

async function pruneCacheIfNeeded(protectedCelex = null, protectedCelexes = []) {
  const keys = await listCachedKeys();
  const celexToKeys = new Map();
  keys.forEach((key) => {
    const celex = key.split("_")[0];
    if (!celex) return;
    const existing = celexToKeys.get(celex) || [];
    existing.push(key);
    celexToKeys.set(celex, existing);
  });

  if (celexToKeys.size <= MAX_CACHED_CELEX_LAWS) return;

  const allMeta = await metaGetAll();
  const metaByCelex = new Map(allMeta.filter((entry) => entry?.celex).map((entry) => [entry.celex, entry]));
  const protectedSet = new Set([protectedCelex, ...protectedCelexes].filter(Boolean));
  const candidates = Array.from(celexToKeys.keys())
    .filter((celex) => !protectedSet.has(celex))
    .map((celex) => {
      const meta = metaByCelex.get(celex) || {};
      return {
        celex,
        recency: meta.lastOpened || meta.cachedAt || meta.addedAt || 0,
      };
    })
    .sort((a, b) => {
      return a.recency - b.recency;
    });

  const overflow = celexToKeys.size - MAX_CACHED_CELEX_LAWS;
  const toEvict = candidates.slice(0, overflow);

  for (const entry of toEvict) {
    await cacheDeleteKeys(celexToKeys.get(entry.celex) || []);
    await metaDelete(entry.celex);
  }

  if (typeof window !== "undefined" && toEvict.length > 0) {
    try {
      window.dispatchEvent(new CustomEvent("legalviz-library-updated", {
        detail: { evictedCelexes: toEvict.map((entry) => entry.celex) },
      }));
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// API language code mapping
// ---------------------------------------------------------------------------

/**
 * Map from the 2-letter language codes used internally (EN, PL, etc.)
 * to the 3-letter codes expected by the Formex API.
 */
const LANG_MAP = {
  BG: "BUL", CS: "CES", DA: "DAN", DE: "DEU", EL: "ELL",
  EN: "ENG", ET: "EST", FI: "FIN", FR: "FRA", GA: "GLE",
  HR: "HRV", HU: "HUN", IT: "ITA", LV: "LAV", LT: "LIT",
  MT: "MLT", NL: "NLD", PL: "POL", PT: "POR", RO: "RON",
  SK: "SLK", SL: "SLV", ES: "SPA", SV: "SWE",
};

/** All available EU languages for the UI picker (2-letter code → label). */
export const EU_LANGUAGES = {
  BG: "Bulgarian", CS: "Czech", DA: "Danish", DE: "German", EL: "Greek",
  EN: "English", ET: "Estonian", FI: "Finnish", FR: "French", GA: "Irish",
  HR: "Croatian", HU: "Hungarian", IT: "Italian", LV: "Latvian", LT: "Lithuanian",
  MT: "Maltese", NL: "Dutch", PL: "Polish", PT: "Portuguese", RO: "Romanian",
  SK: "Slovak", SL: "Slovenian", ES: "Spanish", SV: "Swedish",
};

export function toApiLang(twoLetter) {
  return LANG_MAP[twoLetter?.toUpperCase()] || "ENG";
}

async function readApiError(res, fallbackMessage) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    // ignore
  }

  throw new FormexApiError(body?.error || fallbackMessage || res.statusText, {
    status: res.status,
    code: body?.code || null,
    details: body?.details || null,
    fallback: body?.details?.fallback || body?.fallback || null,
  });
}

function buildReferenceQuery(reference, lang = "EN") {
  const apiLang = toApiLang(lang);
  const params = new URLSearchParams({ lang: apiLang });

  for (const [key, value] of Object.entries(reference || {})) {
    if (value != null && value !== "") {
      params.set(key, String(value));
    }
  }

  return params.toString();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch a law's Formex XML from the API, with local caching.
 *
 * @param {string} celex  CELEX identifier, e.g. "32016R0679"
 * @param {string} lang   2-letter language code, e.g. "EN"
 * @returns {Promise<string>}  Raw Formex XML text
 */
export async function fetchFormex(celex, lang = "EN") {
  const apiLang = toApiLang(lang);
  const cacheKey = makeCacheKey(celex, lang);
  return getInFlightRequest(`formex:${cacheKey}`, async () => {
    // 1. Try cache first — raw XML string (legacy) or envelope with rawXml.
    // Raw strings are validated with isFmxDocument, mirroring
    // getCachedLawPayload: an entry poisoned before body validation existed
    // (e.g. a proxy's HTML error page cached as "XML") must be a cache miss
    // here too, or it gets served forever while the payload path rejects it.
    const cached = await cacheGet(cacheKey);
    if (typeof cached === "string") {
      if (isFmxDocument(cached)) {
        console.log(`[FormexAPI] Cache hit (raw): ${cacheKey}`);
        return cached;
      }
      console.log(`[FormexAPI] Ignoring invalid raw cache entry: ${cacheKey}`);
    }
    if (isCombinedLawEnvelope(cached) && cached.rawXml) {
      console.log(`[FormexAPI] Cache hit (envelope rawXml): ${cacheKey}`);
      return cached.rawXml;
    }

    // 2. Fetch from API
    console.log(`[FormexAPI] Fetching: ${celex} (${apiLang})`);
    const url = `${API_BASE}/api/laws/${encodeURIComponent(celex)}?lang=${apiLang}`;
    const res = await apiFetch(url);

    if (!res.ok) {
      try {
        await readApiError(res, `Formex API error ${res.status}`);
      } catch (error) {
        if (error instanceof FormexApiError && (
          error.status === 404
          || error.code === "fmx_not_found"
          || error.code === "law_not_found"
        )) {
          markMissingFmx(celex, lang);
        }
        throw error;
      }
    }

    const contentType = res.headers.get("content-type") || "";

    let xmlText;
    if (contentType.includes("application/json")) {
      // API may wrap XML in a JSON envelope
      const json = await res.json();
      xmlText = json.xml || json.content || json.data || JSON.stringify(json);
    } else {
      xmlText = await res.text();
    }

    // 3. Validate before caching. A proxy/captive portal can answer 200 with
    // an HTML error page, and the JSON branch above can stringify a non-XML
    // envelope — caching such a body would poison the entry (it parses to a
    // generic Error later, which the /parsed fallback doesn't recognize,
    // leaving the law permanently unloadable). Throw a FormexApiError that
    // isMissingStructuredLawText (src/utils/law-viewer/errors.js) matches on
    // its "formex … not available" message, so callers fall back to /parsed.
    // Deliberately no markMissingFmx: the bad body may be transient.
    if (typeof xmlText !== "string" || !isFmxDocument(xmlText)) {
      throw new FormexApiError(
        `Formex XML not available for ${celex}: response body is not a Formex document`,
        { status: 502, code: "fmx_invalid_body" },
      );
    }

    // 4. Cache it — but only when it actually parses to a law with content.
    // A response can be a well-formed Formex document with zero articles/
    // recitals/annexes (see #148/#153: REACH has no as-adopted manifestation
    // at all). Caching that raw XML would let it be served forever as a
    // "cache hit" — this function's own cache-read check above only
    // validates isFmxDocument, not content — and would add the law to the
    // library via upsertLawMeta even though it can never be read. Skip
    // persistence in that case; still return the XML so the caller renders
    // the empty-content notice instead of a load error. On an unexpected
    // parse failure here, cache as before rather than block on a check this
    // function doesn't otherwise need to make.
    let hasContent = true;
    try {
      hasContent = payloadHasContent(parseFmxToCombined(xmlText));
    } catch {
      // ignore — isFmxDocument already validated the shape above
    }

    if (hasContent) {
      await cacheSet(cacheKey, xmlText);
      await upsertLawMeta(celex, { cachedAt: Date.now() }).catch((err) => {
        console.warn(`[FormexAPI] Failed to persist library metadata for ${celex}:`, err);
      });
      await pruneCacheIfNeeded(celex, PROTECTED_BUNDLED_CELEXES);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("legalviz-formex-cache-updated", {
          detail: { celex, lang: lang.toUpperCase() },
        }));
      }
    }

    return xmlText;
  });
}

export async function getCachedFormex(celex, lang = "EN") {
  if (!celex) return null;
  const cached = await cacheGet(makeCacheKey(celex, lang));
  // Same validation as fetchFormex/getCachedLawPayload: a poisoned raw entry
  // (cached before body validation existed) is a miss, not a hit.
  if (typeof cached === "string") return isFmxDocument(cached) ? cached : null;
  if (isCombinedLawEnvelope(cached) && cached.rawXml) return cached.rawXml;
  return null;
}

export async function getCachedLawPayload(celex, lang = "EN") {
  if (!celex) return null;
  const cacheKey = makeCacheKey(celex, lang);
  const cached = await cacheGet(cacheKey);

  // Raw XML string (legacy cache entry) — parse, upgrade to envelope, return
  if (typeof cached === "string" && isFmxDocument(cached)) {
    console.log(`[FormexAPI] Upgrading raw XML cache to envelope: ${cacheKey}`);
    try {
      const payload = parseFmxToCombined(cached);
      if (!payloadHasContent(payload)) return null;
      await cacheSet(cacheKey, createCombinedLawEnvelope(payload, cached));
      return createCombinedLawEnvelope(payload);
    } catch {
      // Unparseable despite looking like Formex — treat as a miss so the
      // caller re-fetches instead of surfacing a dead-end load error.
      return null;
    }
  }

  if (isCombinedLawEnvelope(cached)) {
    // Current version — serve directly
    if (cached.parserVersion === PARSER_VERSION) return cached;
    // Stale — including pre-versioning envelopes (parserVersion == null),
    // whose parser vintage is unknown. These used to be stamped as current
    // here, but an unknown-vintage payload may predate shape changes, so it
    // is treated exactly like any other stale entry: re-parse from raw XML
    // when we have it, otherwise discard so the caller re-fetches.
    if (typeof cached.rawXml === "string" && isFmxDocument(cached.rawXml)) {
      console.log(`[FormexAPI] Re-parsing stale cache (parser v${cached.parserVersion ?? "pre-versioning"} → v${PARSER_VERSION}): ${cacheKey}`);
      try {
        const payload = parseFmxToCombined(cached.rawXml);
        if (!payloadHasContent(payload)) return null;
        const envelope = createCombinedLawEnvelope(payload, cached.rawXml);
        await cacheSet(cacheKey, envelope);
        return envelope;
      } catch {
        return null;
      }
    }
    // Stale envelope without (valid) raw XML — e.g. a /parsed response from
    // an older backend deploy — discard so the caller re-fetches.
    console.log(`[FormexAPI] Stale cache, no raw XML available: ${cacheKey}`);
    return null;
  }

  return null;
}

/**
 * Cache a locally-parsed law result alongside its raw XML so subsequent
 * loads skip parsing and parser upgrades can re-parse from the stored XML.
 */
export function cacheParsedLaw(celex, lang, payload, rawXml) {
  if (!payloadHasContent(payload)) return;
  const cacheKey = makeCacheKey(celex, lang);
  // Fire-and-forget: callers don't await this, so failures must not become
  // unhandled promise rejections. Matches cacheSet's own silent-ignore policy.
  cacheSet(cacheKey, createCombinedLawEnvelope(payload, rawXml)).catch(() => {});
}

export async function resolveOfficialReference(reference, lang = "EN") {
  const query = buildReferenceQuery(reference, lang);
  const url = `${API_BASE}/api/resolve-reference?${query}`;
  const res = await apiFetch(url);

  if (!res.ok) {
    await readApiError(res, `Reference resolution failed (${res.status})`);
  }

  return res.json();
}

export async function resolveEurlexUrl(sourceUrl, lang = "EN") {
  const apiLang = toApiLang(lang);
  const params = new URLSearchParams({
    url: sourceUrl,
    lang: apiLang,
  });
  const url = `${API_BASE}/api/resolve-url?${params.toString()}`;
  const res = await apiFetch(url);

  if (!res.ok) {
    await readApiError(res, `EUR-Lex URL resolution failed (${res.status})`);
  }

  return res.json();
}

/**
 * Fetches the build timestamps the offline pipeline stamps onto each dataset
 * ("when was our dataset last updated"). Not cached — it's a single cheap
 * lookup, and staleness would defeat the point. Callers should fetch lazily
 * and tolerate failure silently (see Landing.jsx): this is a nice-to-have
 * footnote, never something that should block or error the UI.
 */
export async function fetchDatasetMeta() {
  const res = await apiFetch(`${API_BASE}/api/meta`);
  if (!res.ok) {
    await readApiError(res, `Dataset metadata fetch failed (${res.status})`);
  }
  return res.json();
}

export async function fetchAmendments(celex) {
  return getInFlightRequest(`amendments:${celex}`, () => fetchJsonWithCache({
    cacheKey: `${celex}_amendments`,
    url: `${API_BASE}/api/laws/${encodeURIComponent(celex)}/amendments`,
    errorLabel: "Amendment history fetch failed",
  }));
}

export async function fetchConsolidatedVersions(celex) {
  return getInFlightRequest(`consolidated:${celex}`, () => fetchJsonWithCache({
    cacheKey: `${celex}_consolidated`,
    url: `${API_BASE}/api/laws/${encodeURIComponent(celex)}/consolidated`,
    errorLabel: "Consolidated version lookup failed",
  }));
}

export async function fetchLawMetadata(celex) {
  return getInFlightRequest(`metadata:${celex}`, () => fetchJsonWithCache({
    cacheKey: `${celex}_metadata`,
    url: `${API_BASE}/api/laws/${encodeURIComponent(celex)}/metadata`,
    errorLabel: "Metadata fetch failed",
  }));
}

export async function fetchCaseLaw(celex) {
  return getInFlightRequest(`case-law:${celex}`, () => fetchJsonWithCache({
    cacheKey: `${celex}_case_law`,
    url: `${API_BASE}/api/laws/${encodeURIComponent(celex)}/case-law`,
    errorLabel: "Case law fetch failed",
  }));
}

export async function fetchRecitalTitles(celex, lang = "EN") {
  const apiLang = toApiLang(lang);
  const cacheKey = makeRecitalTitleCacheKey(celex, lang);
  return getInFlightRequest(`recital-titles:${cacheKey}`, async () => {
    const cached = await cacheGet(cacheKey);
    if (isRecitalTitleEnvelope(cached)) {
      console.log(`[FormexAPI] Recital title cache hit: ${cacheKey}`);
      return {
        ...cached.payload,
        cached: true,
        localCached: true,
      };
    }

    const url = `${API_BASE}/api/laws/${encodeURIComponent(celex)}/recital-titles?lang=${apiLang}`;
    const res = await apiFetch(url);

    if (!res.ok) {
      await readApiError(res, `Recital title fetch failed (${res.status})`);
    }

    const payload = await res.json();
    await cacheSet(cacheKey, createRecitalTitleEnvelope(payload));
    return payload;
  });
}

// Law summaries are generated in English only for now, regardless of the
// reading language.
export function makeLawSummaryCacheKey(celex) {
  const { cacheVersion, schemaVersion, promptVersion } = lawSummaryCacheVersion;
  return `${celex}_ENG_summary_v${cacheVersion}_schema${schemaVersion}_prompt${promptVersion}`;
}

function isCurrentLawSummaryPayload(payload) {
  return payload?.cacheVersion === lawSummaryCacheVersion.cacheVersion
    && payload?.schemaVersion === lawSummaryCacheVersion.schemaVersion
    && payload?.promptVersion === lawSummaryCacheVersion.promptVersion;
}

export async function fetchLawSummary(celex) {
  const key = makeLawSummaryCacheKey(celex);
  return getInFlightRequest(`law-summary:${key}`, () => fetchJsonWithCache({
    cacheKey: key,
    url: `${API_BASE}/api/laws/${encodeURIComponent(celex)}/summary?lang=ENG`,
    errorLabel: "Law summary fetch failed",
    cacheFirst: true,
    validatePayload: isCurrentLawSummaryPayload,
  }));
}

export function makeArticleCaseLawDigestCacheKey(celex, articleNumber, lang = "EN") {
  const { schemaVersion, promptVersion } = digestCacheVersion.articleDigest;
  return `${celex}_${toApiLang(lang)}_digest_${articleNumber}_schema${schemaVersion}_prompt${promptVersion}`;
}

export function makeCaseLawDigestCacheKey(celex, lang = "EN") {
  const { schemaVersion, promptVersion } = digestCacheVersion.caseLawDigest;
  return `${celex}_${toApiLang(lang)}_case_law_digest_schema${schemaVersion}_prompt${promptVersion}`;
}

// Digest responses don't stamp schema/prompt versions — the key above folds
// them in — but they do stamp the case-law enrichment version, so a stale
// enrichment shape is still rejected rather than served from cache.
function isCurrentArticleCaseLawDigestPayload(payload) {
  return payload?.caseLawCacheVersion === digestCacheVersion.caseLawCacheVersion;
}

function isCurrentCaseLawDigestPayload(payload) {
  return payload?.caseLawCacheVersion === digestCacheVersion.caseLawCacheVersion;
}

// Cited-by payloads carry no version fields, so their keys are not versioned;
// the structural checks only guard against caching a non-conforming body.
function isArticleCitedByPayload(payload) {
  return !!payload
    && typeof payload === "object"
    && Array.isArray(payload.citingProvisions)
    && Array.isArray(payload.citingJudgments)
    && !!payload.counts
    && Number.isFinite(payload.counts.total);
}

function isLawCitedByPayload(payload) {
  return !!payload
    && typeof payload === "object"
    && !!payload.citingLaws
    && Array.isArray(payload.citingLaws.laws)
    && !!payload.totals
    && Number.isFinite(payload.totals.total);
}

export async function fetchArticleCaseLawDigest(celex, articleNumber, lang = "EN") {
  const apiLang = toApiLang(lang);
  const key = makeArticleCaseLawDigestCacheKey(celex, articleNumber, lang);
  return getInFlightRequest(`article-case-law-digest:${key}`, () => fetchJsonWithCache({
    cacheKey: key,
    url: `${API_BASE}/api/laws/${encodeURIComponent(celex)}/articles/${encodeURIComponent(articleNumber)}/case-law-digest?lang=${apiLang}`,
    errorLabel: "Article case-law digest fetch failed",
    cacheFirst: true,
    validatePayload: isCurrentArticleCaseLawDigestPayload,
  }));
}

export async function fetchArticleCitedBy(celex, articleNumber) {
  const key = `${celex}_cited_by_${articleNumber}`;
  return getInFlightRequest(`article-cited-by:${key}`, () => fetchJsonWithCache({
    cacheKey: key,
    url: `${API_BASE}/api/laws/${encodeURIComponent(celex)}/articles/${encodeURIComponent(articleNumber)}/cited-by?limit=200`,
    errorLabel: "Article cited-by fetch failed",
    cacheFirst: true,
    validatePayload: isArticleCitedByPayload,
  }));
}

export async function fetchLawCitedBy(celex) {
  const key = `${celex}_cited_by_act`;
  return getInFlightRequest(`law-cited-by:${key}`, () => fetchJsonWithCache({
    cacheKey: key,
    url: `${API_BASE}/api/laws/${encodeURIComponent(celex)}/cited-by?citingLaws=10`,
    errorLabel: "Law cited-by fetch failed",
    cacheFirst: true,
    validatePayload: isLawCitedByPayload,
  }));
}

export async function fetchCaseLawDigest(celex, lang = "EN") {
  const apiLang = toApiLang(lang);
  const key = makeCaseLawDigestCacheKey(celex, lang);
  return getInFlightRequest(`case-law-digest:${key}`, () => fetchJsonWithCache({
    cacheKey: key,
    url: `${API_BASE}/api/laws/${encodeURIComponent(celex)}/case-law-digest?lang=${apiLang}`,
    errorLabel: "Case-law digest fetch failed",
    cacheFirst: true,
    validatePayload: isCurrentCaseLawDigestPayload,
  }));
}

export async function fetchImplementingActs(celex) {
  return getInFlightRequest(`implementing:${celex}`, () => fetchJsonWithCache({
    cacheKey: `${celex}_implementing`,
    url: `${API_BASE}/api/laws/${encodeURIComponent(celex)}/implementing`,
    errorLabel: "Implementing acts fetch failed",
  }));
}

export async function searchLaws(query, { limit = 10, noRewrite = false, signal } = {}) {
  const params = new URLSearchParams({
    q: String(query || "").trim(),
    limit: String(limit),
  });

  if (noRewrite) {
    params.set("noRewrite", "1");
  }

  const url = `${API_BASE}/api/search?${params.toString()}`;
  let retryIndex = 0;

  while (true) {
    try {
      const res = await apiFetch(url, { signal });

      if (!res.ok) {
        await readApiError(res, `Law search failed (${res.status})`);
      }

      return await res.json();
    } catch (error) {
      if (
        error?.name === "AbortError"
        || !isTransientSearchError(error)
        || retryIndex >= SEARCH_RETRY_DELAYS_MS.length
      ) {
        throw error;
      }

      await waitForSearchRetry(SEARCH_RETRY_DELAYS_MS[retryIndex], signal);
      retryIndex += 1;
    }
  }
}

export async function searchDefinitions(query, { limit = 10, filter = "", signal } = {}) {
  const params = new URLSearchParams({
    q: String(query || "").trim(),
    limit: String(limit),
  });
  if (filter) params.set("filter", filter);
  const url = `${API_BASE}/api/definitions/search?${params.toString()}`;
  const res = await apiFetch(url, { signal });

  if (!res.ok) {
    await readApiError(res, `Definition search failed (${res.status})`);
  }

  return res.json();
}

/**
 * Search the English body text of all indexed EU law units.
 *
 * The response is intentionally not cached: this endpoint is a live,
 * rate-limited query surface and callers pass an AbortSignal while typing.
 */
export async function searchFulltext(query, { limit = 10, signal } = {}) {
  const params = new URLSearchParams({
    q: String(query || "").trim(),
    limit: String(limit),
  });
  const url = `${API_BASE}/api/fulltext-search?${params.toString()}`;
  const res = await apiFetch(url, { signal });

  if (!res.ok) {
    await readApiError(res, `Full-text search failed (${res.status})`);
  }

  return res.json();
}

export async function fetchDefinitionComparison(term, { signal } = {}) {
  const params = new URLSearchParams({ term: String(term || "").trim() });
  const url = `${API_BASE}/api/definitions/compare?${params.toString()}`;
  const res = await apiFetch(url, { signal });

  if (!res.ok) {
    await readApiError(res, `Definition comparison failed (${res.status})`);
  }

  return res.json();
}

/**
 * Bulk CELEX → EuroVoc topics lookup. Returns a `{ CELEX: string[] }` map;
 * CELEX ids without known topics are simply omitted. Used to backfill topics
 * onto library laws opened before topics were persisted.
 */
export async function fetchTopicsForCelexes(celexes, { signal } = {}) {
  const unique = Array.from(new Set(
    (Array.isArray(celexes) ? celexes : [])
      .map((celex) => String(celex || "").trim().toUpperCase())
      .filter(Boolean),
  ));
  if (unique.length === 0) return {};

  const params = new URLSearchParams({ celex: unique.join(",") });
  const url = `${API_BASE}/api/topics?${params.toString()}`;
  const res = await apiFetch(url, { signal });

  if (!res.ok) {
    await readApiError(res, `Topic lookup failed (${res.status})`);
  }

  const payload = await res.json();
  return payload?.topics && typeof payload.topics === "object" ? payload.topics : {};
}

// `version` — only the literal "current" is meaningful today (#149's first
// slice; the backend 400s on anything else) — asks the backend for the
// consolidated ("as amended") reading instead of the act as adopted. It is
// forwarded both as a query param and as a cache-key dimension (via
// `makeCacheKey`): the two readings are different documents that happen to
// share a CELEX, and without the key dimension whichever one loaded last
// would silently overwrite the other in IndexedDB.
export async function fetchParsedLaw(celex, lang = "EN", { version = null } = {}) {
  const apiLang = toApiLang(lang);
  const cacheKey = makeCacheKey(celex, lang, version);
  return getInFlightRequest(`parsed:${cacheKey}`, async () => {
    const cached = await cacheGet(cacheKey);
    const isFreshCurrentVersion = version !== "current"
      || (
        Number.isFinite(cached?.cachedAt)
        && Date.now() - cached.cachedAt < CURRENT_VERSION_CACHE_MAX_AGE_MS
        && cached.payload?.version === "current"
        && !cached.payload?.versionUnavailable
      );
    if (isCombinedLawEnvelope(cached) && cached.parserVersion === PARSER_VERSION && isFreshCurrentVersion) {
      console.log(`[FormexAPI] Cache hit: ${cacheKey}`);
      return cached.payload;
    }

    const params = new URLSearchParams({ lang: apiLang });
    if (hasKnownMissingFmx(celex, lang)) {
      params.set("skipFmxProbe", "1");
    }
    if (version) {
      params.set("version", version);
    }
    const url = `${API_BASE}/api/laws/${encodeURIComponent(celex)}/parsed?${params.toString()}`;
    const res = await apiFetch(url);

    if (!res.ok) {
      await readApiError(res, `Parsed law fetch failed (${res.status})`);
    }

    const payload = await res.json();
    // A requested current version that fell back to the as-adopted text is
    // deliberately not persisted: a transient outage must not poison this
    // mutable selector until the user clears site data.
    const cacheablePayload = version !== "current"
      || (payload.version === "current" && !payload.versionUnavailable);
    if (payloadHasContent(payload) && cacheablePayload) {
      await cacheSet(cacheKey, createCombinedLawEnvelope(payload));
      await upsertLawMeta(celex, { cachedAt: Date.now() }).catch((err) => {
        console.warn(`[FormexAPI] Failed to persist library metadata for ${celex}:`, err);
      });
      await pruneCacheIfNeeded(celex, PROTECTED_BUNDLED_CELEXES);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("legalviz-formex-cache-updated", {
          detail: { celex, lang: lang.toUpperCase() },
        }));
      }
    }

    return payload;
  });
}
