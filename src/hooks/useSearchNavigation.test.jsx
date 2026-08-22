import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockNavigate, mockSaveLawMeta } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockSaveLawMeta: vi.fn(() => Promise.resolve()),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
  useLocation: () => ({ search: "?celex=32016R0679&definition=old" }),
}));

vi.mock("../i18n/useI18n.js", () => ({
  useI18n: () => ({ locale: "en", localizePath: (path) => path }),
}));

vi.mock("../utils/library.js", async () => {
  const actual = await vi.importActual("../utils/library.js");
  return {
    ...actual,
    saveLawMeta: mockSaveLawMeta,
  };
});

import { useSearchNavigation } from "./useSearchNavigation.js";

describe("useSearchNavigation", () => {
  let container;
  let root;
  let navigateToSearchResult;

  function Probe({ lawKey }) {
    navigateToSearchResult = useSearchNavigation(lawKey);
    return null;
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    navigateToSearchResult = null;
    mockNavigate.mockClear();
    mockSaveLawMeta.mockClear();
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    container?.remove();
  });

  it("routes a definition result through its representativeSource celex", async () => {
    await act(async () => {
      root.render(<Probe lawKey="gdpr" />);
    });
    await act(async () => {
      await navigateToSearchResult({
        search_kind: "definition",
        normalizedTerm: "personal data",
        representativeSource: {
          celex: "32016R0679",
          article: "5",
          title: "GDPR",
          sourcePoint: "2",
        },
      });
    });

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    const url = mockNavigate.mock.calls[0][0];
    expect(url).toBe("/gdpr/article/5?definition=personal+data&definitionSource=32016R0679%3A5%3A2");
  });

  it("routes a law result via its canonical route", async () => {
    await act(async () => {
      root.render(<Probe lawKey="gdpr" />);
    });
    await act(async () => {
      await navigateToSearchResult({
        search_kind: "law",
        celex: "32016R0679",
        title: "General Data Protection Regulation",
      });
    });

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith("/gdpr");
    expect(mockSaveLawMeta).toHaveBeenCalledWith({
      celex: "32016R0679",
      label: "General Data Protection Regulation",
      officialReference: { actType: "regulation", year: "2016", number: "679" },
    });
  });

  it("persists EuroVoc topics when a law result carries them", async () => {
    await act(async () => {
      root.render(<Probe lawKey="gdpr" />);
    });
    await act(async () => {
      await navigateToSearchResult({
        search_kind: "law",
        celex: "32016R0679",
        title: "General Data Protection Regulation",
        topics: ["Data protection", "Privacy"],
      });
    });

    expect(mockSaveLawMeta).toHaveBeenCalledWith(
      expect.objectContaining({ topics: ["Data protection", "Privacy"] }),
    );
  });

  it("does not navigate a match result when neither the item nor the current law resolves a slug", async () => {
    await act(async () => {
      root.render(<Probe lawKey={null} />);
    });
    await act(async () => {
      await navigateToSearchResult({
        search_kind: "match",
        id: "7",
        type: "recital",
        title: "A recital",
      });
    });

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("navigates a match result to a clean route without stale query params", async () => {
    await act(async () => {
      root.render(<Probe lawKey="gdpr" />);
    });
    await act(async () => {
      await navigateToSearchResult({
        search_kind: "match",
        id: "12",
        type: "article",
        title: "Some article",
        law_slug: "dma",
      });
    });

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith("/dma/article/12");
    expect(String(mockNavigate.mock.calls[0][0])).not.toContain("?");
  });

  it("falls back to the current law slug for a match result without a law_slug", async () => {
    await act(async () => {
      root.render(<Probe lawKey="gdpr" />);
    });
    await act(async () => {
      await navigateToSearchResult({
        search_kind: "match",
        id: "7",
        type: "recital",
        title: "A recital",
      });
    });

    expect(mockNavigate).toHaveBeenCalledWith("/gdpr/recital/7");
  });

  it("early-returns when a definition item lacks source.celex", async () => {
    await act(async () => {
      root.render(<Probe lawKey="gdpr" />);
    });
    await act(async () => {
      await navigateToSearchResult({
        search_kind: "definition",
        normalizedTerm: "data",
        representativeSource: { article: "5" },
      });
    });

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("does not navigate when a fulltext item has no resolvable unit", async () => {
    await act(async () => {
      root.render(<Probe lawKey="gdpr" />);
    });
    await act(async () => {
      await navigateToSearchResult({
        search_kind: "fulltext",
        celex: "32016R0679",
        number: "",
        unitType: "article",
      });
    });

    expect(mockNavigate).not.toHaveBeenCalled();
  });
});