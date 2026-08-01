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
