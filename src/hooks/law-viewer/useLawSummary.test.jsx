import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useLawSummary } from "./useLawSummary.js";

const { mockFetchLawSummary } = vi.hoisted(() => ({
  mockFetchLawSummary: vi.fn(),
}));

vi.mock("../../utils/formexApi.js", async () => {
  const actual = await vi.importActual("../../utils/formexApi.js");
  return {
    ...actual,
    fetchLawSummary: mockFetchLawSummary,
  };
});

async function flushEffects() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("useLawSummary", () => {
  let container;
  let root;
  let latestValue;

  function Probe(props) {
    latestValue = useLawSummary(props.celex, props.options);
    return null;
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latestValue = null;
    mockFetchLawSummary.mockReset();
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    container?.remove();
  });

  it("does not pass a language argument to fetchLawSummary", async () => {
    mockFetchLawSummary.mockResolvedValue({ summary: { purpose: "p" } });

    await act(async () => {
      root.render(<Probe celex="32016R0679" />);
    });
    await act(flushEffects);

    expect(mockFetchLawSummary).toHaveBeenCalledWith("32016R0679");
    expect(mockFetchLawSummary).not.toHaveBeenCalledWith("32016R0679", expect.anything());
  });

  it("loads the summary and metadata on success", async () => {
    mockFetchLawSummary.mockResolvedValue({
      summary: { purpose: "p" },
      model: "gpt",
      cached: true,
      generatedAt: "2026-01-01",
    });

    await act(async () => {
      root.render(<Probe celex="32016R0679" />);
    });
    await act(flushEffects);

    expect(latestValue.loading).toBe(false);
    expect(latestValue.loaded).toBe(true);
    expect(latestValue.error).toBeNull();
    expect(latestValue.summary).toEqual({ purpose: "p" });
    expect(latestValue.metadata).toEqual({ model: "gpt", cached: true, generatedAt: "2026-01-01" });
  });

  it("surfaces a fetch failure via the error field", async () => {
    const failure = new Error("boom");
    mockFetchLawSummary.mockRejectedValue(failure);

    await act(async () => {
      root.render(<Probe celex="32016R0679" />);
    });
    await act(flushEffects);

    expect(latestValue.loaded).toBe(true);
    expect(latestValue.error).toBe(failure);
    expect(latestValue.summary).toBeNull();
  });

  it("retry clears the error and re-fetches", async () => {
    const failure = new Error("boom");
    mockFetchLawSummary.mockRejectedValueOnce(failure);
    mockFetchLawSummary.mockResolvedValueOnce({ summary: { purpose: "p" } });

    await act(async () => {
      root.render(<Probe celex="32016R0679" />);
    });
    await act(flushEffects);
    expect(latestValue.error).toBe(failure);

    await act(async () => {
      latestValue.retry();
    });
    await act(flushEffects);

    expect(mockFetchLawSummary).toHaveBeenCalledTimes(2);
    expect(latestValue.error).toBeNull();
    expect(latestValue.summary).toEqual({ purpose: "p" });
  });

  it("resets state and re-fetches when the CELEX changes", async () => {
    mockFetchLawSummary.mockResolvedValueOnce({ summary: { purpose: "first" } });

    await act(async () => {
      root.render(<Probe celex="32016R0679" />);
    });
    await act(flushEffects);
    expect(latestValue.summary).toEqual({ purpose: "first" });

    mockFetchLawSummary.mockResolvedValueOnce({ summary: { purpose: "second" } });
    await act(async () => {
      root.render(<Probe celex="32016R0680" />);
    });
    await act(flushEffects);

    expect(mockFetchLawSummary).toHaveBeenLastCalledWith("32016R0680");
    expect(latestValue.summary).toEqual({ purpose: "second" });
  });
});
