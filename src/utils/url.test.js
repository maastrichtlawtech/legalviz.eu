import { describe, it, expect } from "vitest";
import {
  buildEurlexSearchUrl,
  buildEurlexOjUrl,
  buildEurlexCelexUrl,
} from "./url.js";

describe("buildEurlexSearchUrl", () => {
  it("builds valid URL with text and language", () => {
    const url = buildEurlexSearchUrl("Regulation 2016/679", "EN");
    expect(url).toContain("eur-lex.europa.eu/search.html");
    expect(url).toContain("text=Regulation+2016%2F679");
    expect(url).toContain("lang=en");
    expect(url).toContain("scope=EURLEX");
  });

  it("returns null for empty text", () => {
    expect(buildEurlexSearchUrl("", "EN")).toBeNull();
    expect(buildEurlexSearchUrl(null, "EN")).toBeNull();
  });

  it("defaults to EN language", () => {
    const url = buildEurlexSearchUrl("test");
    expect(url).toContain("lang=en");
  });

  it("normalizes 3-letter language codes", () => {
    const url = buildEurlexSearchUrl("test", "DEU");
    expect(url).toContain("lang=de");
  });
});

describe("buildEurlexOjUrl", () => {
  it("builds valid OJ URL", () => {
    const url = buildEurlexOjUrl({ ojColl: "L", ojYear: "2016", ojNo: "119", langCode: "EN" });
    expect(url).toContain("eur-lex.europa.eu");
    expect(url).toContain("OJ:L:2016:119:TOC");
  });

  it("returns null when required fields are missing", () => {
    expect(buildEurlexOjUrl({ ojColl: "L", ojYear: "2016" })).toBeNull();
    expect(buildEurlexOjUrl({ ojColl: "L", ojNo: "119" })).toBeNull();
    expect(buildEurlexOjUrl({ ojYear: "2016", ojNo: "119" })).toBeNull();
  });

  it("defaults to EN language", () => {
    const url = buildEurlexOjUrl({ ojColl: "L", ojYear: "2016", ojNo: "119" });
    expect(url).toContain("/EN/");
  });
});

describe("buildEurlexCelexUrl", () => {
  it("builds valid CELEX URL", () => {
    const url = buildEurlexCelexUrl("32016R0679", "EN");
    expect(url).toContain("CELEX:32016R0679");
    expect(url).toContain("/EN/");
  });

  it("returns null for empty celex", () => {
    expect(buildEurlexCelexUrl("")).toBeNull();
    expect(buildEurlexCelexUrl(null)).toBeNull();
  });
});
