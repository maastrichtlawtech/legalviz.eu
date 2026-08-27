import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useLawViewerSource } from "./useLawViewerSource.js";

const {
  mockDoesCelexMatchOfficialReference,
  mockFindCachedCelexByOfficialReference,
  mockMarkLawOpened,
  mockSaveLawMeta,
  mockBuildImportedLawCandidate,
  mockFindBundledLawBySlug,
  mockGetCanonicalLawRoute,
  mockParseOfficialReferenceSlug,
  mockGetLoadErrorDetails,
  mockResolveEurlexUrl,
  mockResolveOfficialReference,
} = vi.hoisted(() => ({
  mockDoesCelexMatchOfficialReference: vi.fn(),
  mockFindCachedCelexByOfficialReference: vi.fn(),
  mockMarkLawOpened: vi.fn(),
  mockSaveLawMeta: vi.fn(),
  mockBuildImportedLawCandidate: vi.fn(),
  mockFindBundledLawBySlug: vi.fn(),
  mockGetCanonicalLawRoute: vi.fn(),
  mockParseOfficialReferenceSlug: vi.fn(),
  mockGetLoadErrorDetails: vi.fn(),
  mockResolveEurlexUrl: vi.fn(),
  mockResolveOfficialReference: vi.fn(),
}));

vi.mock("../../utils/library.js", () => ({
  doesCelexMatchOfficialReference: mockDoesCelexMatchOfficialReference,
  findCachedCelexByOfficialReference: mockFindCachedCelexByOfficialReference,
  markLawOpened: mockMarkLawOpened,
  saveLawMeta: mockSaveLawMeta,
}));

vi.mock("../../utils/lawRouting.js", () => ({
  buildImportedLawCandidate: mockBuildImportedLawCandidate,
  findBundledLawBySlug: mockFindBundledLawBySlug,
  getCanonicalLawRoute: mockGetCanonicalLawRoute,
  parseOfficialReferenceSlug: mockParseOfficialReferenceSlug,
}));

vi.mock("../../utils/law-viewer/errors.js", () => ({
  getLoadErrorDetails: mockGetLoadErrorDetails,
}));

vi.mock("../../utils/formexApi.js", () => ({
  resolveEurlexUrl: mockResolveEurlexUrl,
  resolveOfficialReference: mockResolveOfficialReference,
}));

