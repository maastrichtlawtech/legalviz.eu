import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LawSummary } from "./LawSummary.jsx";

const { mockUseLawSummary } = vi.hoisted(() => ({
  mockUseLawSummary: vi.fn(),
}));

vi.mock("../hooks/law-viewer/useLawSummary.js", () => ({
  useLawSummary: mockUseLawSummary,
}));

vi.mock("../i18n/useI18n.js", () => ({
  useI18n: () => ({ t: (key) => key }),
}));

describe("LawSummary", () => {
  let container;
  let root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockUseLawSummary.mockReturnValue({
      summary: null,
      metadata: null,
      loading: false,
      loaded: true,
      error: null,
      retry: vi.fn(),
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container?.remove();
    mockUseLawSummary.mockReset();
  });

  it("shows no English-only badge when reading in English", async () => {
    await act(async () => {
      root.render(<LawSummary celex="32016R0679" lang="EN" />);
    });

    expect(container.textContent).not.toContain("English only");
  });

  it("shows no English-only badge when lang is not provided (defaults to English)", async () => {
    await act(async () => {
      root.render(<LawSummary celex="32016R0679" />);
    });

    expect(container.textContent).not.toContain("English only");
  });

  it("shows an English-only badge when reading in another language", async () => {
    await act(async () => {
      root.render(<LawSummary celex="32016R0679" lang="DE" />);
    });

    expect(container.textContent).toContain("English only");
  });

  it("treats lang case-insensitively", async () => {
    await act(async () => {
      root.render(<LawSummary celex="32016R0679" lang="en" />);
    });

    expect(container.textContent).not.toContain("English only");
  });

  it("calls useLawSummary without a language argument", async () => {
    await act(async () => {
      root.render(<LawSummary celex="32016R0679" lang="DE" />);
    });

    expect(mockUseLawSummary).toHaveBeenCalledWith("32016R0679");
  });

  it("renders nothing when celex is missing", async () => {
    await act(async () => {
      root.render(<LawSummary celex={null} lang="DE" />);
    });

    expect(container.innerHTML).toBe("");
  });
});
