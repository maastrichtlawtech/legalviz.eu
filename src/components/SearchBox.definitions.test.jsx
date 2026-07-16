import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";

const searchDefinitions = vi.fn();
const searchLaws = vi.fn(() => Promise.resolve({ results: [] }));
vi.mock("../utils/formexApi.js", async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    searchDefinitions: (...args) => searchDefinitions(...args),
    searchLaws: (...args) => searchLaws(...args),
  };
});

const { SearchBox } = await import("./TopBar.jsx");
const { I18nProvider } = await import("../i18n/I18nProvider.jsx");

let container;
let root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.clearAllTimers();
  vi.useRealTimers();
  searchDefinitions.mockReset();
  searchLaws.mockClear();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

function renderSearchBox(onNavigate = vi.fn()) {
  root = createRoot(container);
  act(() => {
    root.render(createElement(
      MemoryRouter,
      null,
      createElement(
        I18nProvider,
        null,
        createElement(SearchBox, {
          lists: { articles: [], recitals: [], annexes: [] },
          onNavigate,
          onSearchOpen: () => Promise.resolve({ articles: [], recitals: [], annexes: [] }),
          triggerVariant: "hero",
          searchModes: ["laws", "definitions"],
        }),
      ),
    ));
  });
  return onNavigate;
}

function openDefinitionsMode() {
  const heroInput = container.querySelector("input");
  typeInto(heroInput, "zz");
  const tab = Array.from(document.body.querySelectorAll('[role="tab"]'))
    .find((element) => element.textContent === "Definitions");
  act(() => tab.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  return document.body.querySelector('[role="dialog"] input');
}

function typeInto(input, value) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("SearchBox — definitions mode", () => {
  it("debounces definition search and renders definition metadata", async () => {
    searchDefinitions.mockResolvedValue({
      results: [{
        term: "energy poverty",
        normalizedTerm: "energy poverty",
        sampleDefinition: "a household's lack of access to essential energy services",
        lawCount: 4,
        substantiveLawCount: 3,
        importCount: 1,
        wordingCount: 2,
        representativeSource: { celex: "32023L1791", article: "2" },
      }],
    });
    renderSearchBox();
    const input = openDefinitionsMode();
    typeInto(input, "energy poverty");

    expect(searchDefinitions).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(300));

    expect(searchDefinitions).toHaveBeenCalledWith("energy poverty", expect.objectContaining({ limit: 12 }));
    expect(document.body.textContent).toContain("energy poverty");
    expect(document.body.textContent).toContain("3 laws");
    expect(document.body.textContent).not.toContain("2 wordings");
    expect(document.body.textContent).toContain("Different definitions");
    expect(document.body.textContent).toContain("1 imported by reference");
    expect(document.body.textContent).toContain("Opens at: 32023L1791 · Article 2");
    expect(document.body.querySelectorAll("mark").length).toBeGreaterThan(0);
  });

  it("identifies a definition reused with the same wording", async () => {
    searchDefinitions.mockResolvedValue({
      results: [{
        term: "technical specification",
        normalizedTerm: "technical specification",
        sampleDefinition: "a document that prescribes technical requirements",
        lawCount: 6,
        substantiveLawCount: 4,
        importCount: 2,
        wordingCount: 1,
        representativeSource: { celex: "32022L2555", sourceArticle: "6" },
      }],
    });
    renderSearchBox();
    const input = openDefinitionsMode();
    typeInto(input, "technical specification");
    await act(async () => vi.advanceTimersByTimeAsync(300));

    expect(document.body.textContent).toContain("Same extracted wording");
    expect(document.body.textContent).toContain("2 imported by reference");
    expect(document.body.textContent).toContain("32022L2555 · Article 6");
  });

  it("supports keyboard selection of a definition result", async () => {
    searchDefinitions.mockResolvedValue({
      results: [{
        term: "risk",
        normalizedTerm: "risk",
        sampleDefinition: "the potential for loss or disruption",
        lawCount: 2,
        wordingCount: 1,
        representativeSource: { celex: "32022L2555", article: "6" },
      }],
    });
    const onNavigate = renderSearchBox();
    const input = openDefinitionsMode();
    typeInto(input, "risk");
    await act(async () => vi.advanceTimersByTimeAsync(300));

    // Older servers did not distinguish substantive definitions from imports.
    // Keep their count usable, but do not infer equivalence from wordingCount.
    expect(document.body.textContent).toContain("2 laws");
    expect(document.body.textContent).not.toContain("Same extracted wording");

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));

    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({
      search_kind: "definition",
      normalizedTerm: "risk",
    }));
  });

  it("discovers terms with different substantive definitions without a query", async () => {
    searchDefinitions.mockResolvedValue({
      results: [{
        term: "incident",
        normalizedTerm: "incident",
        sampleDefinition: "an event compromising service availability",
        lawCount: 2,
        substantiveLawCount: 2,
        importCount: 0,
        wordingCount: 2,
        representativeSource: { celex: "32022L2555", sourceArticle: "6" },
      }],
    });
    renderSearchBox();
    openDefinitionsMode();
    const button = Array.from(document.body.querySelectorAll("button"))
      .find((element) => element.textContent === "Different definitions");

    await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(searchDefinitions).toHaveBeenCalledWith("", expect.objectContaining({
      filter: "different",
      limit: 12,
    }));
    expect(document.body.textContent).toContain("incident");
  });
});
