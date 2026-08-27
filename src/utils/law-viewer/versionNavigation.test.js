import { describe, expect, it } from "vitest";

import { buildVersionReadTarget } from "./versionNavigation.js";

const data = {
  articles: [{ article_number: "1" }, { article_number: "2" }],
  recitals: [{ recital_number: "1" }],
  annexes: [{ annex_id: "I" }],
};

describe("buildVersionReadTarget", () => {
  it("targets the first article and keeps the other query params", () => {
    expect(buildVersionReadTarget(data, new URLSearchParams("lang=EN"), "current")).toEqual({
      kind: "article",
      id: "1",
      search: "?lang=EN&version=current",
    });
  });

  it("replaces an existing version rather than appending a second one", () => {
    const target = buildVersionReadTarget(data, new URLSearchParams("version=current"), "current");
    expect(target.search).toBe("?version=current");
  });

  it("falls back to a recital, then an annex, when there are no articles", () => {
    expect(buildVersionReadTarget({ recitals: data.recitals, annexes: data.annexes }, new URLSearchParams(), "current"))
      .toEqual({ kind: "recital", id: "1", search: "?version=current" });
    expect(buildVersionReadTarget({ annexes: data.annexes }, new URLSearchParams(), "current"))
      .toEqual({ kind: "annex", id: "I", search: "?version=current" });
  });

  it("returns null when clearing the version — going back is not a request to read", () => {
    expect(buildVersionReadTarget(data, new URLSearchParams("version=current"), null)).toBeNull();
  });

  it("returns null when the document has nothing readable", () => {
    expect(buildVersionReadTarget({ articles: [], recitals: [], annexes: [] }, new URLSearchParams(), "current"))
      .toBeNull();
  });
});
