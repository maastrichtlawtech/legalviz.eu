import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";

import { PARSER_VERSION } from "./fmxParser.js";

// The cache envelopes are what make a version bump actually invalidate
// anything: `PARSER_VERSION` (parsed laws), `RECITAL_TITLE_CACHE_VERSION` and
// `API_JSON_CACHE_VERSION` are only useful if a mismatched entry is re-parsed,
// re-fetched or discarded rather than served forever. These tests pin that
// behaviour, plus the body validation that keeps a proxy's HTML error page
// from being cached as a law.
//
// A unit test cannot catch a *forgotten* bump — it can only prove that a bump
// takes effect once made.

const DB_NAME = "formex-cache";
const DB_VERSION = 2;
const STORE_NAME = "laws";
const META_STORE_NAME = "lawMeta";

const CELEX = "32020R0001";
const CACHE_KEY = `${CELEX}_ENG`;

const FMX_XML = `<?xml version="1.0" encoding="UTF-8"?>
<COMBINED.FMX>
  <ACT>
    <TITLE><TI><P>Test Regulation (EU) 2020/1</P></TI></TITLE>
    <PREAMBLE>
      <GR.CONSID>
        <CONSID><NP><NO.P>(1)</NO.P><TXT>First recital text.</TXT></NP></CONSID>
      </GR.CONSID>
    </PREAMBLE>
    <ENACTING.TERMS>
      <ARTICLE IDENTIFIER="001">
        <TI.ART>Article 1</TI.ART>
        <STI.ART>Subject matter</STI.ART>
        <ALINEA><P>This Regulation lays down rules.</P></ALINEA>
      </ARTICLE>
    </ENACTING.TERMS>
  </ACT>
</COMBINED.FMX>`;

const EMPTY_FMX_XML = `<?xml version="1.0" encoding="UTF-8"?>
<COMBINED.FMX>
  <ACT>
    <TITLE><TI><P>Empty Regulation</P></TI></TITLE>
    <ENACTING.TERMS></ENACTING.TERMS>
  </ACT>
</COMBINED.FMX>`;

// What a captive portal or misconfigured proxy answers 200 with.
const HTML_ERROR_PAGE = "<!DOCTYPE html><html><body>Sign in to continue</body></html>";

let indexedDb;

async function importFormexApi() {
  vi.resetModules();
  return import("./formexApi.js");
}

function openSeedDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDb.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      if (!db.objectStoreNames.contains(META_STORE_NAME)) db.createObjectStore(META_STORE_NAME, { keyPath: "celex" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function seedCache(key, value) {
  const db = await openSeedDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function readCache(key) {
  const db = await openSeedDb();
  const value = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return value;
}

async function deleteCache(key) {
  const db = await openSeedDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    headers: { get: () => "application/json" },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function textResponse(body, { contentType = "application/xml" } = {}) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => contentType },
    json: async () => { throw new Error("not json"); },
    text: async () => body,
  };
}

beforeEach(() => {
  indexedDb = new IDBFactory();
  vi.stubGlobal("indexedDB", indexedDb);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parsed-law envelope (PARSER_VERSION)", () => {
  it("serves an envelope stamped with the current parser version as-is", async () => {
    const { getCachedLawPayload } = await importFormexApi();
    await seedCache(CACHE_KEY, {
      format: "combined-v1",
      parserVersion: PARSER_VERSION,
      payload: { title: "Cached title", articles: [{}], recitals: [] },
    });

    const result = await getCachedLawPayload(CELEX, "EN");
    expect(result.payload.title).toBe("Cached title");
  });

  it("does not serve a current zero-content envelope", async () => {
    const { getCachedLawPayload } = await importFormexApi();
    await seedCache(CACHE_KEY, {
      format: "combined-v1",
      parserVersion: PARSER_VERSION,
      payload: { title: "Empty cached title", articles: [], recitals: [], annexes: [] },
    });

    expect(await getCachedLawPayload(CELEX, "EN")).toBeNull();
  });

  it("re-parses a stale envelope from its raw XML and re-stamps the cache", async () => {
    const { getCachedLawPayload } = await importFormexApi();
    await seedCache(CACHE_KEY, {
      format: "combined-v1",
      parserVersion: PARSER_VERSION - 1,
      payload: { title: "Parsed by an older version", articles: [{}], recitals: [] },
      rawXml: FMX_XML,
    });

    const result = await getCachedLawPayload(CELEX, "EN");
    expect(result.parserVersion).toBe(PARSER_VERSION);
    expect(result.payload.title).toBe("Test Regulation (EU) 2020/1");
    expect(result.payload.articles).toHaveLength(1);

    // The re-parse is written back, so the next read is free.
    const persisted = await readCache(CACHE_KEY);
    expect(persisted.parserVersion).toBe(PARSER_VERSION);
    expect(persisted.payload.title).toBe("Test Regulation (EU) 2020/1");
  });

  it("discards a stale envelope that has no raw XML to re-parse", async () => {
    const { getCachedLawPayload } = await importFormexApi();
    await seedCache(CACHE_KEY, {
      format: "combined-v1",
      parserVersion: PARSER_VERSION - 1,
      payload: { title: "From an older backend deploy", articles: [] },
    });

    expect(await getCachedLawPayload(CELEX, "EN")).toBeNull();
  });

  it("treats a pre-versioning envelope as stale rather than current", async () => {
    const { getCachedLawPayload } = await importFormexApi();
    await seedCache(CACHE_KEY, {
      format: "combined-v1",
      payload: { title: "Unknown vintage", articles: [] },
    });

    expect(await getCachedLawPayload(CELEX, "EN")).toBeNull();
  });

  it("upgrades a legacy raw-XML cache entry into a stamped envelope", async () => {
    const { getCachedLawPayload } = await importFormexApi();
    await seedCache(CACHE_KEY, FMX_XML);

    const result = await getCachedLawPayload(CELEX, "EN");
    expect(result.parserVersion).toBe(PARSER_VERSION);
    expect(result.payload.title).toBe("Test Regulation (EU) 2020/1");

    const persisted = await readCache(CACHE_KEY);
    expect(persisted.format).toBe("combined-v1");
    expect(persisted.rawXml).toBe(FMX_XML);
  });

  it("does not upgrade a legacy raw-XML cache entry that parses to zero content", async () => {
    const { getCachedLawPayload } = await importFormexApi();
    await seedCache(CACHE_KEY, EMPTY_FMX_XML);

    expect(await getCachedLawPayload(CELEX, "EN")).toBeNull();
    expect(await readCache(CACHE_KEY)).toBe(EMPTY_FMX_XML);
  });

  it("ignores a poisoned raw entry that is not a Formex document", async () => {
    const { getCachedFormex, getCachedLawPayload, hasCachedFormex } = await importFormexApi();
    await seedCache(CACHE_KEY, HTML_ERROR_PAGE);

    expect(await getCachedFormex(CELEX, "EN")).toBeNull();
    expect(await hasCachedFormex(CELEX, "EN")).toBe(false);
    expect(await getCachedLawPayload(CELEX, "EN")).toBeNull();
  });

  it("stamps the parser version the payload reports, not the bundled one", async () => {
    // A /parsed response from another deploy must not be labelled "current":
    // with no rawXml it could never self-heal.
    const { cacheParsedLaw, getCachedLawPayload } = await importFormexApi();
    cacheParsedLaw(CELEX, "EN", { title: "From another deploy", articles: [{}], parserVersion: PARSER_VERSION + 7 }, null);

    await vi.waitFor(async () => {
      expect(await readCache(CACHE_KEY)).not.toBeNull();
    });
    expect((await readCache(CACHE_KEY)).parserVersion).toBe(PARSER_VERSION + 7);
    expect(await getCachedLawPayload(CELEX, "EN")).toBeNull();
  });

  it("does not cache a zero-content payload from the local parser", async () => {
    const { cacheParsedLaw } = await importFormexApi();
    cacheParsedLaw(CELEX, "EN", { title: "Empty law", articles: [], recitals: [], annexes: [] }, null);

    expect(await readCache(CACHE_KEY)).toBeNull();
  });
});

describe("parsed-law fetch persistence", () => {
  it("returns but does not persist a zero-content response or add it to the library", async () => {
    const emptyPayload = { title: "Empty law", articles: [], recitals: [], annexes: [] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(emptyPayload)));

    const { fetchParsedLaw, getLawMeta } = await importFormexApi();
    await expect(fetchParsedLaw(CELEX, "EN")).resolves.toEqual(emptyPayload);
    expect(await readCache(CACHE_KEY)).toBeNull();
    expect(await getLawMeta(CELEX)).toBeNull();
  });

  it("keeps source and consolidatedVersion through the cache round trip (#148 consolidated fallback)", async () => {
    // resolveParsedLaw's consolidated fallback (backend/shared/parsed-law-service.js)
    // stamps a REACH-shaped empty parse with `source: "fmx-consolidated"` and
    // `consolidatedVersion: { celex, date }`. Neither field is in the combined
    // law shape isCombinedLawShape/parseLawPayloadToCombined check for, so this
    // pins that they survive the IndexedDB envelope and getCachedLawPayload
    // rather than being silently dropped as "unknown".
    const consolidatedPayload = {
      title: "REACH",
      articles: [{ number: "1" }],
      recitals: [],
      annexes: [],
      definitions: [],
      source: "fmx-consolidated",
      consolidatedVersion: { celex: "02006R1907-20260511", date: "2026-05-11" },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(consolidatedPayload)));

    const { fetchParsedLaw, getCachedLawPayload } = await importFormexApi();
    const fetched = await fetchParsedLaw(CELEX, "EN");
    expect(fetched.source).toBe("fmx-consolidated");
    expect(fetched.consolidatedVersion).toEqual({ celex: "02006R1907-20260511", date: "2026-05-11" });

    const cached = await getCachedLawPayload(CELEX, "EN");
    expect(cached.payload.source).toBe("fmx-consolidated");
    expect(cached.payload.consolidatedVersion).toEqual({ celex: "02006R1907-20260511", date: "2026-05-11" });
  });
});

