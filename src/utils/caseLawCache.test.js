import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFetchCaseLaw } = vi.hoisted(() => ({
  mockFetchCaseLaw: vi.fn(),
}));

vi.mock("./formexApi.js", () => ({
  fetchCaseLaw: mockFetchCaseLaw,
}));

let loadCaseLaw;
let peekCaseLaw;

beforeEach(async () => {
  vi.resetModules();
  mockFetchCaseLaw.mockReset();
  ({ loadCaseLaw, peekCaseLaw } = await import("./caseLawCache.js"));
});

describe("caseLawCache", () => {
  it("caches a successful fetch for the rest of the session", async () => {
    mockFetchCaseLaw.mockResolvedValue({ cases: [{ caseId: "C-1" }] });

    const first = loadCaseLaw("32016R0679");
    const second = loadCaseLaw("32016R0679");

    await expect(first).resolves.toEqual({ cases: [{ caseId: "C-1" }] });
    await expect(second).resolves.toEqual({ cases: [{ caseId: "C-1" }] });

    expect(mockFetchCaseLaw).toHaveBeenCalledTimes(1);
    expect(mockFetchCaseLaw).toHaveBeenCalledWith("32016R0679");
    expect(second).toBe(first);
    expect(peekCaseLaw("32016R0679")).toBe(first);
  });

  it("does not cache a failed fetch, so a later retry refetches", async () => {
    mockFetchCaseLaw
      .mockRejectedValueOnce(new Error("case law cellar down"))
      .mockResolvedValueOnce({ cases: [{ caseId: "C-2" }] });

    await expect(loadCaseLaw("32002L0058")).rejects.toThrow("case law cellar down");
    expect(peekCaseLaw("32002L0058")).toBeNull();

    await expect(loadCaseLaw("32002L0058")).resolves.toEqual({ cases: [{ caseId: "C-2" }] });
    expect(mockFetchCaseLaw).toHaveBeenCalledTimes(2);
  });

  it("normalises a successful response to { cases } even when the payload has no cases field", async () => {
    mockFetchCaseLaw.mockResolvedValue({});

    await expect(loadCaseLaw("32022R1925")).resolves.toEqual({ cases: [] });
    expect(mockFetchCaseLaw).toHaveBeenCalledTimes(1);
  });

  it("returns an empty result without fetching for a falsy celex", async () => {
    await expect(loadCaseLaw("")).resolves.toEqual({ cases: [] });
    await expect(loadCaseLaw(undefined)).resolves.toEqual({ cases: [] });
    expect(mockFetchCaseLaw).not.toHaveBeenCalled();
  });
});