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

const { VersionMenu } = await import("./VersionMenu.jsx");
const { AmendmentStatusMeta } = await import("./law-viewer/AmendmentStatusMeta.jsx");
const { I18nProvider } = await import("../i18n/I18nProvider.jsx");

let container;
let root;

async function renderComponent(component, props) {
  await act(async () => {
    root = createRoot(container);
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(I18nProvider, null, createElement(component, props))
      )
    );
  });
}

const render = (props = {}) => renderComponent(VersionMenu, {
  celex: "32013R0575",
  onSelectVersion: vi.fn(),
  ...props,
});

async function openMenu() {
  const chip = container.querySelector("button[aria-haspopup=menu]");
  await act(async () => { chip.click(); });
}

const option = (label) => Array.from(container.querySelectorAll("[role=menuitemradio]"))
  .find((item) => item.textContent.includes(label));

function mockAmended() {
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

describe("VersionMenu", () => {
  it("shows the as-adopted chip for an amended law and offers the consolidated text", async () => {
    mockAmended();
    const onSelectVersion = vi.fn();

    await render({ onSelectVersion });

    const chip = container.querySelector("button[aria-haspopup=menu]");
    expect(chip.getAttribute("aria-label")).toBe("Text version: As adopted");
    expect(container.querySelector("[role=menu]")).toBe(null);

    await openMenu();

    expect(option("As adopted").getAttribute("aria-checked")).toBe("true");
    expect(option("As adopted").textContent).toContain("Amended 2 times, most recently on");
    const amended = option("As amended");
    expect(amended.getAttribute("aria-checked")).toBe("false");
    expect(amended.disabled).toBe(false);
    expect(amended.textContent).toContain("Consolidated text of");

    const link = container.querySelector("[role=menu] a");
    expect(link.getAttribute("href")).toBe(
      "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02013R0575-20260626"
    );
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");

    await act(async () => { amended.click(); });
    expect(onSelectVersion).toHaveBeenCalledWith("current");
    expect(container.querySelector("[role=menu]")).toBe(null);
  });

  it("does not re-select the version already being read", async () => {
    mockAmended();
    const onSelectVersion = vi.fn();

    await render({ onSelectVersion });
    await openMenu();
    await act(async () => { option("As adopted").click(); });

    expect(onSelectVersion).not.toHaveBeenCalled();
  });

  it("renders nothing for a law that was never amended or corrected", async () => {
    fetchAmendments.mockResolvedValue({ amendments: [] });
    fetchConsolidatedVersions.mockResolvedValue({ versions: [] });

    await render();

    expect(container.textContent).toBe("");
  });

  it("renders nothing while, or when, the amendment history cannot be fetched", async () => {
    fetchAmendments.mockRejectedValue(new Error("cellar down"));
    fetchConsolidatedVersions.mockResolvedValue({ versions: [] });

    await render();

    expect(container.textContent).toBe("");
  });

  it("offers the corrected text for a corrigendum-only act", async () => {
    // The GDPR. Not amended, but nine of its articles read differently in the
    // consolidated text, Article 37(1)(c)'s "and"/"or" among them.
    fetchAmendments.mockResolvedValue({
      amendments: [{ celex: "32016R0679R(01)", date: "2018-05-23", type: "corrigendum" }],
    });
    fetchConsolidatedVersions.mockResolvedValue({
      versions: [{ celex: "02016R0679-20160504", date: "2016-05-04" }],
    });
    const onSelectVersion = vi.fn();

    await render({ celex: "32016R0679", onSelectVersion });
    await openMenu();

    expect(option("As published").textContent).toContain("Without the corrigendum published since");
    await act(async () => { option("With corrections").click(); });
    expect(onSelectVersion).toHaveBeenCalledWith("current");
  });

  it("says it is still checking while the consolidated-version query is in flight", async () => {
    fetchAmendments.mockResolvedValue({
      amendments: [{ celex: "32020R0001", date: "2020-01-01", type: "amendment" }],
    });
    let resolveVersions;
    fetchConsolidatedVersions.mockReturnValue(
      new Promise((resolve) => { resolveVersions = resolve; })
    );

    await render();
    await openMenu();

    expect(option("As amended").disabled).toBe(true);
    expect(option("As amended").textContent).toContain("Checking EUR-Lex for the current version");

    await act(async () => {
      resolveVersions({ versions: [{ celex: "02013R0575-20200101", date: "2020-01-01" }] });
    });

    expect(option("As amended").disabled).toBe(false);
    expect(container.textContent).not.toContain("Checking EUR-Lex");
  });

  it("disables the amended text when EUR-Lex has not published a consolidated version", async () => {
    fetchAmendments.mockResolvedValue({
      amendments: [{ celex: "32020R0001", date: "2020-01-01", type: "amendment" }],
    });
    fetchConsolidatedVersions.mockResolvedValue({ versions: [] });

    await render();
    await openMenu();

    expect(option("As amended").disabled).toBe(true);
    expect(option("As amended").textContent).toContain("has not published a consolidated version");
    expect(container.querySelector("[role=menu] a")).toBe(null);
  });

  it("does not claim no consolidated version exists when the /consolidated fetch fails", async () => {
    fetchAmendments.mockResolvedValue({
      amendments: [{ celex: "32020R0001", date: "2020-01-01", type: "amendment" }],
    });
    fetchConsolidatedVersions.mockRejectedValue(new Error("cellar timeout"));

    await render();
    await openMenu();

    expect(option("As amended").disabled).toBe(true);
    expect(container.textContent).not.toContain("has not published a consolidated version");
    expect(container.textContent).toContain("EUR-Lex could not be reached");
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
    await openMenu();

    expect(option("As amended").textContent).toContain("has been prepared but is not yet in force");
    vi.useRealTimers();
  });

  it("renders nothing for the forced consolidated fallback", async () => {
    mockAmended();

    await render({ source: "fmx-consolidated" });

    expect(container.textContent).toBe("");
    expect(fetchAmendments).not.toHaveBeenCalled();
  });

  it("shows the amended chip once the reader is reading the requested version", async () => {
    mockAmended();
    const onSelectVersion = vi.fn();

    await render({
      source: "fmx-consolidated",
      version: "current",
      versionDate: "2026-06-26",
      onSelectVersion,
    });

    const chip = container.querySelector("button[aria-haspopup=menu]");
    expect(chip.getAttribute("aria-label")).toBe("Text version: As amended");

    await openMenu();
    expect(option("As amended").getAttribute("aria-checked")).toBe("true");

    await act(async () => { option("As adopted").click(); });
    expect(onSelectVersion).toHaveBeenCalledWith(null);
  });

  it("says so honestly when the requested version could not be served, and lets the reader retry", async () => {
    mockAmended();
    const onSelectVersion = vi.fn();

    await render({
      source: "fmx-eurlex",
      version: "current",
      versionUnavailable: true,
      onSelectVersion,
    });

    const chip = container.querySelector("button[aria-haspopup=menu]");
    expect(chip.getAttribute("aria-label")).toBe("Text version: As adopted");

    await openMenu();
    expect(container.textContent).toContain("could not be loaded right now");
    expect(option("As adopted").getAttribute("aria-checked")).toBe("true");

    await act(async () => { option("As amended").click(); });
    expect(onSelectVersion).toHaveBeenCalledWith("current");
  });

  it("says 'at least N times' when the amendment count was truncated", async () => {
    mockAmended();
    fetchAmendments.mockResolvedValue({
      amendments: [
        { celex: "32019R0876", date: "2019-05-20", type: "amendment" },
        { celex: "32024R1623", date: "2024-05-31", type: "amendment" },
      ],
      truncated: true,
    });

    await render();
    await openMenu();

    expect(option("As adopted").textContent).toContain("Amended at least 2 times");
  });
});

describe("AmendmentStatusMeta", () => {
  const renderMeta = (props = {}) => renderComponent(AmendmentStatusMeta, { celex: "32013R0575", ...props });

  it("states the amendment history as plain metadata", async () => {
    fetchAmendments.mockResolvedValue({
      amendments: [{ celex: "32020R0001", date: "2020-01-01", type: "amendment" }],
    });
    fetchConsolidatedVersions.mockResolvedValue({ versions: [] });

    await renderMeta();

    expect(container.textContent).toContain("Amended once, on");
    expect(container.querySelector("button")).toBe(null);
  });

  it("says a never-amended law is not amended", async () => {
    fetchAmendments.mockResolvedValue({ amendments: [] });
    fetchConsolidatedVersions.mockResolvedValue({ versions: [] });

    await renderMeta();

    expect(container.textContent).toBe("Not amended");
  });

  it.each([
    [1, "Not amended · 1 corrigendum"],
    [2, "Not amended · 2 corrigenda"],
  ])("counts corrigenda (%s)", async (count, label) => {
    fetchAmendments.mockResolvedValue({
      amendments: Array.from({ length: count }, (_, index) => ({
        celex: `32016R0679R(0${index + 1})`,
        date: "2018-05-23",
        type: "corrigendum",
      })),
    });
    fetchConsolidatedVersions.mockResolvedValue({ versions: [] });

    await renderMeta({ celex: "32016R0679" });

    expect(container.textContent).toBe(label);
  });

  it("claims nothing when the history could not be fetched", async () => {
    fetchAmendments.mockRejectedValue(new Error("cellar down"));
    fetchConsolidatedVersions.mockResolvedValue({ versions: [] });

    await renderMeta();

    expect(container.textContent).toBe("");
  });
});