describe("law-text fetch body validation", () => {
  it("rejects a non-Formex 200 body and leaves the cache empty", async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse(HTML_ERROR_PAGE, { contentType: "text/html" }));
    vi.stubGlobal("fetch", fetchMock);

    const { fetchFormex } = await importFormexApi();
    await expect(fetchFormex(CELEX, "EN")).rejects.toMatchObject({ code: "fmx_invalid_body", status: 502 });
    expect(await readCache(CACHE_KEY)).toBeNull();
  });

  it("caches a valid Formex body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse(FMX_XML)));

    const { fetchFormex } = await importFormexApi();
    expect(await fetchFormex(CELEX, "EN")).toBe(FMX_XML);
    expect(await readCache(CACHE_KEY)).toBe(FMX_XML);
  });

  it("returns but does not cache or add to the library a well-formed Formex body with zero content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse(EMPTY_FMX_XML)));

    const { fetchFormex, getLawMeta } = await importFormexApi();
    expect(await fetchFormex(CELEX, "EN")).toBe(EMPTY_FMX_XML);
    expect(await readCache(CACHE_KEY)).toBeNull();
    expect(await getLawMeta(CELEX)).toBeNull();
  });
});

describe("API JSON envelope (API_JSON_CACHE_VERSION)", () => {
  const CITED_BY_KEY = `${CELEX}_cited_by_act`;

  async function seedApiJson({ version, cachedAt = Date.now(), payload = { citingLaws: ["cached"] } }) {
    await seedCache(CITED_BY_KEY, { format: "api-json-v1", version, cachedAt, payload });
  }

  async function currentApiJsonVersion() {
    // Read it back off a freshly written envelope rather than hard-coding it,
    // so a bump doesn't need this test edited.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ citingLaws: ["network"] })));
    const { fetchLawCitedBy } = await importFormexApi();
    await fetchLawCitedBy(CELEX);
    const written = await readCache(CITED_BY_KEY);
    await deleteCache(CITED_BY_KEY);
    return written.version;
  }

  it("serves a fresh cached payload without touching the network", async () => {
    const version = await currentApiJsonVersion();
    await seedApiJson({ version });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { fetchLawCitedBy } = await importFormexApi();

    const result = await fetchLawCitedBy(CELEX);
    expect(result).toMatchObject({ citingLaws: ["cached"], localCached: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores an envelope written under an older cache version", async () => {
    const version = await currentApiJsonVersion();
    await seedApiJson({ version: version - 1 });

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ citingLaws: ["network"] }));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchLawCitedBy } = await importFormexApi();

    expect(await fetchLawCitedBy(CELEX)).toMatchObject({ citingLaws: ["network"] });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("revalidates an entry older than the max age", async () => {
    const version = await currentApiJsonVersion();
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await seedApiJson({ version, cachedAt: eightDaysAgo });

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ citingLaws: ["network"] }));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchLawCitedBy } = await importFormexApi();

    expect(await fetchLawCitedBy(CELEX)).toMatchObject({ citingLaws: ["network"] });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("falls back to a stale copy when the server fails, but not on a 404", async () => {
    const version = await currentApiJsonVersion();
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;

    await seedApiJson({ version, cachedAt: eightDaysAgo });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "boom" }, { ok: false, status: 503 })));
    const failing = await importFormexApi();
    expect(await failing.fetchLawCitedBy(CELEX)).toMatchObject({ citingLaws: ["cached"], localCached: true });

    await seedApiJson({ version, cachedAt: eightDaysAgo });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "gone" }, { ok: false, status: 404 })));
    const missing = await importFormexApi();
    await expect(missing.fetchLawCitedBy(CELEX)).rejects.toMatchObject({ status: 404 });
  });
});

