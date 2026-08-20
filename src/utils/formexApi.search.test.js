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

// Railway edge gateway errors have no JSON body (they're HTML/plain-text
// error pages), so json() rejects — the transient/cold-start case.
function edgeErrorResponse(status) {
  return {
    ok: false,
    status,
    json: async () => { throw new SyntaxError("Unexpected token < in JSON"); },
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
      .mockResolvedValueOnce(edgeErrorResponse(502))
      .mockResolvedValueOnce(jsonResponse({ results: [{ celex: "32016R0679" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const api = await importFormexApi();
    const resultPromise = api.searchLaws("gdpr");

    await vi.advanceTimersByTimeAsync(1000);

    await expect(resultPromise).resolves.toEqual({ results: [{ celex: "32016R0679" }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a terminal search_cache_unavailable error", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: "search_cache_unavailable" }, 503));
    vi.stubGlobal("fetch", fetchMock);

    const api = await importFormexApi();
    const resultPromise = api.searchLaws("gdpr");

    await expect(resultPromise).rejects.toMatchObject({ code: "search_cache_unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries through the full backoff window (1s/2s/4s/8s) before succeeding", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(edgeErrorResponse(502))
      .mockResolvedValueOnce(edgeErrorResponse(502))
      .mockResolvedValueOnce(edgeErrorResponse(502))
      .mockResolvedValueOnce(edgeErrorResponse(502))
      .mockResolvedValueOnce(jsonResponse({ results: [{ celex: "32016R0679" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const api = await importFormexApi();
    const resultPromise = api.searchLaws("gdpr");

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(8000);

    await expect(resultPromise).resolves.toEqual({ results: [{ celex: "32016R0679" }] });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
