import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock formexApi module since it uses IndexedDB
vi.mock("./formexApi.js", () => ({
  getAllLawMeta: vi.fn().mockResolvedValue([]),
  listCachedCelexes: vi.fn().mockResolvedValue([]),
  upsertLawMeta: vi.fn().mockResolvedValue({}),
}));

const {
  doesCelexMatchOfficialReference,
  findStoredLawMetaByOfficialReference,
  saveLawMeta,
  markLawOpened,
  getLibraryLaws,
} = await import("./library.js");
const { getAllLawMeta, listCachedCelexes, upsertLawMeta } = await import("./formexApi.js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("saveLawMeta", () => {
  it("returns null for missing celex", async () => {
    expect(await saveLawMeta({})).toBeNull();
    expect(await saveLawMeta(null)).toBeNull();
  });

  it("calls upsertLawMeta with normalized data", async () => {
    upsertLawMeta.mockResolvedValue({ celex: "32016R0679" });
    await saveLawMeta({
      celex: "32016R0679",
      label: "GDPR",
    });
    expect(upsertLawMeta).toHaveBeenCalledWith(
      "32016R0679",
      expect.objectContaining({
        label: "GDPR",
        eurlex: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679",
        officialReference: {
          actType: "regulation",
          year: "2016",
          number: "679",
        },
      })
    );
  });

  it("persists EuroVoc topics when provided", async () => {
    upsertLawMeta.mockResolvedValue({ celex: "32016R0679" });
    await saveLawMeta({
      celex: "32016R0679",
      label: "GDPR",
      topics: ["data protection", "personal data", ""],
    });
    expect(upsertLawMeta).toHaveBeenCalledWith(
      "32016R0679",
      expect.objectContaining({
        topics: ["data protection", "personal data"],
      })
    );
  });

  it("does not clobber stored topics when saving without them", async () => {
    upsertLawMeta.mockResolvedValue({ celex: "32016R0679" });
    await saveLawMeta({
      celex: "32016R0679",
      label: "GDPR",
    });
    const updates = upsertLawMeta.mock.calls[0][1];
    expect(updates).not.toHaveProperty("topics");
  });

  it("warns and resolves null when the underlying meta write rejects", async () => {
    upsertLawMeta.mockRejectedValueOnce(new Error("quota exceeded"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const saved = await saveLawMeta({ celex: "32016R0679", label: "GDPR" });
      expect(saved).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("markLawOpened", () => {
  it("returns null for empty celex", async () => {
    expect(await markLawOpened("")).toBeNull();
    expect(await markLawOpened(null)).toBeNull();
  });

  it("sets lastOpened timestamp", async () => {
    upsertLawMeta.mockResolvedValue({});
    await markLawOpened("32016R0679");
    expect(upsertLawMeta).toHaveBeenCalledWith(
      "32016R0679",
      expect.objectContaining({
        lastOpened: expect.any(Number),
      })
    );
  });

  it("persists a lastPosition when a position is provided", async () => {
    upsertLawMeta.mockResolvedValue({});
    await markLawOpened("32016R0679", { kind: "article", id: "6", total: 99 });
    expect(upsertLawMeta).toHaveBeenCalledWith(
      "32016R0679",
      expect.objectContaining({
        lastPosition: { kind: "article", id: "6", total: 99 },
      })
    );
  });

  it("ignores an invalid position kind", async () => {
    upsertLawMeta.mockResolvedValue({});
    await markLawOpened("32016R0679", { kind: "chapter", id: "1" });
    const updates = upsertLawMeta.mock.calls[0][1];
    expect(updates).not.toHaveProperty("lastPosition");
  });

  it("does not clobber an existing lastPosition when called without one", async () => {
    upsertLawMeta.mockResolvedValue({});
    await markLawOpened("32016R0679");
    const updates = upsertLawMeta.mock.calls[0][1];
    // Omitting lastPosition from the update lets upsertLawMeta preserve the
    // previously stored value (it merges existing ⊕ updates).
    expect(updates).not.toHaveProperty("lastPosition");
  });
});

describe("getLibraryLaws", () => {
  it("returns no recent laws when nothing has been opened", async () => {
    getAllLawMeta.mockResolvedValue([]);
    listCachedCelexes.mockResolvedValue([]);

    const laws = await getLibraryLaws();
    expect(laws).toEqual([]);
  });

  it("includes bundled laws that have been opened (have meta)", async () => {
    getAllLawMeta.mockResolvedValue([
      { celex: "32016R0679", label: "General Data Protection Regulation", lastOpened: Date.now() },
    ]);
    listCachedCelexes.mockResolvedValue([]);

    const laws = await getLibraryLaws();
    expect(laws.some((law) => law.slug === "gdpr")).toBe(true);
    expect(laws.some((law) => law.slug === "dma")).toBe(false);
  });

  it("includes opened imported laws from cache", async () => {
    getAllLawMeta.mockResolvedValue([
      {
        celex: "32021R0123",
        label: "Test Regulation",
        officialReference: { actType: "regulation", year: "2021", number: "123" },
        lastOpened: 1000,
      },
    ]);
    listCachedCelexes.mockResolvedValue(["32021R0123"]);

    const laws = await getLibraryLaws();
    const imported = laws.find((l) => l.celex === "32021R0123");
    expect(imported).toBeTruthy();
    expect(imported.kind).toBe("imported");
  });

  it("returns one entry per cached celex", async () => {
    getAllLawMeta.mockResolvedValue([
      { celex: "32016R0679", label: "General Data Protection Regulation", lastOpened: 1000 },
    ]);
    listCachedCelexes.mockResolvedValue(["32016R0679"]);

    const laws = await getLibraryLaws();
    const gdprEntries = laws.filter((l) => l.celex === "32016R0679");
    expect(gdprEntries).toHaveLength(1);
  });

  it("excludes laws that have metadata but were never opened", async () => {
    getAllLawMeta.mockResolvedValue([
      {
        celex: "32002L0058",
        label: "Directive 2002/58/EC",
        officialReference: { actType: "directive", year: "2002", number: "58" },
      },
      {
        celex: "32016R0679",
        label: "GDPR",
        officialReference: { actType: "regulation", year: "2016", number: "679" },
        lastOpened: 2000,
      },
    ]);
    listCachedCelexes.mockResolvedValue(["32002L0058", "32016R0679"]);

    const laws = await getLibraryLaws();
    expect(laws.map((law) => law.celex)).toEqual(["32016R0679"]);
  });

  it("exposes stored EuroVoc topics on library laws", async () => {
    getAllLawMeta.mockResolvedValue([
      { celex: "32016R0679", lastOpened: 1000, topics: ["data protection", "personal data"] },
    ]);
    listCachedCelexes.mockResolvedValue([]);

    const laws = await getLibraryLaws();
    const gdpr = laws.find((l) => l.celex === "32016R0679");
    expect(gdpr.topics).toEqual(["data protection", "personal data"]);
  });

  it("defaults topics to null when none are stored", async () => {
    getAllLawMeta.mockResolvedValue([
      { celex: "32016R0679", lastOpened: 1000 },
    ]);
    listCachedCelexes.mockResolvedValue([]);

    const laws = await getLibraryLaws();
    const gdpr = laws.find((l) => l.celex === "32016R0679");
    expect(gdpr.topics).toBeNull();
  });

  it("surfaces a stored lastPosition on library laws", async () => {
    getAllLawMeta.mockResolvedValue([
      {
        celex: "32016R0679",
        lastOpened: 1000,
        lastPosition: { kind: "article", id: "6", total: 99 },
      },
    ]);
    listCachedCelexes.mockResolvedValue([]);

    const laws = await getLibraryLaws();
    const gdpr = laws.find((l) => l.celex === "32016R0679");
    expect(gdpr.lastPosition).toEqual({ kind: "article", id: "6", total: 99 });
  });

  it("defaults lastPosition to null when none is stored", async () => {
    getAllLawMeta.mockResolvedValue([
      { celex: "32016R0679", lastOpened: 1000 },
    ]);
    listCachedCelexes.mockResolvedValue([]);

    const laws = await getLibraryLaws();
    const gdpr = laws.find((l) => l.celex === "32016R0679");
    expect(gdpr.lastPosition).toBeNull();
  });

  it("sorts by lastOpened timestamp descending", async () => {
    getAllLawMeta.mockResolvedValue([
      { celex: "32016R0679", lastOpened: 1000 },
      { celex: "32024R1689", lastOpened: 2000 },
    ]);
    listCachedCelexes.mockResolvedValue([]);

    const laws = await getLibraryLaws();
    const aiIdx = laws.findIndex((l) => l.celex === "32024R1689");
    const gdprIdx = laws.findIndex((l) => l.celex === "32016R0679");
    expect(aiIdx).toBeLessThan(gdprIdx);
  });
});

describe("official reference validation", () => {
  it("matches primary-act CELEX values against official references", () => {
    expect(doesCelexMatchOfficialReference("32015L2366", {
      actType: "directive",
      year: "2015",
      number: "2366",
    })).toBe(true);

    expect(doesCelexMatchOfficialReference("32013R0575", {
      actType: "directive",
      year: "2015",
      number: "2366",
    })).toBe(false);
  });

  it("ignores stale cached metadata entries whose CELEX does not match the requested reference", async () => {
    getAllLawMeta.mockResolvedValue([
      {
        celex: "32013R0575",
        officialReference: { actType: "directive", year: "2015", number: "2366" },
      },
      {
        celex: "32015L2366",
        officialReference: { actType: "directive", year: "2015", number: "2366" },
      },
    ]);

    const match = await findStoredLawMetaByOfficialReference({
      actType: "directive",
      year: "2015",
      number: "2366",
    });

    expect(match?.celex).toBe("32015L2366");
  });
});