describe("recital-title envelope (RECITAL_TITLE_CACHE_VERSION)", () => {
  const TITLES_KEY = `${CELEX}_ENG_recital_titles`;
  const payload = { celex: CELEX, lang: "ENG", titles: { 1: "Cached title" } };

  async function currentRecitalTitleVersion() {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(payload)));
    const { fetchRecitalTitles } = await importFormexApi();
    await fetchRecitalTitles(CELEX, "EN");
    const written = await readCache(TITLES_KEY);
    return written.version;
  }

  it("serves a matching envelope without a network call", async () => {
    const version = await currentRecitalTitleVersion();
    await seedCache(TITLES_KEY, { format: "recital-titles-v1", version, payload });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { fetchRecitalTitles } = await importFormexApi();

    expect(await fetchRecitalTitles(CELEX, "EN")).toMatchObject({ titles: { 1: "Cached title" }, localCached: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-fetches when the envelope predates the current version", async () => {
    const version = await currentRecitalTitleVersion();
    await seedCache(TITLES_KEY, { format: "recital-titles-v1", version: version - 1, payload });

    const fresh = { celex: CELEX, lang: "ENG", titles: { 1: "Fresh title" } };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fresh));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchRecitalTitles } = await importFormexApi();

    expect(await fetchRecitalTitles(CELEX, "EN")).toMatchObject({ titles: { 1: "Fresh title" } });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((await readCache(TITLES_KEY)).version).toBe(version);
  });

  it("treats an envelope with no titles as a miss", async () => {
    const version = await currentRecitalTitleVersion();
    await seedCache(TITLES_KEY, { format: "recital-titles-v1", version, payload: { titles: {} } });

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchRecitalTitles } = await importFormexApi();

    await fetchRecitalTitles(CELEX, "EN");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
