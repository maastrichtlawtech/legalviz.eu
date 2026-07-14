import { describe, it, expect } from "vitest";
import {
  tokenize,
  mapRecitalsToArticles,
  buildSearchIndex,
  searchIndex,
  searchContent,
} from "./nlp.js";

describe("tokenize", () => {
  it("tokenizes basic English text", () => {
    const tokens = tokenize("The personal data controller shall ensure compliance.");
    expect(tokens).toBeInstanceOf(Array);
    expect(tokens.length).toBeGreaterThan(0);
  });

  it("removes English stop words", () => {
    const tokens = tokenize("The data shall be processed");
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("shall");
  });

  it("lowercases all tokens", () => {
    const tokens = tokenize("PERSONAL Data Controller");
    for (const t of tokens) {
      expect(t).toBe(t.toLowerCase());
    }
  });

  it("removes punctuation", () => {
    const tokens = tokenize("data, processing; controller.");
    for (const t of tokens) {
      expect(t).toMatch(/^[\w\u00C0-\u024F]+$/);
    }
  });

  it("filters out words with 2 or fewer characters", () => {
    const tokens = tokenize("I am a data protection officer");
    for (const t of tokens) {
      expect(t.length).toBeGreaterThan(2);
    }
  });

  it("returns empty array for empty input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize(null)).toEqual([]);
    expect(tokenize(undefined)).toEqual([]);
  });

  it("preserves accented characters (Polish, French, etc.)", () => {
    const tokens = tokenize("données personnelles règlement", "FR");
    expect(tokens.some((t) => t.includes("donn"))).toBe(true);
  });

  it("uses language-specific stop words when langCode provided", () => {
    const enTokens = tokenize("der Artikel verordnung");
    const deTokens = tokenize("der Artikel verordnung", "DE");
    // German stop words should filter more aggressively for DE text
    expect(deTokens.length).toBeLessThanOrEqual(enTokens.length);
  });
});

