import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

const fetchAmendments = vi.fn();
const fetchConsolidatedVersions = vi.fn();

vi.mock("../utils/formexApi.js", () => ({
  fetchAmendments: (...args) => fetchAmendments(...args),
  fetchConsolidatedVersions: (...args) => fetchConsolidatedVersions(...args),
}));

const { ConsolidationNotice } = await import("./ConsolidationNotice.jsx");
const { I18nProvider } = await import("../i18n/I18nProvider.jsx");

let container;
let root;

async function render(props = {}) {
  await act(async () => {
    root = createRoot(container);
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(
          I18nProvider,
          null,
          createElement(ConsolidationNotice, { celex: "32013R0575", ...props })
        )
      )
    );
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  fetchAmendments.mockReset();
  fetchConsolidatedVersions.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("ConsolidationNotice", () => {
  it("warns that the text is as adopted and links the consolidated version", async () => {
    fetchAmendments.mockResolvedValue({
      amendments: [
        { celex: "32019R0876", date: "2019-05-20", type: "amendment" },
        { celex: "32024R1623", date: "2024-05-31", type: "amendment" },
      ],
    });
    fetchConsolidatedVersions.mockResolvedValue({
      versions: [
        { celex: "02013R0575-20130628", date: "2013-06-28" },
        { celex: "02013R0575-20260626", date: "2026-06-26" },
      ],
    });

    await render();

    expect(container.textContent).toContain("You are reading this law as adopted.");
    expect(container.textContent).toContain("amended 2 times");
    const link = container.querySelector("a");
    expect(link.getAttribute("href")).toBe(
      "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02013R0575-20260626"
    );
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("renders nothing for a law that only ever had corrigenda", async () => {
    fetchAmendments.mockResolvedValue({
      amendments: [{ celex: "32016R0679R(01)", date: "2018-05-23", type: "corrigendum" }],
    });
    fetchConsolidatedVersions.mockResolvedValue({
      versions: [{ celex: "02016R0679-20160504", date: "2016-05-04" }],
    });

    await render({ celex: "32016R0679" });

    expect(container.textContent).toBe("");
  });

  it("says so when the act is amended but has no consolidated version", async () => {
    fetchAmendments.mockResolvedValue({
      amendments: [{ celex: "32020R0001", date: "2020-01-01", type: "amendment" }],
    });
    fetchConsolidatedVersions.mockResolvedValue({ versions: [] });

    await render();

    expect(container.textContent).toContain("amended once");
    expect(container.textContent).toContain("has not published a consolidated version");
    expect(container.querySelector("a")).toBe(null);
  });

  it("stays silent when the amendment history cannot be fetched", async () => {
    fetchAmendments.mockRejectedValue(new Error("cellar down"));
    fetchConsolidatedVersions.mockRejectedValue(new Error("cellar down"));

    await render();

    expect(container.textContent).toBe("");
  });

  it("says a consolidated version is pending when only future-dated ones exist", async () => {
    vi.setSystemTime(new Date("2026-08-12T00:00:00Z"));
    fetchAmendments.mockResolvedValue({
      amendments: [{ celex: "32026R0001", date: "2026-01-01", type: "amendment" }],
    });
    fetchConsolidatedVersions.mockResolvedValue({
      versions: [{ celex: "02013R0575-20270101", date: "2027-01-01" }],
    });

    await render();

    expect(container.textContent).toContain("has been prepared but is not yet in force");
    expect(container.textContent).not.toContain("has not published a consolidated version");
    vi.useRealTimers();
  });

  it("does not claim no consolidated version exists when the /consolidated fetch fails", async () => {
    fetchAmendments.mockResolvedValue({
      amendments: [{ celex: "32020R0001", date: "2020-01-01", type: "amendment" }],
    });
    fetchConsolidatedVersions.mockRejectedValue(new Error("cellar timeout"));

    await render();

    expect(container.textContent).toContain("amended once");
    expect(container.textContent).not.toContain("has not published a consolidated version");
    expect(container.querySelector("a")).toBe(null);
  });

  it("says 'at least N times' when the amendment count was truncated", async () => {
    fetchAmendments.mockResolvedValue({
      amendments: [
        { celex: "32019R0876", date: "2019-05-20", type: "amendment" },
        { celex: "32024R1623", date: "2024-05-31", type: "amendment" },
      ],
      truncated: true,
    });
    fetchConsolidatedVersions.mockResolvedValue({
      versions: [{ celex: "02013R0575-20260626", date: "2026-06-26" }],
    });

    await render();

    expect(container.textContent).toContain("amended at least 2 times");
  });
});
