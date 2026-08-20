import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function importFormexApi() {
  vi.resetModules();
  return import("./formexApi.js");
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

describe("formexApi law search", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("retries a transient API failure while Railway wakes the server", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: "search_cache_unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse({ results: [{ celex: "32016R0679" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const api = await importFormexApi();
    const resultPromise = api.searchLaws("gdpr");

    await vi.advanceTimersByTimeAsync(1000);

    await expect(resultPromise).resolves.toEqual({ results: [{ celex: "32016R0679" }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
