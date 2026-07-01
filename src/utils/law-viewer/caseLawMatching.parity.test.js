import { describe, expect, it } from "vitest";
import { matchesArticle as frontendMatchesArticle } from "./caseLawMatching.js";
import backendModule from "../../../backend/shared/article-digest-service.js";

const { matchesArticle: backendMatchesArticle } = backendModule;

const CELEX = "32016R0679";

const fixtures = [
  {
    name: "matching ref",
    c: { articleRefs: [{ actCelex: CELEX, article: "6" }] },
    celex: CELEX,
    articleNumber: "6",
    expected: true,
  },
  {
    name: "wrong celex",
    c: { articleRefs: [{ actCelex: "32022R1925", article: "6" }] },
    celex: CELEX,
    articleNumber: "6",
    expected: false,
  },
  {
    name: "wrong article number",
    c: { articleRefs: [{ actCelex: CELEX, article: "5" }] },
    celex: CELEX,
    articleNumber: "6",
    expected: false,
  },
  {
    name: "missing articleRefs",
    c: {},
    celex: CELEX,
    articleNumber: "6",
    expected: false,
  },
  {
    name: "falsy articleNumber",
    c: { articleRefs: [{ actCelex: CELEX, article: "6" }] },
    celex: CELEX,
    articleNumber: null,
    expected: false,
  },
  {
    name: "multiple refs with only one matching",
    c: { articleRefs: [{ actCelex: CELEX, article: "5" }, { actCelex: CELEX, article: "6" }] },
    celex: CELEX,
    articleNumber: "6",
    expected: true,
  },
  {
    name: "numeric vs string article number",
    c: { articleRefs: [{ actCelex: CELEX, article: 6 }] },
    celex: CELEX,
    articleNumber: "6",
    expected: true,
  },
];

describe("matchesArticle parity between frontend and backend", () => {
  for (const { name, c, celex, articleNumber, expected } of fixtures) {
    it(`${name} -> ${expected}`, () => {
      expect(frontendMatchesArticle(c, celex, articleNumber)).toBe(expected);
      expect(backendMatchesArticle(c, celex, articleNumber)).toBe(expected);
    });
  }
});
