import { describe, expect, it } from "vitest";
import { alignHtmlBlocks } from "./alignBlocks.js";

describe("alignHtmlBlocks", () => {
  it("pairs equal block counts by index", () => {
    const rows = alignHtmlBlocks(
      "<p class='oj-normal'>First EN.</p><p class='oj-normal'>Second EN.</p>",
      "<p class='oj-normal'>Erster DE.</p><p class='oj-normal'>Zweiter DE.</p>"
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].a).toContain("First EN.");
    expect(rows[0].b).toContain("Erster DE.");
    expect(rows[1].a).toContain("Second EN.");
    expect(rows[1].b).toContain("Zweiter DE.");
  });

  it("keeps a numbered block with a nested table as a single row", () => {
    const block =
      "<div class='fmx-numbered-block'><p>1. Intro</p><table><tbody><tr><td>(a)</td><td>item</td></tr></tbody></table></div>";
    const rows = alignHtmlBlocks(block + "<p>Tail EN</p>", block + "<p>Schluss DE</p>");
    expect(rows).toHaveLength(2);
    expect(rows[0].a).toContain("<table>");
    expect(rows[0].b).toContain("<table>");
    expect(rows[1].b).toContain("Schluss DE");
  });

  it("pairs the common prefix and emits one-sided rows for the remainder", () => {
    const rows = alignHtmlBlocks(
      "<p>one</p><p>two</p><p>three</p>",
      "<p>eins</p><p>zwei</p>"
    );
    expect(rows).toHaveLength(3);
    expect(rows[2].a).toContain("three");
    expect(rows[2].b).toBeNull();
  });

  it("handles an empty side without throwing", () => {
    const rows = alignHtmlBlocks("<p>only</p>", "");
    expect(rows).toHaveLength(1);
    expect(rows[0].a).toContain("only");
    expect(rows[0].b).toBeNull();
    expect(alignHtmlBlocks("", "")).toEqual([]);
  });

  it("ignores whitespace-only text between blocks but keeps meaningful stray text", () => {
    const rows = alignHtmlBlocks(
      "<p>a</p>\n   \n<p>b</p>",
      "<p>x</p>stray text<p>y</p>"
    );
    expect(rows).toHaveLength(3);
    expect(rows[0].a).toContain("a");
    expect(rows[1].a).toContain("b");
    expect(rows[1].b).toBe("stray text");
    expect(rows[2].a).toBeNull();
  });
});
