import { describe, expect, it } from "vitest";
import { FormexApiError } from "../formexApi.js";
import { getEmptyContentDetails, getLoadErrorDetails, isMissingStructuredLawText } from "./errors.js";

const t = (key) => key;

describe("isMissingStructuredLawText", () => {
  it("detects formex-not-found errors", () => {
    expect(isMissingStructuredLawText(new FormexApiError("Formex not found", { status: 404 }))).toBe(true);
  });
});

describe("getLoadErrorDetails", () => {
  it("maps missing structured text to notice tone", () => {
    const details = getLoadErrorDetails(new FormexApiError("Formex not found", { status: 404 }), t);
    expect(details.tone).toBe("notice");
    expect(details.title).toBe("lawViewer.notAvailableTitle");
  });

  it("maps EUR-Lex challenge errors to a dedicated temporary-access message", () => {
    const details = getLoadErrorDetails(
      new FormexApiError("EUR-Lex challenged access", { status: 503, code: "eurlex_html_challenged" }),
      t
    );
    expect(details.tone).toBe("notice");
    expect(details.title).toBe("lawViewer.notAvailableTitle");
    expect(details.message).toBe("lawViewer.notAvailableMessage");
  });

  it("maps generic errors to error tone", () => {
    const details = getLoadErrorDetails(new Error("boom"), t);
    expect(details.tone).toBe("error");
    expect(details.message).toContain("boom");
  });
});

describe("getEmptyContentDetails", () => {
  it("builds a notice without a retry or error status", () => {
    expect(getEmptyContentDetails(t)).toEqual({
      title: "lawViewer.emptyContentTitle",
      message: "lawViewer.emptyContentMessage",
      fallbackUrl: null,
      status: null,
      tone: "notice",
    });
  });
});
