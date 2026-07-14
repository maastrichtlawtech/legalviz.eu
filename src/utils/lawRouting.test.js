import { describe, it, expect } from "vitest";
import {
  getLawSlug,
  enrichLaw,
  getBundledLaws,
  findBundledLawByKey,
  findBundledLawByCelex,
  findBundledLawBySlug,
  getCanonicalLawRoute,
  buildImportedLawCandidate,
  getActTypeChoices,
  parseOfficialReferenceSlug,
  parseCelexQuery,
} from "./lawRouting.js";
import { SUPPORTED_UI_LOCALES } from "../i18n/localeMeta.js";

describe("getLawSlug", () => {
  it("returns shortname when available", () => {
    expect(getLawSlug({ shortname: "gdpr" })).toBe("gdpr");
  });

  it("falls back to official reference slug", () => {
    const slug = getLawSlug({
      officialReference: { actType: "regulation", year: "2016", number: "679" },
    });
    expect(slug).toBe("regulation-2016-679");
  });

  it("returns null for empty input", () => {
    expect(getLawSlug({})).toBeNull();
    expect(getLawSlug(null)).toBeNull();
  });

  it("slugifies shortname (lowercase, no special chars)", () => {
    expect(getLawSlug({ shortname: "AI Act" })).toBe("ai-act");
  });

  it("does not derive a slug from celex alone", () => {
    const slug = getLawSlug({ celex: "32016R0679" });
    expect(slug).toBeNull();
  });
});

describe("enrichLaw", () => {
  it("normalizes official reference", () => {
    const law = enrichLaw({
      officialReference: { actType: "regulation", year: "2016", number: "679" },
    });
    expect(law.officialReference).toEqual({
      actType: "regulation",
      year: "2016",
      number: "679",
    });
  });

  it("sets shownInUi to true by default", () => {
    const law = enrichLaw({});
    expect(law.shownInUi).toBe(true);
  });

  it("respects explicit shownInUi: false", () => {
    const law = enrichLaw({ shownInUi: false });
    expect(law.shownInUi).toBe(false);
  });

  it("adds slug", () => {
    const law = enrichLaw({
      shortname: "gdpr",
      officialReference: { actType: "regulation", year: "2016", number: "679" },
    });
    expect(law.slug).toBe("gdpr");
  });

  it("rejects invalid official references", () => {
    const law = enrichLaw({
      officialReference: { actType: "unknown", year: "2016", number: "679" },
    });
    expect(law.officialReference).toBeNull();
  });
});

describe("getBundledLaws", () => {
  it("returns flagship bundled laws", () => {
    const laws = getBundledLaws();
    expect(laws.length).toBeGreaterThanOrEqual(4);
    expect(laws.some((law) => law.slug === "gdpr")).toBe(true);
    expect(laws.some((law) => law.slug === "dma")).toBe(true);
  });

  it("has no slug that collides with a UI locale code", () => {
    // A bundled slug equal to a 2-letter locale code (e.g. "da" for the Data
    // Act vs. Danish) makes the single-segment route "/<slug>" resolve to the
    // localized homepage instead of the law. Keep law slugs locale-disjoint.
    const laws = getBundledLaws();
    laws.forEach((law) => {
      expect(SUPPORTED_UI_LOCALES.includes(law.slug)).toBe(false);
    });
  });
});

describe("findBundledLawByKey / ByCelex / BySlug", () => {
  it("finds configured flagship laws", () => {
    expect(findBundledLawByKey("gdpr")?.celex).toBe("32016R0679");
    expect(findBundledLawByCelex("32016R0679")?.slug).toBe("gdpr");
    expect(findBundledLawBySlug("gdpr")?.key).toBe("gdpr");
  });

  it("returns null for missing lookups", () => {
    expect(findBundledLawByKey("nonexistent")).toBeNull();
    expect(findBundledLawByCelex("00000X0000")).toBeNull();
    expect(findBundledLawBySlug("nope")).toBeNull();
  });

  it("returns null for null/undefined", () => {
    expect(findBundledLawByKey(null)).toBeNull();
    expect(findBundledLawByCelex(undefined)).toBeNull();
    expect(findBundledLawBySlug("")).toBeNull();
  });
});

describe("getCanonicalLawRoute", () => {
  it("builds simple route from slug", () => {
    const route = getCanonicalLawRoute({ shortname: "gdpr" });
    expect(route).toBe("/gdpr");
  });

  it("includes kind and id when provided", () => {
    const route = getCanonicalLawRoute({ shortname: "gdpr" }, "article", "5");
    expect(route).toBe("/gdpr/article/5");
  });

  it("encodes special characters in id", () => {
    const route = getCanonicalLawRoute({ shortname: "gdpr" }, "article", "5a");
    expect(route).toBe("/gdpr/article/5a");
  });

  it("returns / for law without slug or celex", () => {
    expect(getCanonicalLawRoute({})).toBe("/");
  });

  it("falls back to the import route for slugless laws with a celex (e.g. COM proposals)", () => {
    const route = getCanonicalLawRoute({ celex: "52026PC0502" });
    expect(route).toBe("/import?celex=52026PC0502");
  });

  it("keeps kind/id on the import fallback route", () => {
    const route = getCanonicalLawRoute({ celex: "52026PC0502" }, "article", "5");
    expect(route).toBe("/import/article/5?celex=52026PC0502");
  });

  it("includes locale prefix for non-English", () => {
    const route = getCanonicalLawRoute({ shortname: "gdpr" }, null, null, "de");
    expect(route).toContain("/de/");
  });

  it("treats the overview kind as the bare slug route", () => {
    const route = getCanonicalLawRoute({ shortname: "gdpr" }, "overview", null);
    expect(route).toBe("/gdpr");
  });

  it("treats the overview kind as the bare import route for slugless laws", () => {
    const route = getCanonicalLawRoute({ celex: "52026PC0502" }, "overview", null);
    expect(route).toBe("/import?celex=52026PC0502");
  });
});

