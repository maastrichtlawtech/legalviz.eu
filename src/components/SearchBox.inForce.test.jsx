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
    expect(row.textContent).not.toContain("No longer in force");
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
    expect(row.textContent).toContain("No longer in force");

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
