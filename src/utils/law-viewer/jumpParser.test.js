import { describe, expect, it } from "vitest";
import { parseJumpQuery } from "./jumpParser.js";

describe("parseJumpQuery", () => {
  it("defaults a bare number to an article", () => {
    expect(parseJumpQuery("23")).toEqual({ kind: "article", number: 23 });
    expect(parseJumpQuery(" 007 ")).toEqual({ kind: "article", number: 7 });
  });

  it("parses article shorthands", () => {
    expect(parseJumpQuery("art 23")).toEqual({ kind: "article", number: 23 });
    expect(parseJumpQuery("art23")).toEqual({ kind: "article", number: 23 });
    expect(parseJumpQuery("Art. 23")).toEqual({ kind: "article", number: 23 });
    expect(parseJumpQuery("a23")).toEqual({ kind: "article", number: 23 });
    expect(parseJumpQuery("ARTICLE 5")).toEqual({ kind: "article", number: 5 });
  });

  it("parses recital shorthands", () => {
    expect(parseJumpQuery("rec 40")).toEqual({ kind: "recital", number: 40 });
    expect(parseJumpQuery("r40")).toEqual({ kind: "recital", number: 40 });
    expect(parseJumpQuery("recital 40")).toEqual({ kind: "recital", number: 40 });
  });

  it("parses annex shorthands", () => {
    expect(parseJumpQuery("annex 2")).toEqual({ kind: "annex", number: 2 });
    expect(parseJumpQuery("anx 2")).toEqual({ kind: "annex", number: 2 });
    expect(parseJumpQuery("annex2")).toEqual({ kind: "annex", number: 2 });
  });

  it("rejects invalid input", () => {
    expect(parseJumpQuery("")).toBeNull();
    expect(parseJumpQuery("hello")).toBeNull();
    expect(parseJumpQuery("art 0")).toBeNull();
    expect(parseJumpQuery("0")).toBeNull();
    expect(parseJumpQuery("art abc")).toBeNull();
  });
});
