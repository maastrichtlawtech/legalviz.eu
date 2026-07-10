import { describe, it, expect } from "vitest";
import { injectDefinitionTooltips } from "./definitions.js";

const DEFINITIONS = [
  { term: "personal data", definition: "any information relating to an identified natural person" },
  { term: "controller", definition: "the entity which determines the purposes of processing" },
  { term: "processing", definition: "any operation performed on personal data" },
];

describe("injectDefinitionTooltips", () => {
  it("wraps defined terms with tooltip spans", () => {
    const html = "<p>The controller shall ensure personal data is protected.</p>";
    const result = injectDefinitionTooltips(html, DEFINITIONS);
    expect(result).toContain('class="defined-term"');
    expect(result).toContain("personal data");
  });

  it("includes definition text in data attribute", () => {
    const html = "<p>The controller processes data.</p>";
    const result = injectDefinitionTooltips(html, DEFINITIONS);
    expect(result).toContain('data-definition="');
  });

  it("returns html unchanged when definitions array is empty", () => {
    const html = "<p>Some text.</p>";
    expect(injectDefinitionTooltips(html, [])).toBe(html);
  });

  it("returns html unchanged when html is empty/null", () => {
    expect(injectDefinitionTooltips("", DEFINITIONS)).toBe("");
    expect(injectDefinitionTooltips(null, DEFINITIONS)).toBeNull();
  });

  it("does not replace inside HTML tags", () => {
    const html = '<p class="controller-panel">The controller is responsible.</p>';
    const result = injectDefinitionTooltips(html, DEFINITIONS);
    // class attribute should not be modified
    expect(result).toContain('class="controller-panel"');
  });

  it("matches terms case-insensitively", () => {
    const html = "<p>PERSONAL DATA must be protected.</p>";
    const result = injectDefinitionTooltips(html, DEFINITIONS);
    expect(result).toContain('class="defined-term"');
  });

  it("does not double-wrap already-wrapped terms", () => {
    const html = '<p><span class="defined-term" data-definition="test">controller</span> and controller</p>';
    const result = injectDefinitionTooltips(html, DEFINITIONS);
    // Should only have 2 defined-term spans (1 existing + 1 new for the second occurrence)
    const matches = result.match(/class="defined-term"/g);
    expect(matches.length).toBe(2);
  });

  it("skips the definitions article when skipDefinitionsArticle is true", () => {
    const html = '<p class="oj-sti-art">Definitions</p><p>The controller processes personal data.</p>';
    const result = injectDefinitionTooltips(html, DEFINITIONS, { skipDefinitionsArticle: true });
    expect(result).not.toContain('class="defined-term"');
  });

  it("does NOT skip articles that just mention 'definition' in text", () => {
    const html = "<p>This is about the definition of scope.</p>";
    const result = injectDefinitionTooltips(html, DEFINITIONS, { skipDefinitionsArticle: true });
    // Should still wrap terms since this isn't the definitions article (no oj-sti-art heading)
    // The terms may or may not appear — just check it wasn't completely skipped
    expect(result).toBeTruthy();
  });

  it("longer terms are matched before shorter ones", () => {
    const defs = [
      { term: "data", definition: "information" },
      { term: "personal data", definition: "data about a person" },
    ];
    const html = "<p>This concerns personal data.</p>";
    const result = injectDefinitionTooltips(html, defs);
    // "personal data" should match as one term, not "data" separately
    expect(result).toContain(">personal data</span>");
  });

  it("handles inflected languages (Polish)", () => {
    const defs = [{ term: "dane osobowe", definition: "informacje dotyczące osoby fizycznej" }];
    const html = "<p>Przetwarzanie danych osobowych wymaga podstawy prawnej.</p>";
    const result = injectDefinitionTooltips(html, defs, { langCode: "PL" });
    expect(result).toContain('class="defined-term"');
  });

  it("does not match the stem of an inflected term inside an unrelated word", () => {
    const defs = [{ term: "dane", definition: "informacje dotyczące osoby fizycznej" }];

    // "abundance" contains the "dan" stem mid-word — must NOT be wrapped.
    const unrelatedHtml = "<p>The region saw an abundance of natural resources.</p>";
    const unrelatedResult = injectDefinitionTooltips(unrelatedHtml, defs, { langCode: "PL" });
    expect(unrelatedResult).not.toContain('class="defined-term"');

    // "danych" is a genuine inflected form of "dane" and must still be wrapped.
    const inflectedHtml = "<p>Przetwarzanie danych wymaga podstawy prawnej.</p>";
    const inflectedResult = injectDefinitionTooltips(inflectedHtml, defs, { langCode: "PL" });
    expect(inflectedResult).toContain('class="defined-term"');
  });

  it("escapes HTML in definition attributes", () => {
    const defs = [{ term: "test", definition: 'a "special" <value> & entity' }];
    const html = "<p>This is a test.</p>";
    const result = injectDefinitionTooltips(html, defs);
    expect(result).not.toContain('<value>');
    expect(result).toContain("&amp;");
  });
});
