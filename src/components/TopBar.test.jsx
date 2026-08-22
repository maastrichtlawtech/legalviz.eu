import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";

const { TopBar } = await import("./TopBar.jsx");
const { I18nProvider } = await import("../i18n/I18nProvider.jsx");

let container;
let root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  window.localStorage.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  document.body.innerHTML = "";
  window.localStorage.clear();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

function renderTopBar(props = {}) {
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(
          I18nProvider,
          null,
          createElement(TopBar, {
            lawKey: "32016R0679",
            lists: { articles: [], recitals: [], annexes: [] },
            onSearchOpen: () => Promise.resolve({ articles: [], recitals: [], annexes: [] }),
            ...props,
          })
        )
      )
    );
  });
}

describe("TopBar smoke", () => {
  it("renders with minimal props without crashing", () => {
    renderTopBar();
    expect(container.querySelector("header")).not.toBeNull();
    expect(container.textContent).toContain("Konrad Kollnig");
  });

  it("hosts the search trigger", () => {
    renderTopBar();
    expect(container.querySelector('input[placeholder="Search (Cmd+K)..."]')).not.toBeNull();
  });

  it("omits the search trigger when showSearch is false", () => {
    renderTopBar({ showSearch: false });
    expect(container.querySelector('input[placeholder="Search (Cmd+K)..."]')).toBeNull();
  });
});