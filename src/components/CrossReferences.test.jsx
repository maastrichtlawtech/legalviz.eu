import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";

vi.mock("../i18n/useI18n.js", () => ({
  useI18n: () => ({ t: (key) => key }),
}));

import { CrossReferences } from "./CrossReferences.jsx";

let container;
let root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  document.body.innerHTML = "";
});

function render(props) {
  root = createRoot(container);
  act(() => {
    root.render(createElement(CrossReferences, {
      articleNumber: "1",
      crossReferences: {},
      compact: true,
      ...props,
    }));
  });
}

function buttonLabels() {
  return Array.from(container.querySelectorAll("button")).map((b) => b.textContent);
}

describe("CrossReferences", () => {
  it("renders nothing when crossReferences is missing", () => {
    render({ crossReferences: undefined });
    expect(container.textContent).toBe("");
  });

  it("renders nothing when there are no refs at all", () => {
    render({ crossReferences: { "1": [] } });
    expect(container.textContent).toBe("");
  });

  it("computes back-references from article keys, skipping recital_ and annex_ prefixes", () => {
    const crossReferences = {
      "1": [{ type: "article", target: "2" }],
      "2": [{ type: "article", target: "1" }],
      "5": [{ type: "article", target: "1" }],
      "recital_1": [{ type: "article", target: "1" }],
      "annex_1": [{ type: "article", target: "1" }],
    };
    render({
      articleNumber: "1",
      crossReferences,
      articles: [
        { article_number: "1", article_title: "Subject matter" },
        { article_number: "2", article_title: "Definitions" },
        { article_number: "5", article_title: "Transparency" },
      ],
    });

    const labels = buttonLabels();

    // Forward ref from article 1 to article 2, plus back refs from 2 and 5.
    // Button text is "Art. N" followed by the article title when present.
    expect(labels.filter((label) => label.startsWith("Art. 2")).length).toBe(2);
    expect(labels.some((label) => label.startsWith("Art. 5"))).toBe(true);
    // recital_/annex_ keys are not back-reference sources.
    expect(labels.some((label) => label.includes("recital_1"))).toBe(false);
    expect(labels.some((label) => label.includes("annex_1"))).toBe(false);
    // One forward (Art. 2) + two back (Art. 2, Art. 5) buttons.
    expect(container.querySelectorAll("button").length).toBe(3);
  });

  it("skips the article's own key as a back-reference source", () => {
    render({
      articleNumber: "1",
      crossReferences: {
        "1": [{ type: "article", target: "2" }],
        "2": [{ type: "article", target: "1" }],
      },
    });

    const labels = buttonLabels();
    expect(labels.filter((label) => label === "Art. 1").length).toBe(0);
    expect(labels.filter((label) => label === "Art. 2").length).toBe(2);
  });

  it("omits back-references when showBackReferences is false", () => {
    render({
      articleNumber: "1",
      crossReferences: {
        "2": [{ type: "article", target: "1" }],
        "1": [{ type: "article", target: "2" }],
      },
      showBackReferences: false,
    });

    expect(buttonLabels()).toEqual(["Art. 2"]);
  });

  it("calls onSelectArticle with the forward-ref target", () => {
    const onSelectArticle = vi.fn();
    render({
      articleNumber: "1",
      crossReferences: {
        "1": [{ type: "article", target: "7" }],
      },
      onSelectArticle,
    });

    const forwardButton = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent.includes("Art. 7"));
    act(() => forwardButton.click());
    expect(onSelectArticle).toHaveBeenCalledWith("7");
  });

  it("truncates long raw strings on external refs to 57 chars plus an ellipsis", () => {
    const longRaw = "x".repeat(80);
    render({
      crossReferences: {
        "1": [{ type: "external", raw: longRaw }],
      },
    });

    const label = buttonLabels()[0];
    expect(label.length).toBe(58);
    expect(label.endsWith("…")).toBe(true);
    expect(label).toBe(`${"x".repeat(57)}…`);
  });

  it("keeps short external refs untruncated", () => {
    render({
      crossReferences: {
        "1": [{ type: "external", raw: "short reference" }],
      },
    });

    expect(buttonLabels()).toEqual(["short reference"]);
  });

  it("does not truncate oj_ref raw strings", () => {
    const longRaw = "y".repeat(70);
    render({
      crossReferences: {
        "1": [{ type: "oj_ref", raw: longRaw }],
      },
    });

    expect(buttonLabels()).toEqual([longRaw]);
  });

  it("renders the oj_ref button even when its URL cannot be built, and opening does nothing", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    render({
      crossReferences: {
        "1": [{ type: "oj_ref", raw: "OJ L 123, 5.6.2021" }],
      },
    });

    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button.disabled).toBe(false);

    act(() => button.click());
    expect(openSpy).not.toHaveBeenCalled();

    openSpy.mockRestore();
  });

  it("opens the search URL for external refs when no handler is provided", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    render({
      crossReferences: {
        "1": [{ type: "external", raw: "Regulation (EU) 2016/679" }],
      },
    });

    act(() => container.querySelector("button").click());
    expect(openSpy).toHaveBeenCalledTimes(1);
    const [url, target, features] = openSpy.mock.calls[0];
    expect(url).toMatch(/^https:\/\/eur-lex\.europa\.eu\/search\.html\?/);
    expect(target).toBe("_blank");
    expect(features).toBe("noopener,noreferrer");

    openSpy.mockRestore();
  });

  it("disables the external button while the reference is pending", () => {
    render({
      crossReferences: {
        "1": [{ type: "external", raw: "Regulation (EU) 2016/679" }],
      },
      isExternalReferencePending: () => true,
    });

    const button = container.querySelector("button");
    expect(button.disabled).toBe(true);
  });

  it("renders the external ref through onOpenExternalReference when provided", () => {
    const onOpenExternalReference = vi.fn();
    render({
      crossReferences: {
        "1": [{ type: "external", raw: "Regulation (EU) 2016/679" }],
      },
      onOpenExternalReference,
    });

    act(() => container.querySelector("button").click());
    expect(onOpenExternalReference).toHaveBeenCalledWith({ type: "external", raw: "Regulation (EU) 2016/679" });
  });

  it("collapses content behind the header until opened, with a total count badge", () => {
    render({
      compact: false,
      crossReferences: {
        "1": [{ type: "article", target: "2" }],
        "2": [{ type: "article", target: "1" }],
      },
    });

    // Header button only — content hidden.
    expect(container.querySelectorAll("button").length).toBe(1);
    expect(container.textContent).toContain("2");
    expect(buttonLabels()[0]).not.toContain("Art.");

    act(() => container.querySelector("button").click());
    const labels = buttonLabels();
    expect(labels.filter((label) => label.includes("Art.")).length).toBe(2);
  });

  it("shows the paragraph suffix and article title on forward refs", () => {
    render({
      articleNumber: "1",
      crossReferences: {
        "1": [{ type: "article", target: "2", paragraph: "1" }],
      },
      articles: [
        { article_number: "2", article_title: "Definitions" },
      ],
    });

    const button = container.querySelector("button");
    expect(button.textContent).toContain("Art. 2");
    expect(button.textContent).toContain("(1)");
    expect(button.textContent).toContain("Definitions");
  });
});