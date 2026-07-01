import { describe, expect, it } from "vitest";
import { resolveSelectionFromData } from "./selection.js";

const data = {
  articles: [{ article_number: "1", article_html: "<p>A1</p>" }],
  recitals: [{ recital_number: "3", recital_html: "<p>R3</p>" }],
  annexes: [{ annex_id: "I", annex_html: "<p>X</p>" }],
};

describe("resolveSelectionFromData", () => {
  it("returns the requested matching entry", () => {
    expect(resolveSelectionFromData(data, "recital", "3")).toEqual({
      kind: "recital",
      id: "3",
      html: "<p>R3</p>",
    });
  });

  it("resolves to the overview state when no route params are given", () => {
    expect(resolveSelectionFromData(data, null, null)).toEqual({
      kind: "overview",
      id: null,
      html: "",
    });
  });

  it("falls back to the first article (not overview) when only kind or only id is given", () => {
    expect(resolveSelectionFromData(data, "article", null)).toEqual({
      kind: "article",
      id: "1",
      html: "<p>A1</p>",
    });
    expect(resolveSelectionFromData(data, null, "1")).toEqual({
      kind: "article",
      id: "1",
      html: "<p>A1</p>",
    });
  });

  it("falls back to the first article when route params are invalid", () => {
    expect(resolveSelectionFromData(data, "article", "99")).toEqual({
      kind: "article",
      id: "1",
      html: "<p>A1</p>",
    });
  });
});
