import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockNavigate, mockResolveOfficialReference, mockSaveLawMeta } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockResolveOfficialReference: vi.fn(),
  mockSaveLawMeta: vi.fn(),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock("../../utils/formexApi.js", async () => {
  const actual = await vi.importActual("../../utils/formexApi.js");
  return {
    ...actual,
    resolveOfficialReference: mockResolveOfficialReference,
  };
});

vi.mock("../../utils/library.js", () => ({
  saveLawMeta: mockSaveLawMeta,
}));

import { useLawViewerInteractions } from "./useLawViewerInteractions.js";

const data = {
  articles: [
    { article_number: "1", article_html: "<p>1</p>" },
    { article_number: "2", article_html: "<p>2</p>" },
    { article_number: "3", article_html: "<p>3</p>" },
  ],
  recitals: [
    { recital_number: "10", recital_html: "<p>r10</p>" },
    { recital_number: "11", recital_html: "<p>r11</p>" },
  ],
  annexes: [
    { annex_id: "I", annex_html: "<p>annex I</p>" },
  ],
};

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("useLawViewerInteractions", () => {
  let container;
  let root;
  let latestValue;
  let onPrevNext;

  function Probe(props) {
    latestValue = useLawViewerInteractions(props);
    return null;
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latestValue = null;
    onPrevNext = vi.fn();
    mockNavigate.mockReset();
    mockSaveLawMeta.mockReset().mockResolvedValue(null);
    mockResolveOfficialReference.mockReset();
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    container?.remove();
    document.body.innerHTML = "";
  });

  function render(props = {}) {
    return act(async () => {
      root.render(
        <Probe
          data={data}
          selected={{ kind: "article", id: "2" }}
          onPrevNext={onPrevNext}
          currentContentLang="EN"
          locale="en"
          {...props}
        />
      );
    });
  }

  function pressKey(init) {
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", init));
    });
  }

  describe("keyboard navigation", () => {
    it("navigates forward with j and backward with k", async () => {
      await render();

      pressKey({ key: "j" });
      expect(onPrevNext).toHaveBeenLastCalledWith("article", 2);

      pressKey({ key: "k" });
      expect(onPrevNext).toHaveBeenLastCalledWith("article", 0);
    });

    it("ignores j/k and arrow keys when a modifier key is held", async () => {
      await render();

      for (const init of [
        { key: "j", metaKey: true },
        { key: "j", ctrlKey: true },
        { key: "j", altKey: true },
        { key: "j", shiftKey: true },
        { key: "k", metaKey: true },
        { key: "k", ctrlKey: true },
        { key: "k", altKey: true },
        { key: "k", shiftKey: true },
        { key: "ArrowLeft", metaKey: true },
        { key: "ArrowLeft", ctrlKey: true },
        { key: "ArrowLeft", altKey: true },
        { key: "ArrowLeft", shiftKey: true },
        { key: "ArrowRight", metaKey: true },
        { key: "ArrowRight", ctrlKey: true },
        { key: "ArrowRight", altKey: true },
        { key: "ArrowRight", shiftKey: true },
      ]) {
        pressKey(init);
      }

      expect(onPrevNext).not.toHaveBeenCalled();
    });

    it("navigates with plain ArrowLeft/ArrowRight", async () => {
      await render();

      pressKey({ key: "ArrowRight" });
      expect(onPrevNext).toHaveBeenLastCalledWith("article", 2);

      pressKey({ key: "ArrowLeft" });
      expect(onPrevNext).toHaveBeenLastCalledWith("article", 0);
    });

    it("does not navigate past the first entry", async () => {
      await render({ selected: { kind: "article", id: "1" } });

      pressKey({ key: "ArrowLeft" });
      pressKey({ key: "k" });
      pressKey({ key: "ArrowLeft" });

      expect(onPrevNext).not.toHaveBeenCalled();
    });

    it("does not navigate past the last entry", async () => {
      await render({ selected: { kind: "article", id: "3" } });

      pressKey({ key: "ArrowRight" });
      pressKey({ key: "j" });
      pressKey({ key: "ArrowRight" });

      expect(onPrevNext).not.toHaveBeenCalled();
    });

    it("ignores keys pressed inside an INPUT", async () => {
      await render();
      const input = document.createElement("input");
      document.body.appendChild(input);

      act(() => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
      });

      expect(onPrevNext).not.toHaveBeenCalled();
      input.remove();
    });

    it("ignores keys pressed inside a TEXTAREA", async () => {
      await render();
      const textarea = document.createElement("textarea");
      document.body.appendChild(textarea);

      act(() => {
        textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
      });

      expect(onPrevNext).not.toHaveBeenCalled();
      textarea.remove();
    });

    it("yields navigation keys to the search modal when a dialog is open", async () => {
      await render();
      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      document.body.appendChild(dialog);

      pressKey({ key: "j" });
      pressKey({ key: "k" });
      pressKey({ key: "ArrowLeft" });
      pressKey({ key: "ArrowRight" });

      expect(onPrevNext).not.toHaveBeenCalled();
      dialog.remove();
    });

    it("navigates recitals with the same j/k and arrow keys", async () => {
      await render({ selected: { kind: "recital", id: "10" } });

      pressKey({ key: "j" });
      expect(onPrevNext).toHaveBeenLastCalledWith("recital", 1);

      pressKey({ key: "ArrowRight" });
      expect(onPrevNext).toHaveBeenLastCalledWith("recital", 1);

      await render({ selected: { kind: "recital", id: "11" } });

      pressKey({ key: "k" });
      expect(onPrevNext).toHaveBeenLastCalledWith("recital", 0);

      pressKey({ key: "ArrowLeft" });
      expect(onPrevNext).toHaveBeenLastCalledWith("recital", 0);
    });

    it("does nothing when the selected kind has no list entries", async () => {
      await render({ selected: { kind: "annex", id: "I" } });

      pressKey({ key: "j" });
      pressKey({ key: "k" });
      pressKey({ key: "ArrowLeft" });
      pressKey({ key: "ArrowRight" });

      expect(onPrevNext).not.toHaveBeenCalled();
    });
  });

  describe("touch swipes", () => {
    it("navigates forward on a left swipe past the horizontal threshold", async () => {
      await render({ selected: { kind: "article", id: "2" } });

      act(() => {
        latestValue.onTouchStart({ targetTouches: [{ clientX: 300 }] });
        latestValue.onTouchMove({ targetTouches: [{ clientX: 200 }] });
      });
      act(() => {
        latestValue.onTouchEnd();
      });

      expect(onPrevNext).toHaveBeenCalledWith("article", 2);
    });

    it("navigates backward on a right swipe past the horizontal threshold", async () => {
      await render({ selected: { kind: "article", id: "2" } });

      act(() => {
        latestValue.onTouchStart({ targetTouches: [{ clientX: 200 }] });
        latestValue.onTouchMove({ targetTouches: [{ clientX: 300 }] });
      });
      act(() => {
        latestValue.onTouchEnd();
      });

      expect(onPrevNext).toHaveBeenCalledWith("article", 0);
    });

    it("does not navigate when the horizontal distance is exactly the 50px threshold", async () => {
      await render();

      act(() => {
        latestValue.onTouchStart({ targetTouches: [{ clientX: 300 }] });
        latestValue.onTouchMove({ targetTouches: [{ clientX: 250 }] });
      });
      act(() => {
        latestValue.onTouchEnd();
      });

      expect(onPrevNext).not.toHaveBeenCalled();
    });

    it("does not navigate when the horizontal distance is below the threshold", async () => {
      await render();

      act(() => {
        latestValue.onTouchStart({ targetTouches: [{ clientX: 300 }] });
        latestValue.onTouchMove({ targetTouches: [{ clientX: 280 }] });
      });
      act(() => {
        latestValue.onTouchEnd();
      });

      expect(onPrevNext).not.toHaveBeenCalled();
    });

    it("does not navigate backward from the first entry", async () => {
      await render({ selected: { kind: "article", id: "1" } });

      act(() => {
        latestValue.onTouchStart({ targetTouches: [{ clientX: 200 }] });
        latestValue.onTouchMove({ targetTouches: [{ clientX: 400 }] });
      });
      act(() => {
        latestValue.onTouchEnd();
      });

      expect(onPrevNext).not.toHaveBeenCalled();
    });

    it("does not navigate forward from the last entry", async () => {
      await render({ selected: { kind: "article", id: "3" } });

      act(() => {
        latestValue.onTouchStart({ targetTouches: [{ clientX: 400 }] });
        latestValue.onTouchMove({ targetTouches: [{ clientX: 200 }] });
      });
      act(() => {
        latestValue.onTouchEnd();
      });

      expect(onPrevNext).not.toHaveBeenCalled();
    });

    it("does not navigate when vertical drift dominates the gesture", async () => {
      await render({ selected: { kind: "article", id: "2" } });

      act(() => {
        latestValue.onTouchStart({ targetTouches: [{ clientX: 300, clientY: 100 }] });
        latestValue.onTouchMove({ targetTouches: [{ clientX: 200, clientY: 900 }] });
      });
      act(() => {
        latestValue.onTouchEnd();
      });

      expect(onPrevNext).not.toHaveBeenCalled();
    });

    it("navigates when horizontal movement dominates a small vertical drift", async () => {
      await render({ selected: { kind: "article", id: "2" } });

      act(() => {
        latestValue.onTouchStart({ targetTouches: [{ clientX: 300, clientY: 100 }] });
        latestValue.onTouchMove({ targetTouches: [{ clientX: 200, clientY: 130 }] });
      });
      act(() => {
        latestValue.onTouchEnd();
      });

      expect(onPrevNext).toHaveBeenCalledWith("article", 2);
    });

    it("does not navigate when only vertical movement occurred", async () => {
      await render();

      act(() => {
        latestValue.onTouchStart({ targetTouches: [{ clientX: 300, clientY: 100 }] });
        latestValue.onTouchMove({ targetTouches: [{ clientX: 300, clientY: 900 }] });
      });
      act(() => {
        latestValue.onTouchEnd();
      });

      expect(onPrevNext).not.toHaveBeenCalled();
    });

    it("does nothing when no touch start was recorded", async () => {
      await render();

      act(() => {
        latestValue.onTouchMove({ targetTouches: [{ clientX: 200 }] });
      });
      act(() => {
        latestValue.onTouchEnd();
      });

      expect(onPrevNext).not.toHaveBeenCalled();
    });

    it("does nothing when no touch move was recorded", async () => {
      await render();

      act(() => {
        latestValue.onTouchStart({ targetTouches: [{ clientX: 300 }] });
      });
      act(() => {
        latestValue.onTouchEnd();
      });

      expect(onPrevNext).not.toHaveBeenCalled();
    });
  });

  describe("external reference resolution", () => {
    const refA = { raw: "Regulation (EU) 2016/679", actType: "R", year: "2016", number: "679" };
    const refB = { raw: "Directive (EU) 2015/2366", actType: "L", year: "2015", number: "2366" };

    it("lets a newer resolution supersede a stale one without clearing pending state", async () => {
      const deferredA = createDeferred();
      const deferredB = createDeferred();
      mockResolveOfficialReference
        .mockReturnValueOnce(deferredA.promise)
        .mockReturnValueOnce(deferredB.promise);

      await render();

      let promiseA;
      let promiseB;
      act(() => {
        promiseA = latestValue.handleOpenExternalLaw(refA);
        promiseB = latestValue.handleOpenExternalLaw(refB);
      });
      expect(latestValue.pendingExternalReferenceLabel).toBe(refB.raw);

      await act(async () => {
        deferredA.resolve({ resolved: { celex: "32016R0679" } });
        await promiseA;
      });

      expect(latestValue.isResolvingExternalLaw).toBe(true);
      expect(latestValue.pendingExternalReferenceLabel).toBe(refB.raw);
      expect(mockNavigate).toHaveBeenCalledTimes(1);

      await act(async () => {
        deferredB.resolve({ resolved: { celex: "32015L2366" } });
        await promiseB;
      });

      expect(latestValue.isResolvingExternalLaw).toBe(false);
      expect(latestValue.pendingExternalReferenceLabel).toBe("");
    });

    it("clears pending state immediately when the reference has no act details", async () => {
      const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

      await render();
      await act(async () => {
        await latestValue.handleOpenExternalLaw({ raw: "not a legal reference" });
      });

      expect(latestValue.isResolvingExternalLaw).toBe(false);
      expect(latestValue.pendingExternalReferenceLabel).toBe("");
      expect(mockResolveOfficialReference).not.toHaveBeenCalled();
      expect(openSpy).toHaveBeenCalledTimes(1);

      openSpy.mockRestore();
    });
  });
});