describe("buildImportedLawCandidate", () => {
  it("builds candidate when celex matches a previously bundled law", () => {
    const result = buildImportedLawCandidate({ celex: "32016R0679" });
    expect(result.celex).toBe("32016R0679");
    expect(result.slug).toBe("gdpr");
  });

  it("builds candidate for unknown celex", () => {
    const result = buildImportedLawCandidate({
      celex: "32021R0123",
      officialReference: { actType: "regulation", year: "2021", number: "123" },
    });
    expect(result.celex).toBe("32021R0123");
    expect(result.slug).toBe("regulation-2021-123");
  });
});

describe("getActTypeChoices", () => {
  it("returns regulation, directive, decision", () => {
    const choices = getActTypeChoices();
    expect(choices).toContain("regulation");
    expect(choices).toContain("directive");
    expect(choices).toContain("decision");
    expect(choices).toHaveLength(3);
  });
});

describe("parseOfficialReferenceSlug", () => {
  it("parses valid slug", () => {
    const ref = parseOfficialReferenceSlug("regulation-2016-679");
    expect(ref).toEqual({
      actType: "regulation",
      year: "2016",
      number: "679",
    });
  });

  it("parses directive slug", () => {
    const ref = parseOfficialReferenceSlug("directive-2018-1972");
    expect(ref).toEqual({
      actType: "directive",
      year: "2018",
      number: "1972",
    });
  });

  it("returns null for invalid slugs", () => {
    expect(parseOfficialReferenceSlug("gdpr")).toBeNull();
    expect(parseOfficialReferenceSlug("invalid-2016-679")).toBeNull();
    expect(parseOfficialReferenceSlug("regulation-16-679")).toBeNull();
    expect(parseOfficialReferenceSlug("")).toBeNull();
    expect(parseOfficialReferenceSlug(null)).toBeNull();
  });

  it("roundtrips with getLawSlug", () => {
    const ref = { actType: "regulation", year: "2022", number: "868" };
    const slug = getLawSlug({ officialReference: ref });
    if (slug) {
      const parsed = parseOfficialReferenceSlug(slug);
      if (parsed) {
        expect(parsed).toEqual(ref);
      }
    }
  });
});

describe("parseCelexQuery", () => {
  it("recognizes a bare sector-3 CELEX", () => {
    expect(parseCelexQuery("32016R0679")).toBe("32016R0679");
    expect(parseCelexQuery("32022L2555")).toBe("32022L2555");
    expect(parseCelexQuery("32022D2065")).toBe("32022D2065");
  });

  it("normalizes casing and stray whitespace", () => {
    expect(parseCelexQuery("  32016r0679  ")).toBe("32016R0679");
    expect(parseCelexQuery("32016 R 0679")).toBe("32016R0679");
  });

  it("strips a leading CELEX: prefix", () => {
    expect(parseCelexQuery("celex:32016R0679")).toBe("32016R0679");
    expect(parseCelexQuery("CELEX 32016R0679")).toBe("32016R0679");
  });

  it("accepts the optional disambiguation suffix", () => {
    expect(parseCelexQuery("32004R0139(01)")).toBe("32004R0139(01)");
  });

  it("returns null for non-CELEX queries", () => {
    expect(parseCelexQuery("gdpr")).toBeNull();
    expect(parseCelexQuery("regulation 2016/679")).toBeNull();
    expect(parseCelexQuery("")).toBeNull();
    expect(parseCelexQuery(null)).toBeNull();
  });

  it("returns null for non-legislative sectors and unsupported types", () => {
    expect(parseCelexQuery("62019CJ0311")).toBeNull(); // case law (sector 6)
    expect(parseCelexQuery("32016X0679")).toBeNull(); // unsupported doc type
  });

  it("extracts a CELEX from an EUR-Lex legal-content URL", () => {
    expect(parseCelexQuery("https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679"))
      .toBe("32016R0679");
    expect(parseCelexQuery("https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32016R0679"))
      .toBe("32016R0679");
    expect(parseCelexQuery("https://eur-lex.europa.eu/legal-content/DE/ALL/?uri=CELEX:32022L2555&qid=1"))
      .toBe("32022L2555");
  });

  it("derives a CELEX from an EUR-Lex ELI URL", () => {
    expect(parseCelexQuery("https://eur-lex.europa.eu/eli/reg/2016/679/oj")).toBe("32016R0679");
    expect(parseCelexQuery("https://eur-lex.europa.eu/eli/dir/2015/2366/oj")).toBe("32015L2366");
    expect(parseCelexQuery("http://eur-lex.europa.eu/eli/dec/2020/12/oj")).toBe("32020D0012");
  });

  it("rejects non-EUR-Lex URLs and non-sector-3 URLs", () => {
    expect(parseCelexQuery("https://example.com/?uri=CELEX:32016R0679")).toBeNull();
    expect(parseCelexQuery("https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:62019CJ0311"))
      .toBeNull();
    expect(parseCelexQuery("https://eur-lex.europa.eu/homepage.html")).toBeNull();
    expect(parseCelexQuery("not a url")).toBeNull();
  });
});
