import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { PARSER_VERSION } from "./fmxParser.js";

// Minimal body that satisfies isFmxDocument (contains "<ACT", "formex",
// "<ENACTING.TERMS") without needing to be fully parseable in these tests —
// the code paths under test never run parseFmxToCombined on it.
const VALID_FMX = '<?xml version="1.0"?><ACT xmlns="http://formex.publications.europa.eu"><ENACTING.TERMS></ENACTING.TERMS></ACT>';
const HTML_ERROR_PAGE = "<html><head><title>502</title></head><body>Bad gateway</body></html>";
const CACHE_KEY = "32016R0679_ENG";

async function importFormexApi() {
  vi.resetModules();
  return import("./formexApi.js");
}

function xmlResponse(body, contentType = "application/xml") {
  return {
    ok: true,
    status: 200,
    headers: { get: () => contentType },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function openExistingDb(indexedDb) {
  return new Promise((resolve, reject) => {
    const req = indexedDb.open("formex-cache");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// The module must have opened the database once already (so the object stores
// exist) before these helpers are used.
async function putLawEntry(indexedDb, key, value) {
  const db = await openExistingDb(indexedDb);
  await new Promise((resolve, reject) => {
    const tx = db.transaction("laws", "readwrite");
    tx.objectStore("laws").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function getLawEntry(indexedDb, key) {
  const db = await openExistingDb(indexedDb);
  const value = await new Promise((resolve, reject) => {
    const tx = db.transaction("laws", "readonly");
    const req = tx.objectStore("laws").get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return value;
}

describe("formexApi cache hygiene", () => {
  let indexedDb;

  beforeEach(() => {
    indexedDb = new IDBFactory();
    vi.stubGlobal("indexedDB", indexedDb);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("fetchFormex body validation (poisoned-cache path)", () => {
    it("rejects a 200 HTML error body without caching it, with an error the /parsed fallback recognizes", async () => {
      const fetchMock = vi.fn(async () => xmlResponse(HTML_ERROR_PAGE, "text/html"));
      vi.stubGlobal("fetch", fetchMock);

      const api = await importFormexApi();

      let caught = null;
      try {
        await api.fetchFormex("32016R0679", "EN");
      } catch (error) {
        caught = error;
      }

      expect(caught).not.toBeNull();
      expect(caught.name).toBe("FormexApiError");
      expect(caught.code).toBe("fmx_invalid_body");

      // The whole point of validating: the caller's catch must route this to
      // the /parsed fallback instead of a dead-end generic error.
      const { isMissingStructuredLawText } = await import("./law-viewer/errors.js");
      expect(isMissingStructuredLawText(caught)).toBe(true);

      // Nothing was written to the cache.
      expect(await getLawEntry(indexedDb, CACHE_KEY)).toBeUndefined();
      expect(await api.getCachedFormex("32016R0679", "EN")).toBeNull();
      expect(await api.hasCachedFormex("32016R0679", "EN")).toBe(false);
    });

    it("rejects a JSON envelope that does not contain Formex XML without caching it", async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ error: "upstream unavailable" }));
      vi.stubGlobal("fetch", fetchMock);

      const api = await importFormexApi();

      await expect(api.fetchFormex("32016R0679", "EN")).rejects.toMatchObject({
        name: "FormexApiError",
        code: "fmx_invalid_body",
      });
      expect(await getLawEntry(indexedDb, CACHE_KEY)).toBeUndefined();
    });

    it("caches and returns a valid Formex body", async () => {
      const fetchMock = vi.fn(async () => xmlResponse(VALID_FMX));
      vi.stubGlobal("fetch", fetchMock);

      const api = await importFormexApi();

      await expect(api.fetchFormex("32016R0679", "EN")).resolves.toBe(VALID_FMX);
      expect(await getLawEntry(indexedDb, CACHE_KEY)).toBe(VALID_FMX);

      // Second call is a raw-string cache hit — no extra network round trip.
      await expect(api.fetchFormex("32016R0679", "EN")).resolves.toBe(VALID_FMX);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("treats an already-poisoned raw cache entry as a miss and refetches over it", async () => {
      const fetchMock = vi.fn(async () => xmlResponse(VALID_FMX));
      vi.stubGlobal("fetch", fetchMock);

      const api = await importFormexApi();
      // Ensure the object stores exist, then plant a legacy poisoned entry
      // (cached before body validation existed).
      await api.getLawMeta("32016R0679");
      await putLawEntry(indexedDb, CACHE_KEY, HTML_ERROR_PAGE);

      // Every read path must agree with getCachedLawPayload: miss, not hit.
      expect(await api.getCachedFormex("32016R0679", "EN")).toBeNull();
      expect(await api.hasCachedFormex("32016R0679", "EN")).toBe(false);
      expect(await api.getCachedLawPayload("32016R0679", "EN")).toBeNull();

      // fetchFormex must not serve the poisoned string; it refetches and
      // overwrites the entry with the valid body.
      await expect(api.fetchFormex("32016R0679", "EN")).resolves.toBe(VALID_FMX);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await getLawEntry(indexedDb, CACHE_KEY)).toBe(VALID_FMX);
    });
  });

  describe("fetchParsedLaw parser-version stamping", () => {
    it("stamps the envelope with the backend's reported parserVersion so old-shape payloads read as stale", async () => {
      const stalePayload = { title: "GDPR", articles: [{}], parserVersion: PARSER_VERSION - 1 };
      const fetchMock = vi.fn(async () => jsonResponse(stalePayload));
      vi.stubGlobal("fetch", fetchMock);

      const api = await importFormexApi();

      await expect(api.fetchParsedLaw("32016R0679", "EN")).resolves.toEqual(stalePayload);

      // The stored envelope carries the backend's version, not the bundled
      // frontend constant.
      const stored = await getLawEntry(indexedDb, CACHE_KEY);
      expect(stored).toMatchObject({ format: "combined-v1", parserVersion: PARSER_VERSION - 1 });

      // Version-mismatch checks now detect the skew: the payload cache
      // rejects it, and fetchParsedLaw revalidates against the network
      // instead of serving the old-shape payload as current.
      expect(await api.getCachedLawPayload("32016R0679", "EN")).toBeNull();
      await api.fetchParsedLaw("32016R0679", "EN");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("serves the cached payload without refetching when the backend parserVersion is current", async () => {
      const currentPayload = { title: "GDPR", articles: [{}], parserVersion: PARSER_VERSION };
      const fetchMock = vi.fn(async () => jsonResponse(currentPayload));
      vi.stubGlobal("fetch", fetchMock);

      const api = await importFormexApi();

      await expect(api.fetchParsedLaw("32016R0679", "EN")).resolves.toEqual(currentPayload);
      await expect(api.fetchParsedLaw("32016R0679", "EN")).resolves.toEqual(currentPayload);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const envelope = await api.getCachedLawPayload("32016R0679", "EN");
      expect(envelope).toMatchObject({ format: "combined-v1", parserVersion: PARSER_VERSION });
      expect(envelope.payload).toEqual(currentPayload);
    });

    it("discards a pre-versioning envelope without raw XML instead of stamping it as current", async () => {
      vi.stubGlobal("fetch", vi.fn());

      const api = await importFormexApi();
      await api.getLawMeta("32016R0679");
      await putLawEntry(indexedDb, CACHE_KEY, {
        format: "combined-v1",
        payload: { title: "Unknown vintage", articles: [] },
      });

      expect(await api.getCachedLawPayload("32016R0679", "EN")).toBeNull();

      // The entry must not have been rewritten as a current-version envelope.
      const stored = await getLawEntry(indexedDb, CACHE_KEY);
      expect(stored.parserVersion).toBeUndefined();
    });
  });
});
