import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";

const { SearchBox } = await import("./TopBar.jsx");
const { I18nProvider } = await import("../i18n/I18nProvider.jsx");

let container;
let root;

const emptyLists = { articles: [], recitals: [], annexes: [] };
const lists = {
  articles: [{
    article_number: "1",
    article_title: "Personal data",
    article_html: "<p>The protection of personal data is fundamental.</p>",
    law_key: "gdpr",
    law_slug: "gdpr",
  }],
  recitals: [],
  annexes: [],
};

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
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

function typeInto(input, value) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

// Mirrors the LawViewer invocation: the law reader defaults to "current" mode,
// which must render without crashing (the busy flags live in a hook whose
// state arrives only after that hook has run).
function renderLawReaderSearchBox() {
  root = createRoot(container);
  act(() => {
    root.render(createElement(
      MemoryRouter,
      null,
      createElement(I18nProvider, null, createElement(SearchBox, {
        lists,
        onNavigate: () => {},
        onSearchOpen: () => Promise.resolve(emptyLists),
        searchableLawCount: 3,
        triggerVariant: "hero",
        searchModes: ["laws", "matches", "definitions", "fulltext", "current"],
        defaultSearchMode: "current",
      })),
    ));
  });
}

describe("SearchBox — current and matches modes", () => {
  it("renders current mode by default and clears results when the query shrinks below two characters", async () => {
    renderLawReaderSearchBox();

    const heroInput = container.querySelector("input");
    typeInto(heroInput, "data");
    const dialogInput = document.body.querySelector('[role="dialog"] input');
    expect(dialogInput).not.toBeNull();

    // The current-law index builds through a setTimeout(100).
    await act(async () => vi.advanceTimersByTimeAsync(150));
    expect(document.body.textContent).toContain("Art. 1");

    typeInto(dialogInput, "d");
    expect(document.body.textContent).not.toContain("Art. 1");
  });

  it("switches to matches mode without crashing", async () => {
    renderLawReaderSearchBox();

    const heroInput = container.querySelector("input");
    typeInto(heroInput, "zz");
    const tab = Array.from(document.body.querySelectorAll('[role="tab"]'))
      .find((element) => element.textContent === "Opened laws");
    expect(tab).toBeTruthy();

    act(() => tab.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(document.body.querySelector('[role="dialog"] input')).not.toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(150));
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("clears matches results when the query shrinks below two characters", async () => {
    renderLawReaderSearchBox();

    const heroInput = container.querySelector("input");
    typeInto(heroInput, "zz");
    const tab = Array.from(document.body.querySelectorAll('[role="tab"]'))
      .find((element) => element.textContent === "Opened laws");
    act(() => tab.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const dialogInput = document.body.querySelector('[role="dialog"] input');
    typeInto(dialogInput, "data");
    await act(async () => vi.advanceTimersByTimeAsync(150));
    expect(document.body.textContent).toContain("Art. 1");

    typeInto(dialogInput, "d");
    expect(document.body.textContent).not.toContain("Art. 1");
  });
});
