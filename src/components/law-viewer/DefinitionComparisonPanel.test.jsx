import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefinitionComparisonPanel } from "./DefinitionComparisonPanel.jsx";

let container;
let root;

const messages = {
  "definitionComparison.article": "Article {article}",
  "definitionComparison.current": "Current",
  "definitionComparison.sameWording": "Same wording",
  "definitionComparison.differentWording": "Different wording",
  "definitionComparison.openSource": "Open source",
  "definitionComparison.summary": "{laws} {lawWord} · {wordings} {wordingWord}",
  "definitionComparison.empty": "Empty",
  "common.close": "Close",
  "search.law": "law",
  "search.laws": "laws",
  "search.wording": "wording",
  "search.wordings": "wordings",
};

function t(key, vars = {}) {
  return String(messages[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ""));
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

describe("DefinitionComparisonPanel", () => {
  it("puts the current law first and preserves backend law metadata", () => {
    const onOpenSource = vi.fn();
    act(() => {
      root.render(
        <DefinitionComparisonPanel
          term="risk"
          currentCelex="32022L2555"
          comparison={{
            term: "risk",
            lawCount: 2,
            wordingCount: 1,
            occurrences: [
              { celex: "32022L2557", sourceArticle: "3", definition: "the potential for loss", definitionHash: "same", law: { title: "CER Directive" } },
              { celex: "32022L2555", sourceArticle: "6", definition: "the potential for loss", definitionHash: "same", law: { title: "NIS 2 Directive" } },
            ],
          }}
          onOpenSource={onOpenSource}
          onClose={() => {}}
          t={t}
        />
      );
    });

    expect(container.textContent).toContain("2 laws · 1 wording");
    const titles = [...container.querySelectorAll(".truncate.text-xs")].map((node) => node.textContent);
    expect(titles).toEqual(["NIS 2 Directive", "CER Directive"]);
    expect(container.textContent).toContain("Current");
    expect(container.textContent).toContain("Same wording");

    const sourceButtons = [...container.querySelectorAll("button")].filter((button) => button.textContent.includes("Open source"));
    act(() => sourceButtons[0].click());
    expect(onOpenSource).toHaveBeenCalledWith("32022L2555", "6");
  });
});
