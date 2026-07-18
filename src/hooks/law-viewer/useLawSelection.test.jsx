import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useLawSelection } from "./useLawSelection.js";

const lawA = {
  celex: "32016R0679",
  articles: [
    { article_number: "1", article_html: "<p>A1</p>" },
    { article_number: "45", article_html: "<p>A45</p>" },
  ],
  recitals: [],
  annexes: [],
};

const lawB = {
  celex: "32002L0058",
  articles: [{ article_number: "1", article_html: "<p>B1</p>" }],
  recitals: [],
  annexes: [],
};

describe("useLawSelection", () => {
  let container;
  let root;
  let latestValue;

  function Probe(props) {
    latestValue = useLawSelection(props);
    return null;
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latestValue = null;
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    container?.remove();
  });

  it("ignores a stale document from another law instead of rewriting the deep link", async () => {
    const navigateToCanonical = vi.fn();

    // URL points at law A article 45, but `data` still holds law B.
    await act(async () => {
      root.render(
        <Probe
          data={lawB}
          kind="article"
          id="45"
          celex="32016R0679"
          navigateToCanonical={navigateToCanonical}
        />
      );
    });

    expect(navigateToCanonical).not.toHaveBeenCalled();
    expect(latestValue.selected.kind).toBe("overview");
  });

  it("resolves the deep link once the matching document arrives", async () => {
    const navigateToCanonical = vi.fn();

    await act(async () => {
      root.render(
        <Probe
          data={lawB}
          kind="article"
          id="45"
          celex="32016R0679"
          navigateToCanonical={navigateToCanonical}
        />
      );
    });
    await act(async () => {
      root.render(
        <Probe
          data={lawA}
          kind="article"
          id="45"
          celex="32016R0679"
          navigateToCanonical={navigateToCanonical}
        />
      );
    });

    expect(latestValue.selected).toEqual({ kind: "article", id: "45", html: "<p>A45</p>" });
    // Already canonical — no rewrite needed.
    expect(navigateToCanonical).not.toHaveBeenCalled();
  });

  it("still canonicalizes the URL when the matching document lacks the target", async () => {
    const navigateToCanonical = vi.fn();

    await act(async () => {
      root.render(
        <Probe
          data={lawA}
          kind="article"
          id="999"
          celex="32016R0679"
          navigateToCanonical={navigateToCanonical}
        />
      );
    });

    expect(navigateToCanonical).toHaveBeenCalledWith("article", "1", { replace: true });
    expect(latestValue.selected).toEqual({ kind: "article", id: "1", html: "<p>A1</p>" });
  });

  it("resolves without a celex guard when none is provided", async () => {
    const navigateToCanonical = vi.fn();

    await act(async () => {
      root.render(
        <Probe
          data={lawA}
          kind="article"
          id="45"
          celex={null}
          navigateToCanonical={navigateToCanonical}
        />
      );
    });

    expect(latestValue.selected).toEqual({ kind: "article", id: "45", html: "<p>A45</p>" });
    expect(navigateToCanonical).not.toHaveBeenCalled();
  });
});
