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
  // Let the debounce timer fire, then drain the microtask queue for the
  // resolved searchLaws promise and the state updates it triggers.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
}

function renderSearchBox(onNavigate) {
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
            onNavigate,
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

describe("SearchBox — CELEX / EUR-Lex direct open", () => {
  it("injects a direct-open result for a typed CELEX with no index match", async () => {
    searchLaws.mockResolvedValue({ results: [] });
    renderSearchBox(vi.fn());

    typeQuery("32016R0679");
    await flush();

    const bodyText = document.body.textContent;
    expect(bodyText).toContain("Regulation (EU) 2016/679");
    expect(bodyText).toContain("32016R0679");
    expect(bodyText).toContain("Open directly");
  });

  it("navigates with the CELEX when the direct-open result is clicked", async () => {
    searchLaws.mockResolvedValue({ results: [] });
    const onNavigate = vi.fn();
    renderSearchBox(onNavigate);

    typeQuery("32016R0679");
    await flush();

    const hit = resultButtons().find((b) => b.textContent.includes("2016/679"));
    expect(hit).toBeTruthy();
    act(() => hit.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(onNavigate).toHaveBeenCalledTimes(1);
    const item = onNavigate.mock.calls[0][0];
    expect(item.search_kind).toBe("law");
    expect(item.celex).toBe("32016R0679");
  });

  it("does not duplicate a CELEX the backend already matched exactly", async () => {
    searchLaws.mockResolvedValue({
      results: [{ celex: "32016R0679", title: "GDPR", date: "2016-04-27" }],
    });
    renderSearchBox(vi.fn());

    typeQuery("32016R0679");
    await flush();

    const lawHits = resultButtons().filter((b) => b.textContent.includes("2016/679"));
    expect(lawHits.length).toBe(1);
    // The exact backend match wins, so no "Open directly" chip is shown.
    expect(document.body.textContent).not.toContain("Open directly");
  });

  it("still offers direct open when the backend search fails", async () => {
    searchLaws.mockRejectedValue(new Error("search_cache_unavailable"));
    renderSearchBox(vi.fn());

    typeQuery("32022L2555");
    await flush();

    expect(document.body.textContent).toContain("Directive (EU) 2022/2555");
    expect(document.body.textContent).toContain("Open directly");
  });

  it("queries the backend by canonical CELEX for a pasted EUR-Lex URL", async () => {
    // The backend anchors its CELEX regex at the start of the query, so a raw
    // URL never resolves to an exact match. Sending the derived CELEX makes the
    // indexed act surface as the top result instead of being buried in fuzzy
    // token hits.
    searchLaws.mockResolvedValue({
      results: [{ celex: "32023R2854", title: "Data Act", date: "2023-12-13" }],
    });
    renderSearchBox(vi.fn());

    typeQuery("https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32023R2854");
    await flush();

    expect(searchLaws).toHaveBeenCalled();
    expect(searchLaws.mock.calls.at(-1)[0]).toBe("32023R2854");
    // The indexed exact match wins — no synthetic "Open directly" is injected,
    // and it isn't duplicated.
    const lawHits = resultButtons().filter((b) => b.textContent.includes("2023/2854"));
    expect(lawHits.length).toBe(1);
  });

  it("opens a pasted EUR-Lex URL by deriving its CELEX", async () => {
    searchLaws.mockResolvedValue({ results: [] });
    const onNavigate = vi.fn();
    renderSearchBox(onNavigate);

    typeQuery("https://eur-lex.europa.eu/eli/reg/2016/679/oj");
    await flush();

    const hit = resultButtons().find((b) => b.textContent.includes("2016/679"));
    expect(hit).toBeTruthy();
    act(() => hit.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(onNavigate.mock.calls[0][0].celex).toBe("32016R0679");
  });
});
