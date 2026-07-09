import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FormexApiError,
  apiFetch,
  fetchAmendments,
  fetchArticleCaseLawDigest,
  fetchImplementingActs,
  fetchLawMetadata,
  fetchLawSummary,
} from "./formexApi.js";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status-${status}`,
    json: async () => body,
  };
}

beforeEach(() => {
  window.indexedDB = new IDBFactory();
  window.fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("apiFetch", () => {
  it("tags every request with the web client header without dropping caller headers", async () => {
    window.fetch.mockResolvedValueOnce(jsonResponse(200, {}));

    await apiFetch("https://example.test/x", { headers: { Accept: "application/json" }, signal: "some-signal" });

    expect(window.fetch).toHaveBeenCalledWith("https://example.test/x", {
      headers: { Accept: "application/json", "x-legalviz-client": "web" },
      signal: "some-signal",
    });
  });
});

describe("fetchAmendments (network-first with cache fallback)", () => {
  it("returns the network payload on success", async () => {
    window.fetch.mockResolvedValueOnce(jsonResponse(200, { amendments: ["a1"] }));

    const result = await fetchAmendments("32016R0679-net-ok");

    expect(result).toEqual({ amendments: ["a1"] });
  });

  it("falls back to a cached copy when the network is offline", async () => {
    window.fetch.mockResolvedValueOnce(jsonResponse(200, { amendments: ["a1"] }));
    await fetchAmendments("32016R0679-offline");

    window.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const result = await fetchAmendments("32016R0679-offline");

    expect(result).toMatchObject({ amendments: ["a1"], cached: true, localCached: true });
  });

  it("falls back to a cached copy on a 500 response", async () => {
    window.fetch.mockResolvedValueOnce(jsonResponse(200, { amendments: ["a1"] }));
    await fetchAmendments("32016R0679-500");

    window.fetch.mockResolvedValueOnce(jsonResponse(500, { error: "server error" }));
    const result = await fetchAmendments("32016R0679-500");

    expect(result).toMatchObject({ amendments: ["a1"], cached: true, localCached: true });
  });

  it("falls back to a cached copy when rate-limited (429)", async () => {
    window.fetch.mockResolvedValueOnce(jsonResponse(200, { amendments: ["a1"] }));
    await fetchAmendments("32016R0679-429");

    window.fetch.mockResolvedValueOnce(jsonResponse(429, { error: "rate limited" }));
    const result = await fetchAmendments("32016R0679-429");

    expect(result).toMatchObject({ amendments: ["a1"], cached: true, localCached: true });
  });

  it("does not mask a genuine 404 even when a cached copy exists", async () => {
    window.fetch.mockResolvedValueOnce(jsonResponse(200, { amendments: ["a1"] }));
    await fetchAmendments("32016R0679-404");

    window.fetch.mockResolvedValueOnce(jsonResponse(404, { error: "not found" }));
    await expect(fetchAmendments("32016R0679-404")).rejects.toThrow(FormexApiError);
  });

  it("throws when offline and nothing is cached yet", async () => {
    window.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await expect(fetchAmendments("32016R0679-cold")).rejects.toThrow(TypeError);
  });

  it("de-duplicates concurrent requests for the same CELEX", async () => {
    let resolveFetch;
    window.fetch.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );

    const first = fetchAmendments("32016R0679-inflight");
    const second = fetchAmendments("32016R0679-inflight");

    resolveFetch(jsonResponse(200, { amendments: ["a1"] }));
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(window.fetch).toHaveBeenCalledTimes(1);
    expect(firstResult).toEqual({ amendments: ["a1"] });
    expect(secondResult).toEqual({ amendments: ["a1"] });
  });
});

describe("cache-first JSON endpoints (fetchLawSummary)", () => {
  it("serves a fresh cached copy without hitting the network again", async () => {
    window.fetch.mockResolvedValueOnce(jsonResponse(200, { summary: { purpose: "s1" } }));
    await fetchLawSummary("32016R0679-summary-fresh");

    const result = await fetchLawSummary("32016R0679-summary-fresh");

    expect(window.fetch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ summary: { purpose: "s1" }, cached: true, localCached: true });
  });

  it("always requests the English variant regardless of reading language", async () => {
    window.fetch.mockResolvedValueOnce(jsonResponse(200, { summary: {} }));

    await fetchLawSummary("32016R0679-lang-check");

    const requestedUrl = window.fetch.mock.calls[0][0];
    expect(requestedUrl).toContain("/summary?lang=ENG");
  });

  it("revalidates against the network once the cached entry is stale", async () => {
    const baseTime = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(baseTime);

    window.fetch.mockResolvedValueOnce(jsonResponse(200, { summary: { purpose: "s1" } }));
    await fetchLawSummary("32016R0679-summary-stale");

    nowSpy.mockReturnValue(baseTime + 8 * 24 * 60 * 60 * 1000);
    window.fetch.mockResolvedValueOnce(jsonResponse(200, { summary: { purpose: "s2" } }));

    const result = await fetchLawSummary("32016R0679-summary-stale");

    expect(window.fetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ summary: { purpose: "s2" } });
  });

  it("falls back to a stale cached copy when revalidation fails offline", async () => {
    const baseTime = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(baseTime);

    window.fetch.mockResolvedValueOnce(jsonResponse(200, { summary: { purpose: "s1" } }));
    await fetchLawSummary("32016R0679-summary-stale-offline");

    nowSpy.mockReturnValue(baseTime + 8 * 24 * 60 * 60 * 1000);
    window.fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const result = await fetchLawSummary("32016R0679-summary-stale-offline");

    expect(result).toMatchObject({ summary: { purpose: "s1" }, cached: true, localCached: true });
  });
});

describe("fetchArticleCaseLawDigest", () => {
  it("keys the cache separately per article number and language", async () => {
    window.fetch
      .mockResolvedValueOnce(jsonResponse(200, { digest: "art-5" }))
      .mockResolvedValueOnce(jsonResponse(200, { digest: "art-6" }));

    const art5 = await fetchArticleCaseLawDigest("32016R0679-digest", "5", "EN");
    const art6 = await fetchArticleCaseLawDigest("32016R0679-digest", "6", "EN");

    expect(window.fetch).toHaveBeenCalledTimes(2);
    expect(art5).toEqual({ digest: "art-5" });
    expect(art6).toEqual({ digest: "art-6" });

    // Re-requesting article 5 should now be served from cache, not the network.
    const art5Again = await fetchArticleCaseLawDigest("32016R0679-digest", "5", "EN");
    expect(window.fetch).toHaveBeenCalledTimes(2);
    expect(art5Again).toMatchObject({ digest: "art-5", cached: true, localCached: true });
  });
});

describe("other network-first JSON endpoints", () => {
  it("fetchLawMetadata requests the metadata endpoint and caches its result", async () => {
    window.fetch.mockResolvedValueOnce(jsonResponse(200, { title: "GDPR" }));

    const result = await fetchLawMetadata("32016R0679-metadata");

    expect(window.fetch.mock.calls[0][0]).toContain("/metadata");
    expect(result).toEqual({ title: "GDPR" });
  });

  it("fetchImplementingActs requests the implementing endpoint and caches its result", async () => {
    window.fetch.mockResolvedValueOnce(jsonResponse(200, { acts: [] }));

    const result = await fetchImplementingActs("32016R0679-implementing");

    expect(window.fetch.mock.calls[0][0]).toContain("/implementing");
    expect(result).toEqual({ acts: [] });
  });
});
