/**
 * Formex API client with local caching (IndexedDB).
 *
 * Fetches EU legislation in Formex XML format from api.legalviz.eu and
 * caches responses locally so repeated loads are instant.
 */

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

// Cache version — bump to invalidate all cached entries
const CACHE_VERSION = 2;
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

// ---------------------------------------------------------------------------
// IndexedDB helpers
// ---------------------------------------------------------------------------

function openDb() {
  return new Promise((resolve, reject) => {
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
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("IndexedDB open blocked"));
    } catch (err) {
      reject(err);
    }
  });
}

function makeCacheKey(celex, lang = "EN") {
  return `${celex}_${toApiLang(lang)}`;
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

function isCombinedLawEnvelope(value) {
  return !!value
    && typeof value === "object"
    && value.format === "combined-v1"
    && typeof value.payload === "object"
    && value.payload != null;
}

function createCombinedLawEnvelope(payload) {
  return {
    format: "combined-v1",
    payload,
  };
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

async function metaPut(value) {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(META_STORE_NAME, "readwrite");
      const store = tx.objectStore(META_STORE_NAME);
      store.put(value);
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => resolve(value);
    });
  } catch {
    return value;
  }
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
    // 1. Try cache first
    const cached = await cacheGet(cacheKey);
    if (typeof cached === "string") {
      console.log(`[FormexAPI] Cache hit: ${cacheKey}`);
      return cached;
    }

    // 2. Fetch from API
    console.log(`[FormexAPI] Fetching: ${celex} (${apiLang})`);
    const url = `${API_BASE}/api/laws/${encodeURIComponent(celex)}?lang=${apiLang}`;
    const res = await fetch(url);

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

    // 3. Cache it
    await cacheSet(cacheKey, xmlText);
    await upsertLawMeta(celex, { cachedAt: Date.now() });
    await pruneCacheIfNeeded(celex, PROTECTED_BUNDLED_CELEXES);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("legalviz-formex-cache-updated", {
        detail: { celex, lang: lang.toUpperCase() },
      }));
    }

    return xmlText;
  });
}

export async function getCachedFormex(celex, lang = "EN") {
  if (!celex) return null;
  const cached = await cacheGet(makeCacheKey(celex, lang));
  return typeof cached === "string" ? cached : null;
}

export async function hasCachedFormex(celex, lang = "EN") {
  return (await getCachedFormex(celex, lang)) != null;
}

export async function getCachedLawPayload(celex, lang = "EN") {
  if (!celex) return null;
  const cached = await cacheGet(makeCacheKey(celex, lang));
  if (typeof cached === "string") return cached;
  if (isCombinedLawEnvelope(cached)) return cached;
  return null;
}

export async function resolveOfficialReference(reference, lang = "EN") {
  const query = buildReferenceQuery(reference, lang);
  const url = `${API_BASE}/api/resolve-reference?${query}`;
  const res = await fetch(url);

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
  const res = await fetch(url);

  if (!res.ok) {
    await readApiError(res, `EUR-Lex URL resolution failed (${res.status})`);
  }

  return res.json();
}

export async function fetchAmendments(celex) {
  const url = `${API_BASE}/api/laws/${encodeURIComponent(celex)}/amendments`;
  const res = await fetch(url);

  if (!res.ok) {
    await readApiError(res, `Amendment history fetch failed (${res.status})`);
  }

  return res.json();
}

export async function fetchLawMetadata(celex) {
  const url = `${API_BASE}/api/laws/${encodeURIComponent(celex)}/metadata`;
  const res = await fetch(url);

  if (!res.ok) {
    await readApiError(res, `Metadata fetch failed (${res.status})`);
  }

  return res.json();
}

export async function fetchCaseLaw(celex) {
  const url = `${API_BASE}/api/laws/${encodeURIComponent(celex)}/case-law`;
  const res = await fetch(url);

  if (!res.ok) {
    await readApiError(res, `Case law fetch failed (${res.status})`);
  }

  return res.json();
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
    const res = await fetch(url);

    if (!res.ok) {
      await readApiError(res, `Recital title fetch failed (${res.status})`);
    }

    const payload = await res.json();
    await cacheSet(cacheKey, createRecitalTitleEnvelope(payload));
    return payload;
  });
}

export async function fetchLawSummary(celex, lang = "EN") {
  const apiLang = toApiLang(lang);
  const key = `${celex}_${apiLang}`;
  return getInFlightRequest(`law-summary:${key}`, async () => {
    const url = `${API_BASE}/api/laws/${encodeURIComponent(celex)}/summary?lang=${apiLang}`;
    const res = await fetch(url);

    if (!res.ok) {
      await readApiError(res, `Law summary fetch failed (${res.status})`);
    }

    return res.json();
  });
}

export async function fetchArticleCaseLawDigest(celex, articleNumber, lang = "EN") {
  const apiLang = toApiLang(lang);
  const key = `${celex}_${articleNumber}_${apiLang}`;
  return getInFlightRequest(`article-case-law-digest:${key}`, async () => {
    const url = `${API_BASE}/api/laws/${encodeURIComponent(celex)}/articles/${encodeURIComponent(articleNumber)}/case-law-digest?lang=${apiLang}`;
    const res = await fetch(url);

    if (!res.ok) {
      await readApiError(res, `Article case-law digest fetch failed (${res.status})`);
    }

    return res.json();
  });
}

export async function fetchImplementingActs(celex) {
  const url = `${API_BASE}/api/laws/${encodeURIComponent(celex)}/implementing`;
  const res = await fetch(url);

  if (!res.ok) {
    await readApiError(res, `Implementing acts fetch failed (${res.status})`);
  }

  return res.json();
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
  const res = await fetch(url, { signal });

  if (!res.ok) {
    await readApiError(res, `Law search failed (${res.status})`);
  }

  return res.json();
}

export async function fetchFormexByReference(reference, lang = "EN") {
  const query = buildReferenceQuery(reference, lang);
  const url = `${API_BASE}/api/laws/by-reference?${query}`;
  const res = await fetch(url);

  if (!res.ok) {
    await readApiError(res, `Formex reference fetch failed (${res.status})`);
  }

  return res.text();
}

export async function fetchParsedLaw(celex, lang = "EN") {
  const apiLang = toApiLang(lang);
  const cacheKey = makeCacheKey(celex, lang);
  return getInFlightRequest(`parsed:${cacheKey}`, async () => {
    const cached = await cacheGet(cacheKey);
    if (isCombinedLawEnvelope(cached)) {
      console.log(`[FormexAPI] Cache hit: ${cacheKey}`);
      return cached.payload;
    }

    const params = new URLSearchParams({ lang: apiLang });
    if (hasKnownMissingFmx(celex, lang)) {
      params.set("skipFmxProbe", "1");
    }
    const url = `${API_BASE}/api/laws/${encodeURIComponent(celex)}/parsed?${params.toString()}`;
    const res = await fetch(url);

    if (!res.ok) {
      await readApiError(res, `Parsed law fetch failed (${res.status})`);
    }

    const payload = await res.json();
    await cacheSet(cacheKey, createCombinedLawEnvelope(payload));
    await upsertLawMeta(celex, { cachedAt: Date.now() });
    await pruneCacheIfNeeded(celex, PROTECTED_BUNDLED_CELEXES);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("legalviz-formex-cache-updated", {
        detail: { celex, lang: lang.toUpperCase() },
      }));
    }

    return payload;
  });
}