async function flushEffects() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("useLawViewerSource", () => {
  let container;
  let root;
  let latestValue;

  function Probe(props) {
    latestValue = useLawViewerSource(props);
    return null;
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latestValue = null;

    mockFindCachedCelexByOfficialReference.mockReset().mockResolvedValue(null);
    mockDoesCelexMatchOfficialReference.mockReset().mockReturnValue(true);
    mockMarkLawOpened.mockReset();
    mockSaveLawMeta.mockReset().mockResolvedValue(null);
    mockBuildImportedLawCandidate.mockReset().mockImplementation(({ officialReference, slug, celex }) => ({
      officialReference,
      slug: slug || `law-${celex || "stub"}`,
      celex: celex || null,
      label: "Stub law",
    }));
    mockFindBundledLawBySlug.mockReset().mockReturnValue(null);
    mockGetCanonicalLawRoute.mockReset().mockReturnValue("/directive-2002-58");
    mockParseOfficialReferenceSlug.mockReset().mockReturnValue({
      actType: "directive",
      year: "2002",
      number: "58",
    });
    mockGetLoadErrorDetails.mockReset().mockReturnValue({
      title: "Load failed",
      message: "Try again",
      tone: "error",
    });
    mockResolveEurlexUrl.mockReset();
    mockResolveOfficialReference.mockReset();
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    container?.remove();
  });

  it("reruns slug-reference resolution when retryLoad is called after a failure", async () => {
    mockResolveOfficialReference
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({
        resolved: { celex: "32002L0058" },
        fallback: null,
      });

    const props = {
      slug: "directive-2002-58",
      key: undefined,
      kind: null,
      id: null,
      importCelex: null,
      sourceUrl: null,
      locale: "en",
      routeLocale: "en",
      pathname: "/directive-2002-58",
      locationSearch: "",
      navigate: vi.fn(),
      formexLang: "EN",
      t: (key) => key,
      localizePath: (value) => value,
    };

    await act(async () => {
      root.render(<Probe {...props} />);
      await flushEffects();
    });

    expect(mockResolveOfficialReference).toHaveBeenCalledTimes(1);
    expect(latestValue.loadError).toEqual(expect.objectContaining({
      title: "Load failed",
      message: "Try again",
    }));

    await act(async () => {
      latestValue.retryLoad();
      await flushEffects();
    });

    expect(mockResolveOfficialReference).toHaveBeenCalledTimes(2);
    expect(latestValue.effectiveCelex).toBe("32002L0058");
    expect(latestValue.loadError).toBeNull();
    expect(mockSaveLawMeta).toHaveBeenCalledWith(expect.objectContaining({
      celex: "32002L0058",
    }));
    expect(mockMarkLawOpened).not.toHaveBeenCalled();
  });

  it("ignores a stale cached CELEX for a slug reference and falls back to backend resolution", async () => {
    mockFindCachedCelexByOfficialReference.mockResolvedValue("32013R0575");
    mockDoesCelexMatchOfficialReference.mockImplementation((celex) => celex === "32015L2366");
    mockResolveOfficialReference.mockResolvedValue({
      resolved: { celex: "32015L2366" },
      fallback: null,
    });

    const props = {
      slug: "directive-2015-2366",
      key: undefined,
      kind: null,
      id: null,
      importCelex: null,
      sourceUrl: null,
      locale: "en",
      routeLocale: "en",
      pathname: "/directive-2015-2366",
      locationSearch: "",
      navigate: vi.fn(),
      formexLang: "EN",
      t: (key) => key,
      localizePath: (value) => value,
    };

    mockParseOfficialReferenceSlug.mockReturnValue({
      actType: "directive",
      year: "2015",
      number: "2366",
    });
    mockGetCanonicalLawRoute.mockReturnValue("/directive-2015-2366");

    await act(async () => {
      root.render(<Probe {...props} />);
      await flushEffects();
    });

    expect(mockFindCachedCelexByOfficialReference).toHaveBeenCalled();
    expect(mockResolveOfficialReference).toHaveBeenCalledTimes(1);
    expect(latestValue.effectiveCelex).toBe("32015L2366");
    expect(mockSaveLawMeta).toHaveBeenCalledWith(expect.objectContaining({
      celex: "32015L2366",
    }));
  });

  it("navigateToCanonical carries an explicit search string instead of the current one", async () => {
    const navigate = vi.fn();
    mockGetCanonicalLawRoute.mockReturnValue("/regulation-2006-1367/article/1");

    const props = {
      slug: "regulation-2006-1367",
      key: undefined,
      kind: null,
      id: null,
      importCelex: "32006R1367",
      sourceUrl: null,
      locale: "en",
      routeLocale: "en",
      pathname: "/regulation-2006-1367",
      locationSearch: "?lang=EN",
      navigate,
      formexLang: "EN",
      t: (key) => key,
      localizePath: (value) => value,
    };

    await act(async () => {
      root.render(<Probe {...props} />);
      await flushEffects();
    });

    await act(async () => {
      latestValue.navigateToCanonical("article", "1", { search: "?lang=EN&version=current" });
    });

    expect(navigate).toHaveBeenCalledWith(
      "/regulation-2006-1367/article/1?lang=EN&version=current",
      {}
    );

    navigate.mockClear();
    await act(async () => {
      latestValue.navigateToCanonical("article", "2");
    });

    expect(navigate).toHaveBeenCalledWith("/regulation-2006-1367/article/1?lang=EN", {});
  });
});
