import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./formexApi.js", () => ({
  fetchTopicsForCelexes: vi.fn().mockResolvedValue({}),
  getAllLawMeta: vi.fn().mockResolvedValue([]),
  upsertLawMeta: vi.fn().mockResolvedValue({}),
}));

const { runOneTimeTopicsBackfill } = await import("./topicsBackfill.js");
const { fetchTopicsForCelexes, getAllLawMeta, upsertLawMeta } = await import("./formexApi.js");

const VERSION_KEY = "legalviz-topics-backfill-version";

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("runOneTimeTopicsBackfill", () => {
  it("does nothing when already run", async () => {
    window.localStorage.setItem(VERSION_KEY, "v1");
    const result = await runOneTimeTopicsBackfill();
    expect(result).toBe(false);
    expect(getAllLawMeta).not.toHaveBeenCalled();
  });

  it("marks done and skips fetch when the library is empty", async () => {
    getAllLawMeta.mockResolvedValue([]);
    const result = await runOneTimeTopicsBackfill();
    expect(result).toBe(false);
    expect(fetchTopicsForCelexes).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(VERSION_KEY)).toBe("v1");
  });

  it("backfills topics onto laws that lack them", async () => {
    getAllLawMeta.mockResolvedValue([
      { celex: "32016R0679" },
      { celex: "32024R1689", topics: ["already", "here"] },
    ]);
    fetchTopicsForCelexes.mockResolvedValue({ "32016R0679": ["data protection"] });

    const result = await runOneTimeTopicsBackfill();

    expect(result).toBe(true);
    // Only the law without topics is requested.
    expect(fetchTopicsForCelexes).toHaveBeenCalledWith(["32016R0679"]);
    expect(upsertLawMeta).toHaveBeenCalledWith("32016R0679", { topics: ["data protection"] });
    expect(window.localStorage.getItem(VERSION_KEY)).toBe("v1");
  });

  it("does not persist the version when the fetch fails, so it retries later", async () => {
    getAllLawMeta.mockResolvedValue([{ celex: "32016R0679" }]);
    fetchTopicsForCelexes.mockRejectedValue(new Error("network"));

    const result = await runOneTimeTopicsBackfill();

    expect(result).toBe(false);
    expect(upsertLawMeta).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(VERSION_KEY)).toBeNull();
  });

  it("does not retry laws that legitimately have no topics", async () => {
    getAllLawMeta.mockResolvedValue([{ celex: "32016R0679" }]);
    fetchTopicsForCelexes.mockResolvedValue({});

    const result = await runOneTimeTopicsBackfill();

    // No topics returned, but the endpoint responded — mark done anyway.
    expect(result).toBe(false);
    expect(upsertLawMeta).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(VERSION_KEY)).toBe("v1");
  });
});
