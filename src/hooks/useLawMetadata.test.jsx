import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

const api = vi.hoisted(() => ({
  fetchLawMetadata: vi.fn(),
  fetchAmendments: vi.fn(),
  fetchImplementingActs: vi.fn(),
  fetchLegislativeProcedure: vi.fn(),
  fetchLawCitedBy: vi.fn(),
}));

vi.mock("../utils/formexApi.js", () => api);

import { useLawMetadata } from "./useLawMetadata.js";

let container;
let root;
let latest;

function Probe({ celex }) {
  latest = useLawMetadata(celex);
  return null;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  latest = null;
  vi.clearAllMocks();
  api.fetchLawMetadata.mockResolvedValue(null);
  api.fetchAmendments.mockResolvedValue({ amendments: [] });
  api.fetchImplementingActs.mockResolvedValue({ acts: [] });
  api.fetchLegislativeProcedure.mockResolvedValue({
    celex: null,
    reference: null,
    procedureUrl: null,
  });
  api.fetchLawCitedBy.mockResolvedValue(null);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(celex) {
  await act(async () => {
    root.render(<Probe celex={celex} />);
  });
}

describe("useLawMetadata procedure link", () => {
  it("keeps a resolved EUR-Lex procedure link", async () => {
    const procedure = {
      celex: "32024R1689",
      reference: "2021/0106(COD)",
      procedureUrl: "https://eur-lex.europa.eu/procedure/EN/2021_106",
    };
    api.fetchLegislativeProcedure.mockResolvedValue(procedure);

    await render("32024R1689");
    await vi.waitFor(() => expect(latest.procedure).toEqual(procedure));
  });

  it("hides an absent or failed procedure link", async () => {
    await render("32016R0679");
    await vi.waitFor(() => expect(api.fetchLegislativeProcedure).toHaveBeenCalledOnce());
    expect(latest.procedure).toBeNull();

    api.fetchLegislativeProcedure.mockRejectedValue(new Error("CELLAR unavailable"));
    await act(async () => root.render(<Probe celex="32022R1925" />));
    await vi.waitFor(() => expect(api.fetchLegislativeProcedure).toHaveBeenCalledTimes(2));
    expect(latest.procedure).toBeNull();
  });
});
