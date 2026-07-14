import { describe, expect, it } from "vitest";
import {
  buildCitedByDisplay,
  formatCitedByReference,
  isCitedByUnavailableError,
  normalizeCitedByUnit,
} from "./citedByDisplay.js";

function provision(celex, unitType, unit, references = []) {
  return { celex, title: celex, unitType, unit, references };
}

function judgment(celex) {
  return { celex, name: celex, references: [] };
}

describe("buildCitedByDisplay", () => {
  it("normalizes storage prefixes and builds public unit labels", () => {
    const display = buildCitedByDisplay({
      article: "6",
      citingProvisions: [
        provision("A", "article", "2"),
        provision("B", "recital", "recital_140"),
        provision("C", "annex", "annex_I"),
      ],
      citingJudgments: [],
      counts: { provisions: 3, judgments: 0, total: 3 },
      pagination: { returned: 3 },
    });

    expect(display.provisions.map(({ unit, unitLabel, articleNumber }) => ({ unit, unitLabel, articleNumber }))).toEqual([
      { unit: "2", unitLabel: "Article 2", articleNumber: "2" },
      { unit: "140", unitLabel: "Recital 140", articleNumber: null },
      { unit: "I", unitLabel: "Annex I", articleNumber: null },
    ]);
    expect(normalizeCitedByUnit("article", "article_2")).toBe("article_2");
    expect(normalizeCitedByUnit("recital", "recital_")).toBe("recital_");
  });

  it("formats and deduplicates paragraph and point reference chips", () => {
    const display = buildCitedByDisplay({
      article: "6",
      citingProvisions: [provision("A", "article", "2", [
        { paragraph: "4", point: "a" },
        { paragraph: "4", point: null },
        { paragraph: null, point: "b" },
        { paragraph: null, point: null },
        { paragraph: "4", point: "a" },
      ])],
      counts: { total: 1 },
      pagination: { returned: 1 },
    });

    expect(display.provisions[0].referenceChips).toEqual([
      "→ Art. 6(4)(a)",
      "→ Art. 6(4)",
      "→ Art. 6(b)",
      "→ Art. 6",
    ]);
    expect(formatCitedByReference("", { raw: "raw reference" })).toBe("raw reference");
  });

  it("represents an empty successful response explicitly", () => {
    const display = buildCitedByDisplay({
      citingProvisions: [],
      citingJudgments: [],
      counts: { provisions: 0, judgments: 0, total: 0 },
      pagination: { returned: 0 },
    });

    expect(display.empty).toBe(true);
    expect(display.visibleProvisions).toEqual([]);
    expect(display.visibleJudgments).toEqual([]);
  });

  it("suppresses only undeployed or unavailable graph responses", () => {
    expect(isCitedByUnavailableError({ status: 404 })).toBe(true);
    expect(isCitedByUnavailableError({ status: 503 })).toBe(true);
    expect(isCitedByUnavailableError({ code: "citation_graph_unavailable" })).toBe(true);
    expect(isCitedByUnavailableError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isCitedByUnavailableError({ status: 500 })).toBe(false);
  });

  it("computes endpoint overflow separately from collapsed rows", () => {
    const display = buildCitedByDisplay({
      citingProvisions: Array.from({ length: 6 }, (_, index) => provision(`P${index}`, "article", String(index + 1))),
      citingJudgments: Array.from({ length: 6 }, (_, index) => judgment(`J${index}`)),
      counts: { provisions: 120, judgments: 85, total: 205 },
      pagination: { returned: 12 },
    });

    expect(display.visibleProvisions).toHaveLength(5);
    expect(display.visibleJudgments).toHaveLength(5);
    expect(display.hiddenCount).toBe(2);
    expect(display.hasHiddenResults).toBe(true);
    expect(display.overflowCount).toBe(193);

    const expanded = buildCitedByDisplay({
      citingProvisions: display.provisions,
      citingJudgments: display.judgments,
      counts: { provisions: 120, judgments: 85, total: 205 },
      pagination: { returned: 12 },
    }, { expanded: true });
    expect(expanded.visibleProvisions).toHaveLength(6);
    expect(expanded.visibleJudgments).toHaveLength(6);
    expect(expanded.hiddenCount).toBe(0);
    expect(expanded.hasHiddenResults).toBe(false);
    expect(expanded.overflowCount).toBe(193);
  });
});