describe("mapRecitalsToArticles", () => {
  const articles = [
    { article_number: "1", article_title: "Subject matter and scope", article_html: "<p>This regulation lays down rules for data protection.</p>" },
    { article_number: "2", article_title: "Definitions", article_html: "<p>Personal data means any information relating to an identified person.</p>" },
    { article_number: "3", article_title: "Territorial scope", article_html: "<p>This regulation applies to processing by controllers established in the Union.</p>" },
  ];

  const recitals = [
    { recital_number: "1", recital_text: "Protection of personal data is a fundamental right.", recital_html: "<p>Protection of personal data is a fundamental right.</p>" },
    { recital_number: "2", recital_text: "The territorial scope should cover processing in the Union.", recital_html: "<p>Territorial scope processing Union.</p>" },
  ];

  it("returns a Map with article numbers as keys", () => {
    const result = mapRecitalsToArticles(recitals, articles);
    expect(result).toBeInstanceOf(Map);
    expect(result.has("1")).toBe(true);
    expect(result.has("2")).toBe(true);
    expect(result.has("3")).toBe(true);
  });

  it("maps recitals to the most relevant article", () => {
    const result = mapRecitalsToArticles(recitals, articles);
    // Each article should have an array value (possibly empty)
    for (const [, recitals] of result) {
      expect(Array.isArray(recitals)).toBe(true);
    }
  });

  it("returns empty arrays when no recitals match", () => {
    const result = mapRecitalsToArticles([], articles);
    for (const [, recitals] of result) {
      expect(recitals).toHaveLength(0);
    }
  });

  it("mapped recitals include relevanceScore and keywords", () => {
    const result = mapRecitalsToArticles(recitals, articles);
    const allMapped = Array.from(result.values()).flat();
    for (const mapped of allMapped) {
      expect(mapped).toHaveProperty("recital_number");
      expect(mapped).toHaveProperty("relevanceScore");
      expect(mapped).toHaveProperty("keywords");
    }
  });

  it("uses monotonicity to prefer a nearby article over a higher raw text overlap", () => {
    const monotonicArticles = [
      { article_number: "1", article_title: "", article_html: "<p>nearanchor</p>" },
      { article_number: "2", article_title: "", article_html: "<p>middleanchor2</p>" },
      { article_number: "3", article_title: "", article_html: "<p>middleanchor3</p>" },
      { article_number: "4", article_title: "", article_html: "<p>middleanchor4</p>" },
      { article_number: "5", article_title: "", article_html: "<p>faranchor faranchor faranchor faranchor</p>" },
    ];
    const monotonicRecitals = [
      { recital_number: "1", recital_text: "nearanchor faranchor faranchor faranchor" },
      { recital_number: "2", recital_text: "middleanchor2" },
      { recital_number: "3", recital_text: "middleanchor3" },
      { recital_number: "4", recital_text: "middleanchor4" },
      { recital_number: "5", recital_text: "nooverlapterm" },
    ];

    const result = mapRecitalsToArticles(monotonicRecitals, monotonicArticles);

    expect(result.get("1").map((r) => r.recital_number)).toContain("1");
    expect(result.get("5").map((r) => r.recital_number)).not.toContain("1");
  });

  it("can attach one recital to a close secondary article", () => {
    const multiArticles = [
      { article_number: "1", article_title: "", article_html: "<p>sharedanchor</p>" },
      { article_number: "2", article_title: "", article_html: "<p>sharedanchor</p>" },
      { article_number: "3", article_title: "", article_html: "<p>fillerthree</p>" },
      { article_number: "4", article_title: "", article_html: "<p>fillerfour</p>" },
      { article_number: "5", article_title: "", article_html: "<p>fillerfive</p>" },
      { article_number: "6", article_title: "", article_html: "<p>fillersix</p>" },
      { article_number: "7", article_title: "", article_html: "<p>fillersven</p>" },
      { article_number: "8", article_title: "", article_html: "<p>fillereight</p>" },
      { article_number: "9", article_title: "", article_html: "<p>fillernine</p>" },
      { article_number: "10", article_title: "", article_html: "<p>fillerten</p>" },
    ];
    const multiRecitals = [
      { recital_number: "1", recital_text: "sharedanchor" },
      { recital_number: "2", recital_text: "fillerthree" },
      { recital_number: "3", recital_text: "fillerfour" },
      { recital_number: "4", recital_text: "fillerfive" },
      { recital_number: "5", recital_text: "fillersix" },
      { recital_number: "6", recital_text: "fillersven" },
      { recital_number: "7", recital_text: "fillereight" },
      { recital_number: "8", recital_text: "fillernine" },
      { recital_number: "9", recital_text: "fillerten" },
      { recital_number: "10", recital_text: "unmatchedterm" },
    ];

    const result = mapRecitalsToArticles(multiRecitals, multiArticles);

    expect(result.get("1").map((r) => r.recital_number)).toContain("1");
    expect(result.get("2").map((r) => r.recital_number)).toContain("1");
    expect(result.get("3").map((r) => r.recital_number)).not.toContain("1");
  });

  it("keeps a recital under every article it clarifies (many-to-many, no exclusive cap)", () => {
    const multiArticles = [
      { article_number: "1", article_title: "", article_html: "<p>aloneone</p>" },
      { article_number: "2", article_title: "", article_html: "<p>coretopic</p>" },
      { article_number: "3", article_title: "", article_html: "<p>coretopic</p>" },
      { article_number: "4", article_title: "", article_html: "<p>coretopic</p>" },
      { article_number: "5", article_title: "", article_html: "<p>alonefive</p>" },
      { article_number: "6", article_title: "", article_html: "<p>irrelevanttopic irrelevanttopic irrelevanttopic</p>" },
    ];
    const multiRecitals = [
      { recital_number: "1", recital_text: "aloneone" },
      { recital_number: "2", recital_text: "coretopic" },
      { recital_number: "3", recital_text: "alonefive" },
    ];

    const result = mapRecitalsToArticles(multiRecitals, multiArticles);

    // Recital 2 clarifies articles 2, 3 AND 4 — it should appear under all three,
    // not be dropped after "winning" the best-matching one.
    expect(result.get("2").map((r) => r.recital_number)).toContain("2");
    expect(result.get("3").map((r) => r.recital_number)).toContain("2");
    expect(result.get("4").map((r) => r.recital_number)).toContain("2");

    // Recital 2 must not leak into articles it has no term overlap with.
    expect(result.get("1").map((r) => r.recital_number)).not.toContain("2");
    expect(result.get("5").map((r) => r.recital_number)).not.toContain("2");

    // An article with no genuinely relevant recital abstains (empty list, not padded).
    expect(result.get("6")).toEqual([]);
  });

  it("exposes recitals with no term overlap as orphans", () => {
    const result = mapRecitalsToArticles(
      [{ recital_number: "1", recital_text: "nooverlapterm" }],
      articles
    );

    expect(result.get(null)).toEqual(["1"]);
    for (const [articleNumber, mappedRecitals] of result) {
      if (articleNumber !== null) {
        expect(mappedRecitals).toHaveLength(0);
      }
    }
  });

  describe("paragraph-level linking (step 6 MVP)", () => {
    const paragraphArticles = [
      {
        article_number: "1",
        article_title: "",
        article_html:
          "<p>alphatopic content about alpha</p><p>betatopic content about beta specialword</p><p>gammatopic content about gamma</p>",
        paragraphs: [
          { number: "1", html: "<p>alphatopic content about alpha</p>" },
          { number: "2", html: "<p>betatopic content about beta specialword</p>" },
          { number: "3", html: "<p>gammatopic content about gamma</p>" },
        ],
      },
      {
        article_number: "2",
        article_title: "",
        article_html: "<p>unrelatedfiller unrelatedfiller</p>",
        paragraphs: [],
      },
    ];

    it("links a recital to the specific paragraph it clarifies, not just the article", () => {
      const result = mapRecitalsToArticles(
        [{ recital_number: "1", recital_text: "betatopic specialword" }],
        paragraphArticles
      );

      const matched = result.get("1").find((r) => r.recital_number === "1");
      expect(matched).toBeDefined();
      expect(matched.paragraph_number).toBe("2");
    });

    it("reports paragraph_number as null when the article has no structured paragraphs", () => {
      const noParagraphArticles = [
        { article_number: "1", article_title: "", article_html: "<p>sharedterm</p>", paragraphs: [] },
        { article_number: "2", article_title: "", article_html: "<p>unrelatedfiller unrelatedfiller</p>", paragraphs: [] },
      ];
      const result = mapRecitalsToArticles(
        [{ recital_number: "1", recital_text: "sharedterm" }],
        noParagraphArticles
      );

      const matched = result.get("1").find((r) => r.recital_number === "1");
      expect(matched).toBeDefined();
      expect(matched.paragraph_number).toBeNull();
    });

    it("does not invent a paragraph number for implicit chapeau content", () => {
      const mixedParagraphArticles = [
        {
          article_number: "1",
          article_title: "",
          article_html: "<p>chapeautopic introduction</p><p>numberedtopic rule</p>",
          paragraphs: [
            { number: null, html: "<p>chapeautopic introduction</p>" },
            { number: "1", html: "<p>numberedtopic rule</p>" },
          ],
        },
        {
          article_number: "2",
          article_title: "",
          article_html: "<p>unrelatedfiller unrelatedfiller</p>",
          paragraphs: [],
        },
      ];
      const result = mapRecitalsToArticles(
        [{ recital_number: "1", recital_text: "chapeautopic introduction" }],
        mixedParagraphArticles
      );

      const matched = result.get("1").find((r) => r.recital_number === "1");
      expect(matched).toBeDefined();
      expect(matched.paragraph_number).toBeNull();
    });
  });
});

