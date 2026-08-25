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

  it("does not warn a law that only ever had corrigenda, but says the text is uncorrected", async () => {
    // The GDPR. Not amended, so no warning — but nine of its articles read
    // differently in the consolidated text, Article 37(1)(c)'s "and"/"or"
    // among them, so silence would leave the reader on uncorrected text with
    // no way to know.
    fetchAmendments.mockResolvedValue({
      amendments: [{ celex: "32016R0679R(01)", date: "2018-05-23", type: "corrigendum" }],
    });
    fetchConsolidatedVersions.mockResolvedValue({
      versions: [{ celex: "02016R0679-20160504", date: "2016-05-04" }],
    });

    await render({ celex: "32016R0679", onToggleVersion: vi.fn() });

    expect(container.textContent).toContain("You are reading the current text");
    expect(container.textContent).toContain("has not been amended");
    expect(container.textContent).toContain("One corrigendum has been published");
    expect(container.textContent).not.toContain("You are reading this law as adopted");
    const toggle = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent.includes("corrections applied")
    );
    expect(toggle).toBeTruthy();
  });

  it("says it is still checking while the corrected-version query is in flight", async () => {
    // The correction toggle hangs off /consolidated, which is seconds slower
    // than the amendment history. Without a placeholder the notice paints
    // complete and a button appears out of nowhere later.
    fetchAmendments.mockResolvedValue({
      amendments: [{ celex: "32016R0679R(01)", date: "2018-05-23", type: "corrigendum" }],
    });
    let resolveVersions;
    fetchConsolidatedVersions.mockReturnValue(
      new Promise((resolve) => { resolveVersions = resolve; })
    );

    await render({ celex: "32016R0679", onToggleVersion: vi.fn() });

    expect(container.textContent).toContain("Checking EUR-Lex for the current version");
    expect(container.textContent).not.toContain("corrections applied");

    await act(async () => {
      resolveVersions({ versions: [{ celex: "02016R0679-20160504", date: "2016-05-04" }] });
    });

    expect(container.textContent).not.toContain("Checking EUR-Lex for the current version");
    expect(container.textContent).toContain("corrections applied");
  });

  it("says it is still checking while the consolidated-version query is in flight", async () => {
    fetchAmendments.mockResolvedValue({
      amendments: [{ celex: "32020R0001", date: "2020-01-01", type: "amendment" }],
    });
    let resolveVersions;
    fetchConsolidatedVersions.mockReturnValue(
      new Promise((resolve) => { resolveVersions = resolve; })
    );

    await render({ onToggleVersion: vi.fn() });

    expect(container.textContent).toContain("Checking EUR-Lex for the current version");

    await act(async () => {
      resolveVersions({ versions: [{ celex: "02013R0575-20200101", date: "2020-01-01" }] });
    });

    expect(container.textContent).not.toContain("Checking EUR-Lex for the current version");
    expect(container.textContent).toContain("Read this law as amended");
  });

  it("stays quiet above every article for a law that was never amended", async () => {
    // The positive line belongs on the overview. Repeated above each article
    // it is noise, and the inline variant exists to warn.
    fetchAmendments.mockResolvedValue({ amendments: [] });
    fetchConsolidatedVersions.mockResolvedValue({ versions: [] });

    await render({ variant: "inline" });

    expect(container.textContent).toBe("");
  });

  it("says a never-amended law is current, with no correction offer", async () => {
    fetchAmendments.mockResolvedValue({ amendments: [] });
    fetchConsolidatedVersions.mockResolvedValue({ versions: [] });

    await render({ onToggleVersion: vi.fn() });

    expect(container.textContent).toContain("You are reading the current text");
    expect(container.textContent).toContain("has not been amended");
    expect(container.textContent).not.toContain("corrigend");
    expect(container.querySelector("button")).toBe(null);
  });

  it("renders the compact current state without a corrigendum action", async () => {
    fetchAmendments.mockResolvedValue({ amendments: [] });
    fetchConsolidatedVersions.mockResolvedValue({ versions: [] });

    await render({ variant: "compact", onToggleVersion: vi.fn() });

    expect(container.textContent).toContain("Current text");
    expect(container.textContent).toContain("Not amended");
    expect(container.textContent).not.toContain("corrigendum");
    expect(container.querySelector("button")).toBe(null);
    expect(container.querySelector(".rounded-xl")).toBe(null);
  });

  it.each([
    [1, "1 corrigendum"],
    [2, "2 corrigenda"],
  ])("renders the compact corrigendum count (%s)", async (count, label) => {
    fetchAmendments.mockResolvedValue({
      amendments: Array.from({ length: count }, (_, index) => ({
        celex: `32016R0679R(0${index + 1})`,
        date: "2018-05-23",
        type: "corrigendum",
      })),
    });
    fetchConsolidatedVersions.mockResolvedValue({
      versions: [{ celex: "02016R0679-20160504", date: "2016-05-04" }],
    });

    await render({ variant: "compact", onToggleVersion: vi.fn() });

    expect(container.textContent).toContain("Current text");
    expect(container.textContent).toContain("Not amended");
    expect(container.textContent).toContain(label);
  });

  it("keeps the compact correction action pending while EUR-Lex is checked", async () => {
    fetchAmendments.mockResolvedValue({
      amendments: [{ celex: "32016R0679R(01)", date: "2018-05-23", type: "corrigendum" }],
    });
    fetchConsolidatedVersions.mockReturnValue(new Promise(() => {}));

    await render({ variant: "compact", onToggleVersion: vi.fn() });

    expect(container.textContent).toContain("Current text");
    expect(container.textContent).toContain("Not amended");
    expect(container.textContent).toContain("Checking EUR-Lex for the current version");
    expect(container.textContent).not.toContain("corrections applied");
  });

  it("toggles the compact correction action when a current version exists", async () => {
    fetchAmendments.mockResolvedValue({
      amendments: [{ celex: "32016R0679R(01)", date: "2018-05-23", type: "corrigendum" }],
    });
    fetchConsolidatedVersions.mockResolvedValue({
      versions: [{ celex: "02016R0679-20160504", date: "2016-05-04" }],
    });
    const onToggleVersion = vi.fn();

    await render({ variant: "compact", onToggleVersion });

    const toggle = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent.includes("corrections applied")
    );
    expect(toggle).toBeTruthy();

    await act(async () => { toggle.click(); });
    expect(onToggleVersion).toHaveBeenCalledWith("current");
  });

  it("keeps an amended law as the existing full warning in compact mode", async () => {
    fetchAmendments.mockResolvedValue({
      amendments: [{ celex: "32020R0001", date: "2020-01-01", type: "amendment" }],
    });
    fetchConsolidatedVersions.mockResolvedValue({
      versions: [{ celex: "02020R0001-20200101", date: "2020-01-01" }],
    });

    await render({ variant: "compact", onToggleVersion: vi.fn() });

    expect(container.textContent).toContain("You are reading this law as adopted");
    expect(container.textContent).toContain("Read this law as amended");
    expect(container.textContent).not.toContain("Current text");
    expect(container.querySelector(".rounded-xl")).toBeTruthy();
  });

  it("claims nothing about a never-amended law when the history could not be fetched", async () => {
    // `[]` on failure keeps the warning off, but it must not be read as
    // evidence for the opposite claim.
    fetchAmendments.mockRejectedValue(new Error("cellar down"));
    fetchConsolidatedVersions.mockResolvedValue({ versions: [] });

    await render();

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

  it("does not claim no consolidated version exists while the query is still in flight", async () => {
    // The amendment history resolves first (it is the faster of the two
    // queries), so without a pending state the notice renders its summary
    // beside "EUR-Lex has not published a consolidated version" — a claim it
    // has no basis for yet, and one that is wrong for most amended acts. It
    // then flips to a toggle a moment later.
    fetchAmendments.mockResolvedValue({
      amendments: [{ celex: "32020R0001", date: "2020-01-01", type: "amendment" }],
    });
    let resolveVersions;
    fetchConsolidatedVersions.mockReturnValue(
      new Promise((resolve) => { resolveVersions = resolve; })
    );

    await render({ onToggleVersion: vi.fn() });

    expect(container.textContent).toContain("amended once");
    expect(container.textContent).not.toContain("has not published a consolidated version");

    await act(async () => {
      resolveVersions({ versions: [{ celex: "02013R0575-20200101", date: "2020-01-01" }] });
    });

    expect(container.textContent).not.toContain("has not published a consolidated version");
    expect(container.textContent).toContain("Read this law as amended");
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

  it("renders nothing when source is fmx-consolidated, even for a heavily amended act", async () => {
    fetchAmendments.mockResolvedValue({
      amendments: [
        { celex: "32019R0876", date: "2019-05-20", type: "amendment" },
        { celex: "32024R1623", date: "2024-05-31", type: "amendment" },
      ],
    });
    fetchConsolidatedVersions.mockResolvedValue({
      versions: [{ celex: "02013R0575-20260626", date: "2026-06-26" }],
    });

    await render({ source: "fmx-consolidated" });

    expect(container.textContent).toBe("");
    expect(fetchAmendments).not.toHaveBeenCalled();
  });

  it("offers a toggle to read the consolidated text when a current version exists", async () => {
    fetchAmendments.mockResolvedValue({
      amendments: [{ celex: "32019R0876", date: "2019-05-20", type: "amendment" }],
    });
    fetchConsolidatedVersions.mockResolvedValue({
      versions: [{ celex: "02013R0575-20260626", date: "2026-06-26" }],
    });
    const onToggleVersion = vi.fn();

    await render({ onToggleVersion });

    const toggle = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent.includes("Read this law as amended")
    );
    expect(toggle).toBeTruthy();

    await act(async () => { toggle.click(); });
    expect(onToggleVersion).toHaveBeenCalledWith("current");
  });

  it("renders no toggle when no current consolidated version exists", async () => {
    fetchAmendments.mockResolvedValue({
      amendments: [{ celex: "32020R0001", date: "2020-01-01", type: "amendment" }],
    });
    fetchConsolidatedVersions.mockResolvedValue({ versions: [] });

    await render({ onToggleVersion: vi.fn() });

    expect(container.querySelector("button")).toBe(null);
  });

  it("shows the reverse state and an honest date once the reader is reading the requested version", async () => {
    const onToggleVersion = vi.fn();

    await render({
      source: "fmx-consolidated",
      version: "current",
      versionDate: "2026-06-26",
      onToggleVersion,
    });

    expect(container.textContent).toContain("You are reading this law as amended, as of");
    expect(fetchAmendments).not.toHaveBeenCalled();

    const back = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent.includes("Back to the text as adopted")
    );
    expect(back).toBeTruthy();

    await act(async () => { back.click(); });
    expect(onToggleVersion).toHaveBeenCalledWith(null);
  });

  it("says so honestly when the requested version could not be served", async () => {
    await render({
      source: "fmx-eurlex",
      version: "current",
      versionUnavailable: true,
      onToggleVersion: vi.fn(),
    });

    expect(container.textContent).toContain("could not be loaded right now");
    expect(container.textContent).not.toContain("You are reading this law as amended");
    expect(fetchAmendments).not.toHaveBeenCalled();
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
