import { beforeAll, describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { isFmxDocument, parseFmxToCombined, injectCrossRefLinks } from "./fmxParser.mjs";
import { getLangConfig } from "./languages.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DGA_XML = readFileSync(resolve(__dirname, "../../../src/__fixtures__/dga.fmx.xml"), "utf-8");
const GDPR_XML = readFileSync(resolve(__dirname, "../../../src/__fixtures__/gdpr.fmx.xml"), "utf-8");
const AIA_XML = readFileSync(resolve(__dirname, "../../../src/__fixtures__/aia.fmx.xml"), "utf-8");

// ---------------------------------------------------------------------------
// isFmxDocument
// ---------------------------------------------------------------------------

describe("isFmxDocument", () => {
  it("returns true for valid FMX XML", () => {
    expect(isFmxDocument(DGA_XML)).toBe(true);
    expect(isFmxDocument(GDPR_XML)).toBe(true);
  });

  it("returns true for combined FMX documents", () => {
    expect(isFmxDocument("<COMBINED.FMX><ACT></ACT></COMBINED.FMX>")).toBe(true);
  });

  it("returns false for plain HTML", () => {
    expect(isFmxDocument("<html><body>hello</body></html>")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isFmxDocument("")).toBe(false);
  });

  it("returns false if only <ACT> without formex and ENACTING.TERMS", () => {
    expect(isFmxDocument("<ACT>some content</ACT>")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseFmxToCombined — DGA (Data Governance Act)
// ---------------------------------------------------------------------------

describe("parseFmxToCombined — DGA", () => {
  let result;
  beforeAll(() => {
    result = parseFmxToCombined(DGA_XML);
  });

  it("extracts a non-empty title", () => {
    expect(result.title).toBeTruthy();
    expect(typeof result.title).toBe("string");
  });

  it("detects English language", () => {
    expect(result.langCode).toBe("EN");
  });

  it("extracts 38 articles", () => {
    expect(result.articles).toHaveLength(38);
  });

  it("extracts recitals (at least 46)", () => {
    // The FMX document may include recitals beyond the 46 numbered ones
    expect(result.recitals.length).toBeGreaterThanOrEqual(46);
  });

  it("articles have expected shape", () => {
    const art = result.articles[0];
    expect(art).toHaveProperty("article_number");
    expect(art).toHaveProperty("article_title");
    expect(art).toHaveProperty("article_html");
    expect(art).toHaveProperty("division");
  });

  it("recitals have expected shape", () => {
    const rec = result.recitals[0];
    expect(rec).toHaveProperty("recital_number");
    expect(rec).toHaveProperty("recital_text");
    expect(rec).toHaveProperty("recital_html");
  });

  it("article numbers are sequential strings", () => {
    const nums = result.articles.map((a) => parseInt(a.article_number, 10));
    expect(nums[0]).toBe(1);
    expect(nums[nums.length - 1]).toBe(38);
  });

  it("extracts definitions from the definitions article", () => {
    expect(result.definitions.length).toBeGreaterThan(0);
    const def = result.definitions[0];
    expect(def).toHaveProperty("term");
    expect(def).toHaveProperty("definition");
    expect(def.term.length).toBeGreaterThan(0);
  });

  it("extracts cross-references", () => {
    expect(Object.keys(result.crossReferences).length).toBeGreaterThan(0);
  });

  it("cross-references include article references", () => {
    const allRefs = Object.values(result.crossReferences).flat();
    const articleRefs = allRefs.filter((r) => r.type === "article");
    expect(articleRefs.length).toBeGreaterThan(0);
  });

  it("cross-references include external law references", () => {
    const allRefs = Object.values(result.crossReferences).flat();
    const externalRefs = allRefs.filter((r) => r.type === "external");
    expect(externalRefs.length).toBeGreaterThan(0);
  });

  it("excludes self-references from cross-references", () => {
    for (const [artNum, refs] of Object.entries(result.crossReferences)) {
      if (!artNum.startsWith("recital_") && !artNum.startsWith("annex_")) {
        const selfRefs = refs.filter((r) => r.type === "article" && r.target === artNum);
        expect(selfRefs).toHaveLength(0);
      }
    }
  });

  it("articles include chapter division info", () => {
    const artWithChapter = result.articles.find((a) => a.division?.chapter?.number);
    expect(artWithChapter).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// parseFmxToCombined — GDPR
// ---------------------------------------------------------------------------

describe("parseFmxToCombined — GDPR", () => {
  let result;
  beforeAll(() => {
    result = parseFmxToCombined(GDPR_XML);
  });

  it("extracts 99 articles", () => {
    expect(result.articles).toHaveLength(99);
  });

  it("extracts 173 recitals", () => {
    expect(result.recitals).toHaveLength(173);
  });

  it("title includes GDPR or Data Protection", () => {
    expect(
      result.title.toLowerCase().includes("data protection") ||
        result.title.toLowerCase().includes("gdpr")
    ).toBe(true);
  });

  it("extracts definitions (GDPR Art 4 has 26 definitions)", () => {
    expect(result.definitions.length).toBeGreaterThanOrEqual(20);
  });

  it("definition terms include 'personal data'", () => {
    const terms = result.definitions.map((d) => d.term.toLowerCase());
    expect(terms.some((t) => t.includes("personal data"))).toBe(true);
  });

  it("recitals are sorted numerically", () => {
    const nums = result.recitals.map((r) => parseInt(r.recital_number, 10));
    for (let i = 1; i < nums.length; i += 1) {
      expect(nums[i]).toBeGreaterThanOrEqual(nums[i - 1]);
    }
  });

  it("exposes structured paragraphs alongside article_html (additive)", () => {
    for (const art of result.articles) {
      expect(Array.isArray(art.paragraphs)).toBe(true);
      expect(art).toHaveProperty("article_html");
    }
  });

  it("Article 5 (numbered PARAGs) exposes each paragraph with its number", () => {
    const art5 = result.articles.find((a) => a.article_number === "5");
    expect(art5.paragraphs.length).toBeGreaterThanOrEqual(2);
    const numbers = art5.paragraphs.map((p) => p.number);
    expect(numbers).toContain("1");
    expect(numbers).toContain("2");
    for (const p of art5.paragraphs) {
      expect(typeof p.html).toBe("string");
      expect(p.html.length).toBeGreaterThan(0);
    }
  });

  it("paragraph HTML for Article 5 does not leak between paragraphs", () => {
    const art5 = result.articles.find((a) => a.article_number === "5");
    const p1 = art5.paragraphs.find((p) => p.number === "1");
    const p2 = art5.paragraphs.find((p) => p.number === "2");
    expect(p1.html).not.toBe(p2.html);
  });
});

// ---------------------------------------------------------------------------
// parseFmxToCombined — AI Act (Combined FMX with annexes)
// ---------------------------------------------------------------------------

describe("parseFmxToCombined — AI Act", () => {
  let result;
  beforeAll(() => {
    result = parseFmxToCombined(AIA_XML);
  });

  it("detects as valid FMX document (COMBINED.FMX format)", () => {
    expect(isFmxDocument(AIA_XML)).toBe(true);
    expect(AIA_XML).toContain("<COMBINED.FMX");
  });

  it("extracts a title containing 'Artificial Intelligence'", () => {
    expect(result.title.toLowerCase()).toContain("artificial intelligence");
  });

  it("detects English language", () => {
    expect(result.langCode).toBe("EN");
  });

  it("extracts 113 articles", () => {
    expect(result.articles).toHaveLength(113);
  });

  it("extracts 180 recitals", () => {
    expect(result.recitals).toHaveLength(180);
  });

  it("extracts 13 annexes", () => {
    expect(result.annexes).toHaveLength(13);
  });

  it("an article with no PARAG elements still exposes a single implicit paragraph", () => {
    // Article 3 (Definitions) in the AI Act fixture has no numbered PARAGs —
    // its content is direct ALINEA/LIST children of <ARTICLE>.
    const art3 = result.articles.find((a) => a.article_number === "3");
    expect(art3.paragraphs).toHaveLength(1);
    expect(art3.paragraphs[0].number).toBeNull();
    expect(art3.paragraphs[0].html.length).toBeGreaterThan(0);
    // article_html contract must stay untouched by the additive paragraphs field
    expect(art3.article_html).not.toMatch(/<PARAG\b/);
    expect(art3.article_html).not.toMatch(/<ARTICLE\b/);
  });

  it("annexes have expected shape", () => {
    const annex = result.annexes[0];
    expect(annex).toHaveProperty("annex_id");
    expect(annex).toHaveProperty("annex_title");
    expect(annex).toHaveProperty("annex_html");
    expect(annex.annex_id).toBeTruthy();
  });

  it("annex IDs use Roman numerals", () => {
    const ids = result.annexes.map((a) => a.annex_id);
    expect(ids).toContain("I");
    expect(ids).toContain("II");
    expect(ids).toContain("III");
  });

  it("annexes contain non-empty HTML", () => {
    for (const annex of result.annexes) {
      expect(annex.annex_html.length, `Annex ${annex.annex_id} should have HTML`).toBeGreaterThan(0);
    }
  });

  it("article numbers cover 1 through 113", () => {
    const nums = result.articles.map((a) => parseInt(a.article_number, 10));
    expect(nums[0]).toBe(1);
    expect(nums[nums.length - 1]).toBe(113);
    const uniqueNums = new Set(nums);
    expect(uniqueNums.size).toBe(113);
  });

  it("extracts definitions (AI Act Art 3 has 60+ definitions)", () => {
    expect(result.definitions.length).toBeGreaterThanOrEqual(50);
  });

  it("definition terms include 'AI system' or 'artificial intelligence system'", () => {
    const terms = result.definitions.map((d) => d.term.toLowerCase());
    expect(
      terms.some((t) => t.includes("ai system") || t.includes("artificial intelligence"))
    ).toBe(true);
  });

  it("definitions include 'provider'", () => {
    const terms = result.definitions.map((d) => d.term.toLowerCase());
    expect(terms.some((t) => t.includes("provider"))).toBe(true);
  });

  it("definitions include 'deployer'", () => {
    const terms = result.definitions.map((d) => d.term.toLowerCase());
    expect(terms.some((t) => t.includes("deployer"))).toBe(true);
  });

  it("articles have chapter hierarchy (AI Act has 13 chapters)", () => {
    const chapters = new Set();
    for (const art of result.articles) {
      if (art.division?.chapter?.number) {
        chapters.add(art.division.chapter.number);
      }
    }
    expect(chapters.size).toBeGreaterThanOrEqual(10);
  });

  it("some articles have section divisions within chapters", () => {
    const withSection = result.articles.filter((a) => a.division?.section?.number);
    expect(withSection.length).toBeGreaterThan(0);
  });

  it("cross-references include references to GDPR (Regulation 2016/679)", () => {
    const allRefs = Object.values(result.crossReferences).flat();
    const gdprRefs = allRefs.filter(
      (r) => r.type === "external" && r.target && r.target.includes("2016/679")
    );
    expect(gdprRefs.length).toBeGreaterThan(0);
  });

  it("cross-references include annex references", () => {
    const annexKeys = Object.keys(result.crossReferences).filter((k) => k.startsWith("annex_"));
    expect(annexKeys.length).toBeGreaterThan(0);
  });

  it("cross-references include recital references", () => {
    const recitalKeys = Object.keys(result.crossReferences).filter((k) => k.startsWith("recital_"));
    expect(recitalKeys.length).toBeGreaterThan(0);
  });

  it("article HTML contains cross-ref links", () => {
    const articlesWithCrossRefs = result.articles.filter(
      (a) => a.article_html.includes('class="cross-ref"') || a.article_html.includes('class="external-ref"')
    );
    expect(articlesWithCrossRefs.length).toBeGreaterThan(0);
  });

  it("recitals are sorted numerically 1 to 180", () => {
    const nums = result.recitals.map((r) => parseInt(r.recital_number, 10));
    for (let i = 1; i < nums.length; i += 1) {
      expect(nums[i]).toBeGreaterThanOrEqual(nums[i - 1]);
    }
    expect(nums[0]).toBe(1);
    expect(nums[nums.length - 1]).toBe(180);
  });

  it("no annexes are empty stubs", () => {
    for (const annex of result.annexes) {
      expect(annex.annex_title, `Annex ${annex.annex_id} needs a title`).toBeTruthy();
    }
  });

  it("article HTML does not contain raw XML tags", () => {
    for (const art of result.articles) {
      expect(art.article_html).not.toMatch(/<ARTICLE\b/);
      expect(art.article_html).not.toMatch(/<PARAG\b/);
      expect(art.article_html).not.toMatch(/<ALINEA\b/);
      expect(art.article_html).not.toMatch(/<TXT\b/);
    }
  });
});

// ---------------------------------------------------------------------------
// parseFmxToCombined — error handling
// ---------------------------------------------------------------------------

describe("parseFmxToCombined — error handling", () => {
  it("throws on malformed XML", () => {
    expect(() => parseFmxToCombined("<ACT><broken")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// parseFmxToCombined — paragraph numbering fallback
// ---------------------------------------------------------------------------

describe("parseFmxToCombined — unnumbered PARAG numbering", () => {
  const wrap = (articleXml) => `<ACT xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://formex.publications.europa.eu/schema/formex-05.59-20170418.xd"><BIB.INSTANCE><LG.DOC>EN</LG.DOC></BIB.INSTANCE><ENACTING.TERMS><DIVISION>${articleXml}</DIVISION></ENACTING.TERMS></ACT>`;

  it("numbers the first unnumbered PARAG '1' even after an implicit chapeau ALINEA", () => {
    // A chapeau ALINEA before the first PARAG produces an implicit
    // (number: null) paragraph that must not consume a numbering slot from
    // the fallback counter used for unnumbered PARAG elements.
    const xml = wrap(
      `<ARTICLE IDENTIFIER="001"><TI.ART>Article 1</TI.ART>` +
      `<ALINEA><P>Intro chapeau.</P></ALINEA>` +
      `<PARAG><P>Unnumbered body.</P></PARAG>` +
      `</ARTICLE>`
    );
    const result = parseFmxToCombined(xml);
    const art1 = result.articles.find((a) => a.article_number === "1");
    expect(art1.paragraphs).toHaveLength(2);
    expect(art1.paragraphs[0].number).toBeNull();
    expect(art1.paragraphs[1].number).toBe("1");
  });

  it("numbers two consecutive unnumbered PARAGs 1, 2 when there is no chapeau", () => {
    const xml = wrap(
      `<ARTICLE IDENTIFIER="001"><TI.ART>Article 1</TI.ART>` +
      `<PARAG><P>First unnumbered body.</P></PARAG>` +
      `<PARAG><P>Second unnumbered body.</P></PARAG>` +
      `</ARTICLE>`
    );
    const result = parseFmxToCombined(xml);
    const art1 = result.articles.find((a) => a.article_number === "1");
    expect(art1.paragraphs).toHaveLength(2);
    expect(art1.paragraphs[0].number).toBe("1");
    expect(art1.paragraphs[1].number).toBe("2");
  });
});

// ---------------------------------------------------------------------------
// injectCrossRefLinks
// ---------------------------------------------------------------------------
// parseFmxToCombined — legacy v2 body container (<CONTENTS> without <ENACTING.TERMS>)
// ---------------------------------------------------------------------------

describe("parseFmxToCombined — v2 CONTENTS body fallback", () => {
  // Formex v2 (schema 02.00, <GENERAL> root — e.g. Directive 2004/18/EC) has no
  // <ENACTING.TERMS>; the operative body sits under a top-level <CONTENTS>.
  it("extracts articles from a <CONTENTS> body when there is no ENACTING.TERMS", () => {
    const xml =
      `<GENERAL xsi:noNamespaceSchemaLocation="http://formex.publications.eu.int/schema/formex-02.00-20050101.xd" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
      `<BIB.INSTANCE><LG.DOC>EN</LG.DOC></BIB.INSTANCE>` +
      `<CONTENTS>` +
      `<DIVISION><ARTICLE IDENTIFIER="001"><TI.ART>Article 1</TI.ART><ALINEA><P>First provision.</P></ALINEA></ARTICLE></DIVISION>` +
      `<DIVISION><ARTICLE IDENTIFIER="002"><TI.ART>Article 2</TI.ART><ALINEA><P>Second provision.</P></ALINEA></ARTICLE></DIVISION>` +
      `</CONTENTS>` +
      `<ANNEX><CONTENTS><DIVISION><ARTICLE IDENTIFIER="A01"><TI.ART>Article 1</TI.ART><ALINEA><P>Annex article, must be ignored.</P></ALINEA></ARTICLE></DIVISION></CONTENTS></ANNEX>` +
      `</GENERAL>`;
    const result = parseFmxToCombined(xml);
    // The two body articles are picked up; the annex's own <CONTENTS> is excluded.
    expect(result.articles).toHaveLength(2);
    expect(result.articles.map((a) => a.article_number)).toEqual(["1", "2"]);
  });
});

// ---------------------------------------------------------------------------

describe("injectCrossRefLinks", () => {
  const lang = getLangConfig("EN");

  it("wraps Article references as links", () => {
    const html = "<p>See Article 5 for details.</p>";
    const result = injectCrossRefLinks(html, lang);
    expect(result).toContain('class="cross-ref"');
    expect(result).toContain('data-ref-article="5"');
    expect(result).toContain('href="#article-5"');
  });

  it("wraps external law references as links", () => {
    const html = "<p>As defined in Regulation (EU) 2016/679.</p>";
    const result = injectCrossRefLinks(html, lang);
    expect(result).toContain('class="external-ref"');
    expect(result).toContain('target="_blank"');
  });

  it("prefers the external act when an article reference is qualified by it", () => {
    const html = "<p>See Article 4(3) of Regulation (EC) No 300/2008.</p>";
    const result = injectCrossRefLinks(html, lang);
    expect(result).toContain('class="external-ref"');
    expect(result).toContain('data-ref-article="4"');
    expect(result).not.toContain('href="#article-4"');
  });

  it("returns empty/falsy html unchanged", () => {
    expect(injectCrossRefLinks("", lang)).toBe("");
    expect(injectCrossRefLinks(null, lang)).toBe(null);
  });

  it("does not double-wrap existing links", () => {
    const html = '<p><a class="cross-ref" href="#article-5">Article 5</a> and Article 6</p>';
    const result = injectCrossRefLinks(html, lang);
    const matches = result.match(/class="cross-ref"/g);
    expect(matches).toHaveLength(2);
  });

  it("handles German article references", () => {
    const deLang = getLangConfig("DE");
    const html = "<p>Siehe Artikel 12 für Details.</p>";
    const result = injectCrossRefLinks(html, deLang);
    expect(result).toContain('data-ref-article="12"');
  });
});
