import { describe, expect, it } from "vitest";
import { sanitizeLawHtml } from "./sanitizeHtml.js";

describe("sanitizeLawHtml", () => {
  it("returns empty string for empty input", () => {
    expect(sanitizeLawHtml("")).toBe("");
    expect(sanitizeLawHtml(null)).toBe("");
    expect(sanitizeLawHtml(undefined)).toBe("");
  });

  it("strips inline event handlers", () => {
    const out = sanitizeLawHtml('<p>Article 1</p><img src="x" onerror="alert(1)">');
    expect(out).not.toContain("onerror");
    expect(out).toContain("Article 1");
  });

  it("removes script and iframe elements", () => {
    const out = sanitizeLawHtml('<div>text<script>alert(1)</script><iframe src="https://evil.example"></iframe></div>');
    expect(out).not.toContain("script");
    expect(out).not.toContain("iframe");
    expect(out).toContain("text");
  });

  it("neutralises javascript: URLs", () => {
    const out = sanitizeLawHtml('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toContain("javascript:");
    expect(out).toContain("click");
  });

  it("keeps the markup the parsers emit", () => {
    const input =
      '<li class="fmx-list-item" data-marker="(a)">' +
      '<span class="oj-ref" data-oj-coll="L" data-oj-no="119" data-oj-year="2016" data-oj-page="1">OJ ref</span>' +
      '<a href="#article-30" class="lv-crossref">Article 30</a>' +
      '<span data-term="controller" role="button" tabindex="0" aria-haspopup="dialog">controller</span>' +
      "</li>";
    const out = sanitizeLawHtml(input);
    expect(out).toContain('data-marker="(a)"');
    expect(out).toContain('data-oj-no="119"');
    expect(out).toContain('href="#article-30"');
    expect(out).toContain('data-term="controller"');
    expect(out).toContain('tabindex="0"');
    expect(out).toContain('aria-haspopup="dialog"');
  });

  it("keeps tables and styling from legacy EUR-Lex HTML", () => {
    const input = '<table class="oj-table"><tr><td colspan="2" style="text-align:center">cell</td></tr></table>';
    const out = sanitizeLawHtml(input);
    expect(out).toContain("<table");
    expect(out).toContain('colspan="2"');
    expect(out).toContain("cell");
  });
});