describe("buildSearchIndex + searchIndex", () => {
  const data = {
    articles: [
      { article_number: "1", article_title: "Subject matter", article_html: "<p>This regulation establishes rules for artificial intelligence systems.</p>" },
      { article_number: "2", article_title: "Scope", article_html: "<p>This regulation applies to providers of AI systems placed on the market.</p>" },
    ],
    recitals: [
      { recital_number: "1", recital_html: "<p>Artificial intelligence is a fast evolving technology.</p>" },
    ],
    annexes: [],
  };

  it("builds a valid search index", () => {
    const index = buildSearchIndex(data);
    expect(index).toHaveProperty("docs");
    expect(index).toHaveProperty("idf");
    expect(index.docs.length).toBe(3); // 2 articles + 1 recital
  });

  it("finds results for relevant queries", () => {
    const index = buildSearchIndex(data);
    const results = searchIndex("artificial intelligence", index);
    expect(results.length).toBeGreaterThan(0);
  });

  it("returns empty for very short queries", () => {
    const index = buildSearchIndex(data);
    expect(searchIndex("a", index)).toEqual([]);
    expect(searchIndex("", index)).toEqual([]);
  });

  it("boosts exact article number matches", () => {
    const index = buildSearchIndex(data);
    const results = searchIndex("Article 1", index);
    // Article 1 should appear first due to ID match bonus
    if (results.length > 0) {
      expect(results[0].id).toBe("1");
    }
  });

  it("results have expected shape", () => {
    const index = buildSearchIndex(data);
    const results = searchIndex("intelligence", index);
    if (results.length > 0) {
      expect(results[0]).toHaveProperty("type");
      expect(results[0]).toHaveProperty("id");
      expect(results[0]).toHaveProperty("title");
      expect(results[0]).toHaveProperty("score");
    }
  });
});

describe("searchContent", () => {
  it("is a convenience wrapper that works end-to-end", () => {
    const data = {
      articles: [
        { article_number: "1", article_title: "Data governance framework", article_html: "<p>This regulation establishes a comprehensive data governance framework for the European Union.</p>" },
        { article_number: "2", article_title: "Scope", article_html: "<p>This regulation applies to providers of artificial intelligence systems.</p>" },
      ],
      recitals: [],
      annexes: [],
    };
    const results = searchContent("data governance framework", data);
    expect(results.length).toBeGreaterThan(0);
  });
});
