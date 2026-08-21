import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";

// Override only the network call; keep the rest of the module real so the
// import graph (library.js, lawRouting.js, …) stays intact.
const searchLaws = vi.fn();
vi.mock("../utils/formexApi.js", async (importActual) => {
  const actual = await importActual();
  return { ...actual, searchLaws: (...args) => searchLaws(...args) };
});

const { SearchBox } = await import("./TopBar.jsx");
const { I18nProvider } = await import("../i18n/I18nProvider.jsx");

let container;
let root;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.clearAllTimers();
  vi.useRealTimers();
  searchLaws.mockReset();
});

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
}

function renderSearchBox() {
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(
          I18nProvider,
          null,
          createElement(SearchBox, {
            lists: { articles: [], recitals: [], annexes: [] },
            onNavigate: vi.fn(),
            onSearchOpen: () => Promise.resolve({ articles: [], recitals: [], annexes: [] }),
            triggerVariant: "hero",
          })
        )
      )
    );
  });
}

function typeQuery(value) {
  const input = container.querySelector("input");
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function resultButtons() {
  // The modal renders into a portal on document.body.
  return Array.from(document.body.querySelectorAll('[role="dialog"] button'));
}

function rowFor(text) {
  return resultButtons().find((b) => b.textContent.includes(text));
}

describe("SearchBox — in-force badge", () => {
  it("badges an act that is in force", async () => {
    searchLaws.mockResolvedValue({
      results: [{ celex: "32016R0679", title: "GDPR", date: "2016-04-27", inForce: true, endOfValidity: null }],
    });
    renderSearchBox();

    typeQuery("gdpr");
    await flush();

    const row = rowFor("2016/679");
    expect(row).toBeTruthy();
    expect(row.textContent).toContain("In force");
    expect(row.textContent).not.toContain("Not in force");
  });

  // The reason entryIntoForce is fetched at all. Acts are harvested when
  // published, normally before they enter into force, so a brand-new regulation
  // carries `inForce: false` — the same flag as an act that expired in 1994.
  // Regulation 2026/1818 really is Cellar's answer here: in-force 0, entry
  // 2026-08-30. It used to be labelled "No longer in force" and greyed out.
  it("badges an act published but not yet in force, and dates it from entryIntoForce", async () => {
    const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    searchLaws.mockResolvedValue({
      results: [{
        celex: "32026R1818",
        title: "Regulation on packaging",
        date: "2026-06-17",
        inForce: false,
        endOfValidity: null,
        entryIntoForce: future,
      }],
    });
    renderSearchBox();

    typeQuery("packaging");
    await flush();

    const row = rowFor("2026/1818");
    expect(row).toBeTruthy();
    expect(row.textContent).toContain("Not yet in force");

    const badge = Array.from(row.querySelectorAll("[title]")).find((el) => el.title.includes(future));
    expect(badge).toBeTruthy();
    expect(badge.title).toBe(`Enters into force on ${future}`);
    expect(badge.title).not.toContain("{date}");

    // Not greyed out: an act that has not started is the opposite of spent.
    const title = row.querySelector(".font-display");
    expect(title.className).not.toContain("text-gray-400");
  });

  // An entry date in the past is not a reason to soften anything: the act
  // started and then stopped, which is exactly "not in force" today.
  it("treats a past entry-into-force date as not in force, not as upcoming", async () => {
    searchLaws.mockResolvedValue({
      results: [{
        celex: "31970R0729",
        title: "Regulation on agricultural policy financing",
        date: "1970-04-21",
        inForce: false,
        endOfValidity: "1999-07-02",
        entryIntoForce: "1970-05-18",
      }],
    });
    renderSearchBox();

    typeQuery("agricultural policy financing");
    await flush();

    const row = rowFor("1970/729");
    expect(row).toBeTruthy();
    expect(row.textContent).toContain("Not in force");
    expect(row.textContent).not.toContain("Not yet in force");
  });

  it("badges an act that is no longer in force, and dates it from endOfValidity", async () => {
    searchLaws.mockResolvedValue({
      results: [{
        celex: "31995L0046",
        title: "Data Protection Directive",
        date: "1995-10-24",
        inForce: false,
        endOfValidity: "2018-05-24",
      }],
    });
    renderSearchBox();

    typeQuery("data protection directive");
    await flush();

    const row = rowFor("95/46");
    expect(row).toBeTruthy();
    // The pill states only what the flag supports. "No longer" is a claim about
    // the past that `inForce: false` alone cannot make — see the not-yet case
    // below, which carries the same flag and means the opposite.
    expect(row.textContent).toContain("Not in force");

    // The tooltip carries the date, and must interpolate rather than leak the
    // raw {date} placeholder.
    const badge = Array.from(row.querySelectorAll("[title]")).find((el) => el.title.includes("2018-05-24"));
    expect(badge).toBeTruthy();
    expect(badge.title).toBe("No longer in force since 2018-05-24");
    expect(badge.title).not.toContain("{date}");
  });

  // The whole point of the tri-state: an act Cellar has no status for must not
  // be labelled either way. ~13% of the corpus is in this bucket (Cellar carries
  // no in-force triple for most Commission Implementing Regulations), so this is
  // the common case, not an edge case.
  it("draws no badge when the status is unknown", async () => {
    searchLaws.mockResolvedValue({
      results: [{ celex: "32015R0025", title: "Implementing Regulation", date: "2015-01-07", inForce: null, endOfValidity: null }],
    });
    renderSearchBox();

    typeQuery("implementing regulation");
    await flush();

    const row = rowFor("2015/25");
    expect(row).toBeTruthy();
    expect(row.textContent).not.toContain("In force");
    expect(row.textContent).not.toContain("No longer in force");
  });

  // A record from a pre-data-v8 cache carries no inForce key at all. It must
  // read as unknown rather than throwing or claiming an act is dead.
  it("draws no badge when the field is absent entirely", async () => {
    searchLaws.mockResolvedValue({
      results: [{ celex: "32015R0025", title: "Implementing Regulation", date: "2015-01-07" }],
    });
    renderSearchBox();

    typeQuery("implementing regulation");
    await flush();

    const row = rowFor("2015/25");
    expect(row).toBeTruthy();
    expect(row.textContent).not.toContain("In force");
  });

  it("dims the title of an act that is no longer in force", async () => {
    searchLaws.mockResolvedValue({
      results: [
        { celex: "32016R0679", title: "GDPR", date: "2016-04-27", inForce: true },
        { celex: "31995L0046", title: "Data Protection Directive", date: "1995-10-24", inForce: false },
      ],
    });
    renderSearchBox();

    typeQuery("data protection");
    await flush();

    const live = rowFor("2016/679").querySelector("span");
    const dead = rowFor("95/46").querySelector("span");
    expect(live.className).toContain("text-eu-navy");
    expect(dead.className).not.toContain("text-eu-navy");
    expect(dead.className).toContain("text-gray-400");
  });
});
