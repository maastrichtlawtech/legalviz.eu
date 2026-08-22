import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";

async function importFormexApi() {
  vi.resetModules();
  return import("./formexApi.js");
}

function deleteDatabase(indexedDb, name) {
  return new Promise((resolve, reject) => {
    const request = indexedDb.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Database deletion was blocked"));
  });
}

describe("Formex IndexedDB connection lifecycle", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shares one connection and releases it when another client deletes the database", async () => {
    const indexedDb = new IDBFactory();
    const openSpy = vi.spyOn(indexedDb, "open");
    vi.stubGlobal("indexedDB", indexedDb);

    const { getLawMeta, upsertLawMeta } = await importFormexApi();

    await upsertLawMeta("32016R0679", { label: "GDPR" });
    expect(await getLawMeta("32016R0679")).toMatchObject({
      celex: "32016R0679",
      label: "GDPR",
    });
    expect(openSpy).toHaveBeenCalledTimes(1);

    // This models clear-data running in another tab. The cached connection's
    // versionchange handler must close it or this request fires `blocked`.
    await deleteDatabase(indexedDb, "formex-cache");

    expect(await getLawMeta("32016R0679")).toBeNull();
    expect(openSpy).toHaveBeenCalledTimes(2);
  });

  it("times out a wedged open and closes its connection if it succeeds later", async () => {
    vi.useFakeTimers();

    const lateDb = { close: vi.fn() };
    const request = { result: lateDb };
    vi.stubGlobal("indexedDB", {
      open: vi.fn(() => request),
    });

    const { getLawMeta } = await importFormexApi();
    const result = getLawMeta("32016R0679");

    await vi.advanceTimersByTimeAsync(3000);
    await expect(result).resolves.toBeNull();

    request.onsuccess();
    expect(lateDb.close).toHaveBeenCalledOnce();
  });
});

describe("law meta persistence failures", () => {
  it("rejects when the meta store transaction errors instead of resolving silently", async () => {
    const putError = new Error("quota exceeded");
    const store = {
      get: vi.fn(() => {
        const req = { result: null };
        queueMicrotask(() => req.onsuccess?.());
        return req;
      }),
      put: vi.fn(() => {
        tx.error = putError;
        queueMicrotask(() => tx.onerror?.());
        return {};
      }),
    };
    const tx = {
      objectStore: () => store,
      oncomplete: null,
      onerror: null,
      onabort: null,
    };
    const db = { transaction: vi.fn(() => tx) };
    const request = { result: db };
    vi.stubGlobal("indexedDB", { open: vi.fn(() => request) });

    const { upsertLawMeta } = await importFormexApi();
    const result = upsertLawMeta("32016R0679", { label: "GDPR" });

    request.onsuccess();
    await expect(result).rejects.toMatchObject({ message: "quota exceeded" });
  });

  it("rejects when the meta store write cannot be set up", async () => {
    const store = {
      get: vi.fn(() => {
        const req = { result: null };
        queueMicrotask(() => req.onsuccess?.());
        return req;
      }),
      put: vi.fn(),
    };
    const tx = { objectStore: () => store };
    const db = {
      transaction: vi.fn((name, mode) => {
        if (mode === "readwrite") throw new Error("InvalidStateError: database closed");
        return tx;
      }),
    };
    const request = { result: db };
    vi.stubGlobal("indexedDB", { open: vi.fn(() => request) });

    const { upsertLawMeta } = await importFormexApi();
    const result = upsertLawMeta("32016R0679", { label: "GDPR" });

    request.onsuccess();
    await expect(result).rejects.toMatchObject({ message: "InvalidStateError: database closed" });
  });
});

describe("law summary cache versioning", () => {
  it("uses the backend cache, schema, and prompt versions in the browser key", async () => {
    const { makeLawSummaryCacheKey } = await importFormexApi();

    expect(makeLawSummaryCacheKey("32016R0679"))
      .toBe("32016R0679_ENG_summary_v2_schema3_prompt3");
  });

  it("does not cache a response from a mismatched backend version", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        celex: "32016R0679",
        lang: "ENG",
        cacheVersion: 1,
        schemaVersion: 3,
        promptVersion: 3,
        summary: { purpose: { text: "stale", citations: [] } },
      }),
    }));

    const { fetchLawSummary } = await importFormexApi();
    await expect(fetchLawSummary("32016R0679")).rejects.toMatchObject({
      code: "cache_version_mismatch",
      status: 409,
    });
  });
});

describe("AI digest cache versioning", () => {
  it("folds the article-digest schema/prompt versions into the browser key", async () => {
    const { makeArticleCaseLawDigestCacheKey } = await importFormexApi();

    expect(makeArticleCaseLawDigestCacheKey("32016R0679", "6", "EN"))
      .toBe("32016R0679_ENG_digest_6_schema2_prompt1");
  });

  it("folds the whole-law digest schema/prompt versions into the browser key", async () => {
    const { makeCaseLawDigestCacheKey } = await importFormexApi();

    expect(makeCaseLawDigestCacheKey("32016R0679", "EN"))
      .toBe("32016R0679_ENG_case_law_digest_schema1_prompt1");
  });

  it("does not cache a digest stamped by a mismatched case-law enrichment version", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        celex: "32016R0679",
        articleNumber: "6",
        lang: "ENG",
        caseLawCacheVersion: "case-law-cache-v4",
        digest: { summary: "stale", themes: [], noCaseLaw: false },
      }),
    }));

    const { fetchArticleCaseLawDigest } = await importFormexApi();
    await expect(fetchArticleCaseLawDigest("32016R0679", "6", "EN")).rejects.toMatchObject({
      code: "cache_version_mismatch",
      status: 409,
    });
  });
});
