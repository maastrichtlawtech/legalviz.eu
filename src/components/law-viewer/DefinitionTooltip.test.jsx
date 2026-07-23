import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefinitionTooltip } from "./DefinitionTooltip.jsx";

let container;
let root;
let term;

function t(key) {
  return key;
}

// jsdom has no matchMedia; fake it so the component can pick sheet vs anchored.
function mockMatchMedia(matches) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

function renderTooltip(props = {}) {
  act(() => {
    root.render(<DefinitionTooltip t={t} {...props} />);
  });
}

function tapTerm() {
  // Mirror the mobile order: the tabindex=0 span focuses, then click fires.
  act(() => {
    term.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    term.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  term = document.createElement("span");
  term.className = "defined-term";
  term.setAttribute("tabindex", "0");
  term.setAttribute("data-term", "personal data");
  term.setAttribute("data-definition", "information relating to an identified person");
  term.textContent = "personal data";
  document.body.appendChild(term);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  term.remove();
  vi.restoreAllMocks();
});

describe("DefinitionTooltip on mobile (sheet mode)", () => {
  beforeEach(() => mockMatchMedia(true));

  it("opens a bottom sheet when a defined term is tapped", () => {
    renderTooltip();
    tapTerm();

    const sheet = document.querySelector('[role="dialog"]');
    expect(sheet).not.toBeNull();
    expect(sheet.textContent).toContain("personal data");
  });

  it("stays open when the mobile URL bar fires a resize right after opening", () => {
    renderTooltip();
    tapTerm();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    // Tapping the focusable term makes the browser scroll it into view and
    // toggle the URL bar, firing scroll + resize. The sheet must survive both.
    act(() => {
      window.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new Event("resize"));
    });

    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
});

describe("DefinitionTooltip on desktop (anchored mode)", () => {
  beforeEach(() => mockMatchMedia(false));

  it("renders an anchored tooltip on hover", () => {
    renderTooltip();
    act(() => {
      term.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });

    const tip = document.querySelector('[role="tooltip"]');
    expect(tip).not.toBeNull();
    expect(tip.textContent).toContain("personal data");
  });
});
