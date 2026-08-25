import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

vi.mock("../LawSummary.jsx", () => ({ LawSummary: () => null }));
vi.mock("../MetadataPanel.jsx", () => ({ MetadataPanel: () => null }));
vi.mock("../ConsolidationNotice.jsx", () => ({
  ConsolidationNotice: ({ variant }) => createElement("div", { "data-variant": variant }),
}));
vi.mock("./ConsolidatedFallbackNotice.jsx", () => ({ ConsolidatedFallbackNotice: () => null }));
vi.mock("../../hooks/useLawMetadata.js", () => ({
  useLawMetadata: () => ({
    metadata: {},
    status: null,
    procedure: { procedureUrl: "https://eur-lex.europa.eu/procedure" },
    amendments: [],
    implementing: [],
    citedBy: [],
  }),
}));
vi.mock("../../hooks/law-viewer/useCaseLaw.js", () => ({
  useCaseLaw: () => ({ cases: null, loading: false, loaded: false, trigger: vi.fn() }),
}));

const { LawOverviewPage } = await import("./LawOverviewPage.jsx");

let container;
let root;

const t = (key, values = {}) => ({
  "lawOverview.actTypeRegulation": "Regulation",
  "lawOverview.celexLabel": `CELEX ${values.celex}`,
  "lawOverview.procedureView": "Legislative history on EUR-Lex",
  "metadata.caseLaw": "CJEU Case Law",
  "metadata.inForce": "In force",
  "lawViewer.startReading": "Start reading",
}[key] || key);

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("LawOverviewPage", () => {
  it("uses the compact notice and keeps the overview action labels without Print", async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(
        createElement(
          MemoryRouter,
          null,
          createElement(LawOverviewPage, {
            currentLaw: {
              label: "Example regulation",
              officialReference: { actType: "regulation", raw: "Regulation (EU) 2020/1" },
            },
            data: { title: "Example regulation", articles: [], recitals: [], annexes: [] },
            effectiveCelex: "32020R0001",
            formexLang: "EN",
            onArticleClick: vi.fn(),
            onStartReading: vi.fn(),
            externalLawOverview: [],
            onOpenExternalLaw: vi.fn(),
            onOpenCitedLaw: vi.fn(),
            isExternalReferencePending: false,
            t,
          })
        )
      );
    });

    expect(container.querySelector("[data-variant=compact]")).toBeTruthy();
    expect(container.textContent).toContain("Start reading");
    expect(container.textContent).toContain("CJEU Case Law");
    expect(container.textContent).toContain("Legislative history on EUR-Lex");
    expect(container.textContent).not.toContain("Print");
  });
});
