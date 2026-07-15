import { describe, expect, it } from "vitest";
import {
  buildChapterEyebrow,
  getChapterArticleRange,
  getChapterMarker,
  isRomanNumeral,
  sentenceCaseTitle,
  splitChapterLabel,
} from "./tocFormat.js";

describe("sentenceCaseTitle", () => {
  it("sentence-cases an all-caps title", () => {
    expect(sentenceCaseTitle("GENERAL PROVISIONS")).toBe("General provisions");
  });

  it("preserves allow-listed acronyms", () => {
    expect(sentenceCaseTitle("OBLIGATIONS UNDER EU AND EEA LAW")).toBe("Obligations under EU and EEA law");
    expect(sentenceCaseTitle("the GDPR framework")).toBe("The GDPR framework");
  });

  it("preserves roman numerals", () => {
    expect(sentenceCaseTitle("TITLE II")).toBe("Title II");
  });

  it("capitalises the first word even when it is short", () => {
    expect(sentenceCaseTitle("data for public sector bodies")).toBe("Data for public sector bodies");
  });

  it("keeps surrounding punctuation and handles empties", () => {
    expect(sentenceCaseTitle("  (SCOPE)  ")).toBe("(Scope)");
    expect(sentenceCaseTitle("")).toBe("");
    expect(sentenceCaseTitle(null)).toBe("");
  });
});

describe("isRomanNumeral", () => {
  it("recognises roman numerals and rejects other tokens", () => {
    expect(isRomanNumeral("IV")).toBe(true);
    expect(isRomanNumeral("viii")).toBe(true);
    expect(isRomanNumeral("scope")).toBe(false);
    expect(isRomanNumeral("")).toBe(false);
  });
});

describe("splitChapterLabel", () => {
  it("splits marker and title", () => {
    expect(splitChapterLabel("I — General provisions")).toEqual({ marker: "I", title: "General provisions" });
  });

  it("treats a label without a marker as title-only", () => {
    expect(splitChapterLabel("General provisions")).toEqual({ marker: "", title: "General provisions" });
  });
});

describe("getChapterMarker", () => {
  it("returns the bare numeral", () => {
    expect(getChapterMarker("I — General provisions")).toBe("I");
    expect(getChapterMarker("CHAPTER II — Scope")).toBe("II");
  });
});

describe("getChapterArticleRange", () => {
  it("derives a range across items and sections", () => {
    const chapter = {
      items: [{ article_number: "1" }],
      sections: [{ items: [{ article_number: "2" }, { article_number: "5" }] }],
    };
    expect(getChapterArticleRange(chapter)).toBe("1–5");
  });

  it("collapses a single-article chapter", () => {
    expect(getChapterArticleRange({ items: [{ article_number: "13" }], sections: [] })).toBe("13");
  });

  it("returns empty when there are no numeric articles", () => {
    expect(getChapterArticleRange({ items: [], sections: [] })).toBe("");
  });
});

describe("buildChapterEyebrow", () => {
  it("prefixes a bare roman marker with the chapter word", () => {
    expect(buildChapterEyebrow("I — GENERAL PROVISIONS", { chapterWord: "Chapter" }))
      .toBe("Chapter I — General provisions");
  });

  it("keeps an already-textual marker", () => {
    expect(buildChapterEyebrow("CHAPTER I — SCOPE", { chapterWord: "Chapter" }))
      .toBe("Chapter I — Scope");
  });

  it("falls back to the title when there is no marker", () => {
    expect(buildChapterEyebrow("GENERAL PROVISIONS", { chapterWord: "Chapter" }))
      .toBe("General provisions");
  });
});
