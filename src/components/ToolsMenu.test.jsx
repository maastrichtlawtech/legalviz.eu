import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";

const { ToolsMenu } = await import("./ToolsMenu.jsx");
const { I18nProvider } = await import("../i18n/I18nProvider.jsx");
const { ThemeProvider } = await import("./ThemeProvider.jsx");

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

function renderToolsMenu(props = {}) {
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(
          I18nProvider,
          null,
          createElement(ThemeProvider, { defaultTheme: "light" }, createElement(ToolsMenu, props))
        )
      )
    );
  });
}

function triggerButton() {
  return container.querySelector('button[title="More tools"]');
}

function openMenu() {
  act(() => triggerButton().click());
}

describe("ToolsMenu", () => {
  it("opens and closes the menu on the trigger button", () => {
    renderToolsMenu();

    expect(container.querySelector(".absolute.right-0")).toBeNull();
    openMenu();
    expect(container.querySelector(".absolute.right-0")).not.toBeNull();
    act(() => triggerButton().click());
    expect(container.querySelector(".absolute.right-0")).toBeNull();
  });

  it("calls the sidebar toggle callback and closes the menu", () => {
    const onToggleSidebar = vi.fn();
    renderToolsMenu({ onToggleSidebar, isSidebarOpen: false });

    openMenu();
    const item = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent.includes("Show sidebar"));
    act(() => item.click());

    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".absolute.right-0")).toBeNull();
  });

  it("hides the print item when showPrint is false", () => {
    renderToolsMenu({ showPrint: false, onPrint: vi.fn() });
    openMenu();

    const menuText = container.querySelector(".absolute.right-0").textContent;
    expect(menuText).not.toContain("Print / PDF");
  });

  it("shows the print item when showPrint is true and invokes onPrint", () => {
    const onPrint = vi.fn();
    renderToolsMenu({ showPrint: true, onPrint });
    openMenu();

    const item = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent.includes("Print / PDF"));
    expect(item).toBeTruthy();
    act(() => item.click());
    expect(onPrint).toHaveBeenCalledTimes(1);
  });

  it("renders an EUR-Lex link when eurlexUrl is given", () => {
    renderToolsMenu({ eurlexUrl: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679" });
    openMenu();

    const link = container.querySelector('a[href^="https://eur-lex.europa.eu"]');
    expect(link).toBeTruthy();
    expect(link.target).toBe("_blank");
    expect(link.textContent).toContain("View on EUR-Lex");
  });
});