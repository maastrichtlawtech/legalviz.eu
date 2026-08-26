import { describe, it, expect } from "vitest";
import { parseOfficialReference, getReferenceLabel } from "./officialReferences.js";

describe("parseOfficialReference", () => {
  it.each([
    ["Decision 676/2002/EC", { actType: "decision", year: "2002", number: "676", suffix: "EC" }],
    ["Decision 460/2004/EC", { actType: "decision", year: "2004", number: "460", suffix: "EC" }],
    ["Decision No 243/2012/EU", { actType: "decision", year: "2012", number: "243", suffix: "EU" }],
    ["Directive 95/46/EC", { actType: "directive", year: "1995", number: "46", suffix: "EC" }],
    ["Directive 93/13", { actType: "directive", year: "1993", number: "13", suffix: null }],
    ["Regulation 1612/68/EEC", { actType: "regulation", year: "1968", number: "1612", suffix: "EEC" }],
    ["Regulation (EU) 2016/679", { actType: "regulation", year: "2016", number: "679", suffix: "EU" }],
    ["Directive 2002/58/EC", { actType: "directive", year: "2002", number: "58", suffix: "EC" }],
  ])("keeps the official reference shape for %s", (input, expected) => {
    expect(parseOfficialReference(input)).toMatchObject(expected);
  });

  it.each(["EU", "EC", "EEC", "EURATOM", "JHA"])("captures a parenthesised %s suffix", (suffix) => {
    expect(parseOfficialReference(`Regulation (${suffix}) 2016/679`)).toMatchObject({
      year: "2016",
      number: "679",
      suffix,
    });
  });

  it("captures a parenthesised suffix before the No. form", () => {
    expect(parseOfficialReference("Regulation (EC) No 1924/2006")).toMatchObject({
      year: "2006",
      number: "1924",
      suffix: "EC",
    });
  });

  it("prefers an explicit trailing suffix over a parenthesised suffix", () => {
    expect(parseOfficialReference("Regulation (EU) 2016/679/EC").suffix).toBe("EC");
  });

  it.each([
    ["Decision 1949/2002/EC", "1949"],
    ["Decision 2101/2002/EC", "2101"],
  ])("does not read boundary first component %s as a year", (input, number) => {
    expect(parseOfficialReference(input)).toMatchObject({
      year: "2002",
      number,
      suffix: "EC",
    });
  });

  it("parses standard regulation format: Regulation (EU) 2016/679", () => {
    const result = parseOfficialReference("Regulation (EU) 2016/679");
    expect(result).toMatchObject({
      actType: "regulation",
      year: "2016",
      number: "679",
    });
  });

  it("parses directive with 4-digit year/number: Directive 2018/1972", () => {
    const result = parseOfficialReference("Directive 2018/1972");
    expect(result).toMatchObject({
      actType: "directive",
      year: "2018",
      number: "1972",
    });
  });

  it("parses decision format", () => {
    const result = parseOfficialReference("Decision (EU) 2013/755");
    expect(result).toMatchObject({
      actType: "decision",
      year: "2013",
      number: "755",
    });
  });

  it("parses German: Verordnung (EU) 2022/868", () => {
    const result = parseOfficialReference("Verordnung (EU) 2022/868");
    expect(result).toMatchObject({
      actType: "regulation",
      year: "2022",
      number: "868",
    });
  });

  it("parses French: Directive 2018/1972", () => {
    const result = parseOfficialReference("Directive 2018/1972");
    expect(result).toMatchObject({
      actType: "directive",
      year: "2018",
      number: "1972",
    });
  });

  it("parses old-style number/year: Directive 95/46/EC", () => {
    const result = parseOfficialReference("Directive 95/46/EC");
    expect(result).toMatchObject({
      actType: "directive",
      year: "1995",
      number: "46",
      suffix: "EC",
    });
  });

  it("parses old-style 4-digit number/2-digit year: Regulation 1612/68/EEC", () => {
    const result = parseOfficialReference("Regulation 1612/68/EEC");
    expect(result).toMatchObject({
      actType: "regulation",
      year: "1968",
      number: "1612",
      suffix: "EEC",
    });
  });

  it("parses old-style without suffix: Directive 93/13", () => {
    const result = parseOfficialReference("Directive 93/13");
    expect(result).toMatchObject({
      actType: "directive",
      year: "1993",
      number: "13",
      suffix: null,
    });
  });

  it("parses with No. prefix: Directive No. 46/95", () => {
    const result = parseOfficialReference("Directive No. 46/95");
    expect(result).not.toBeNull();
    expect(result.actType).toBe("directive");
  });

  it("returns null for empty input", () => {
    expect(parseOfficialReference("")).toBeNull();
    expect(parseOfficialReference()).toBeNull();
  });

  it("returns null when actType is missing", () => {
    expect(parseOfficialReference("2016/679")).toBeNull();
  });

  it("returns null when number part is missing", () => {
    expect(parseOfficialReference("Regulation something")).toBeNull();
  });

  it("handles extra whitespace", () => {
    const result = parseOfficialReference("  Regulation  (EU)  2016/679  ");
    expect(result).not.toBeNull();
    expect(result.actType).toBe("regulation");
    expect(result.year).toBe("2016");
  });

  it("parses regulation with (EC) prefix", () => {
    const result = parseOfficialReference("Regulation (EC) 2006/1907");
    expect(result).toMatchObject({
      actType: "regulation",
      year: "2006",
      number: "1907",
      suffix: "EC",
    });
  });
});

describe("getReferenceLabel", () => {
  it("returns raw when available", () => {
    const ref = { raw: "Regulation (EU) 2016/679", actType: "regulation", year: "2016", number: "679" };
    expect(getReferenceLabel(ref)).toBe("Regulation (EU) 2016/679");
  });

  it("builds label from actType and year/number when no raw", () => {
    const ref = { actType: "directive", year: "2018", number: "1972" };
    expect(getReferenceLabel(ref)).toBe("directive 2018/1972");
  });

  it("handles null/undefined input", () => {
    expect(getReferenceLabel(null)).toBeFalsy();
    expect(getReferenceLabel(undefined)).toBeFalsy();
  });
});
