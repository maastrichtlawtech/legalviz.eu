import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";

const { McpLandingTeaser, McpTopBarButton } = await import("./McpPromo.jsx");
const { I18nProvider } = await import("../i18n/I18nProvider.jsx");

const MCP_PROMO_SEEN_KEY = "legalviz_mcp_promo_seen";
const MCP_SERVER_URL = "https://api.legalviz.eu/mcp";

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
  vi.unstubAllGlobals();
});

function render(Component) {
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(MemoryRouter, null, createElement(I18nProvider, null, createElement(Component)))
    );
  });
}

describe("McpModal", () => {
  it("opens from the landing teaser and shows the server URL", () => {
    render(McpLandingTeaser);

    expect(document.querySelector('[role="dialog"]')).toBeNull();

    act(() => {
      container.querySelector("button").click();
    });

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain(MCP_SERVER_URL);
  });

  it("closes on Escape and on backdrop click", () => {
    render(McpLandingTeaser);

    act(() => {
      container.querySelector("button").click();
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    act(() => {
      container.querySelector("button").click();
    });
    const backdrop = document.querySelector(".fixed.inset-0 > .absolute.inset-0");
    act(() => {
      backdrop.click();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("copies the server URL to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    render(McpLandingTeaser);

    act(() => {
      container.querySelector("button").click();
    });

    const copyButton = Array.from(document.querySelectorAll("button")).find((btn) =>
      btn.textContent.includes("Copy")
    );

    await act(async () => {
      copyButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(MCP_SERVER_URL);
    expect(copyButton.textContent).toContain("Copied");
  });

  it("falls back to execCommand when the clipboard API is unavailable", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    const execCommand = vi.fn().mockReturnValue(true);
    document.execCommand = execCommand;

    render(McpLandingTeaser);

    act(() => {
      container.querySelector("button").click();
    });

    const copyButton = Array.from(document.querySelectorAll("button")).find((btn) =>
      btn.textContent.includes("Copy")
    );

    await act(async () => {
      copyButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(copyButton.textContent).toContain("Copied");
  });
});

describe("McpTopBarButton", () => {
  it("shows a dismissal dot until first opened, and persists the dismissal", () => {
    render(McpTopBarButton);

    expect(container.querySelector(".bg-eu-gold-deep")).not.toBeNull();
    expect(window.localStorage.getItem(MCP_PROMO_SEEN_KEY)).toBeNull();

    act(() => {
      container.querySelector("button").click();
    });

    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelector(".bg-eu-gold-deep")).toBeNull();
    expect(window.localStorage.getItem(MCP_PROMO_SEEN_KEY)).toBe("1");
  });

  it("renders without a dot on remount once the promo has been seen", () => {
    window.localStorage.setItem(MCP_PROMO_SEEN_KEY, "1");

    render(McpTopBarButton);

    expect(container.querySelector(".bg-eu-gold-deep")).toBeNull();
  });
});
