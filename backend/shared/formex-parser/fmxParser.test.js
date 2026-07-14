import { beforeAll, describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { isFmxDocument, parseFmxToCombined, injectCrossRefLinks, extractCrossRefsFromText } from "./fmxParser.mjs";
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
  // Parsing a full-size act is jsdom-heavy (~seconds); give the hook headroom so
  // it doesn't flake against the 10s default under parallel-test CPU contention.
  beforeAll(() => {
    result = parseFmxToCombined(GDPR_XML);
  }, 60000);

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

  it("binds competition articles in recital 150 to the TFEU", () => {
    const refs = result.crossReferences.recital_150 || [];
    const treatyArticles = refs.filter((ref) => ref.actCelex === "12012E" && ref.articleNumber);
    expect(treatyArticles.map((ref) => ref.articleNumber)).toEqual(["101", "102"]);
    expect(refs.some((ref) => ref.type === "article" && ["101", "102"].includes(ref.target))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseFmxToCombined — AI Act (Combined FMX with annexes)
// ---------------------------------------------------------------------------

describe("parseFmxToCombined — AI Act", () => {
  let result;
  // The AI Act is the largest fixture; jsdom-heavy parse can approach the 10s
  // default hook timeout under parallel-test load, so give it headroom.
  beforeAll(() => {
    result = parseFmxToCombined(AIA_XML);
  }, 60000);

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

  it("binds specific GDPR articles to the act, incl. the Article 6 edge", () => {
    // The AI Act cites "Article 6(4) and Article 9(2), point (g), of Regulation
    // (EU) 2016/679". Both articles must bind to GDPR as distinct edges — the old
    // parser produced no AI-Act→GDPR-Article-6 edge (only the nearest article, if
    // any, bound and the dedup key collapsed the rest).
    const gdprArticleRefs = Object.values(result.crossReferences)
      .flat()
      .filter((r) => r.type === "external" && r.target?.includes("2016/679") && r.articleNumber);
    const articleNumbers = new Set(gdprArticleRefs.map((r) => r.articleNumber));
    expect(articleNumbers.has("6")).toBe(true);
    // More than one distinct GDPR article should be linked (6 and 9 at minimum).
    expect(articleNumbers.size).toBeGreaterThan(1);
  });

  it("preserves AI Act recital 40 paragraph ranges and named points", () => {
    const refs = result.crossReferences.recital_40 || [];
    const article5 = refs.filter((ref) => (
      (ref.type === "article" && ref.target === "5") || ref.articleNumber === "5"
    ));
    expect(article5.some((ref) => ref.paragraph === "1" && ref.point === "g")).toBe(true);
    expect(article5.filter((ref) => ["2", "3", "4", "5", "6"].includes(ref.paragraph)).map((ref) => ref.paragraph))
      .toEqual(["2", "3", "4", "5", "6"]);
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

describe("parseFmxToCombined — unnumbered PROLOG decisions", () => {
  it("retains and cites a decision whose only published body is PROLOG", () => {
    const xml =
      `<FMX.COLLECTION><GENERAL><BIB.INSTANCE><LG.DOC>EN</LG.DOC></BIB.INSTANCE>` +
      `<PROLOG><P>The Commission adopted a Decision under Council Regulation (EEC) No 4064/89, and in particular Article 8(2) of that Regulation.</P></PROLOG>` +
      `</GENERAL></FMX.COLLECTION>`;
    const result = parseFmxToCombined(xml);
    const text = result.articles[0];

    expect(result.articles).toHaveLength(1);
    expect(text).toMatchObject({
      article_number: "text",
      display_label: "Decision text",
      is_unnumbered: true,
    });
    expect(text.article_html).toContain('data-ref-act-type="regulation"');
    expect(result.crossReferences.text.some((ref) => ref.actCelex === "31989R4064")).toBe(true);
  });

  it("retains direct CONTENTS when it has no ARTICLE children", () => {
    const xml =
      `<FMX.COLLECTION><GENERAL><BIB.INSTANCE><LG.DOC>EN</LG.DOC></BIB.INSTANCE>` +
      `<CONTENTS><P>The Decision applies Article 81 of the EC Treaty and Article 9(1) of Council Regulation (EC) No 1/2003.</P></CONTENTS>` +
      `</GENERAL></FMX.COLLECTION>`;
    const result = parseFmxToCombined(xml);

    expect(result.articles).toHaveLength(1);
    expect(result.articles[0]).toMatchObject({ article_number: "text", is_unnumbered: true });
    expect(result.crossReferences.text.some((ref) => ref.actCelex === "32003R0001")).toBe(true);
    expect(result.crossReferences.text.some((ref) => ref.actCelex === "12002E")).toBe(true);
  });

  it("retains competition-decision summaries structured as grouped sequences", () => {
    const xml =
      `<FMX.COLLECTION><GENERAL><BIB.INSTANCE><LG.DOC>EN</LG.DOC></BIB.INSTANCE>` +
      `<ENACTING.TERMS><GR.SEQ LEVEL="1"><TITLE><TI><NP><NO.P>1.</NO.P><TXT>SUMMARY OF THE DECISION</TXT></NP></TI></TITLE>` +
      `<P>The Commission found an infringement of Article 81 of the EC Treaty.</P></GR.SEQ></ENACTING.TERMS>` +
      `</GENERAL></FMX.COLLECTION>`;
    const result = parseFmxToCombined(xml);

    expect(result.articles).toHaveLength(1);
    expect(result.articles[0]).toMatchObject({ article_number: "text", is_unnumbered: true });
    expect(result.articles[0].article_html).toMatch(/SUMMARY OF THE DECISION/);
    expect(result.crossReferences.text.some((ref) => ref.actCelex === "12002E")).toBe(true);
  });

  it("retains competition summaries structured in preamble considerations", () => {
    const xml =
      `<FMX.COLLECTION><GENERAL><BIB.INSTANCE><LG.DOC>EN</LG.DOC></BIB.INSTANCE>` +
      `<PREAMBLE><GR.CONSID><DIV.CONSID><TITLE><TI><NP><NO.P>1.</NO.P><TXT>SUMMARY OF THE INFRINGEMENT</TXT></NP></TI></TITLE>` +
      `<CONSID><NP><NO.P>(1)</NO.P><TXT>The decision concerns Article 81 of the EC Treaty.</TXT></NP></CONSID>` +
      `</DIV.CONSID></GR.CONSID></PREAMBLE></GENERAL></FMX.COLLECTION>`;
    const result = parseFmxToCombined(xml);

    expect(result.articles).toHaveLength(1);
    expect(result.articles[0]).toMatchObject({ article_number: "text", is_unnumbered: true });
    expect(result.articles[0].article_html).toMatch(/SUMMARY OF THE INFRINGEMENT/);
    expect(result.crossReferences.text.some((ref) => ref.actCelex === "12002E")).toBe(true);
  });
});

describe("extractCrossRefsFromText — multilingual instruments", () => {
  it("resolves an accented French historical EEC regulation", () => {
    const refs = extractCrossRefsFromText("voir le règlement (CEE) no 2782/76", getLangConfig("FR"));
    expect(refs).toContainEqual(expect.objectContaining({
      actType: "regulation",
      actCelex: "31976R2782",
    }));
  });

  it("keeps Joint Committee recommendations explicitly external", () => {
    const refs = extractCrossRefsFromText(
      "the amendment is the subject of recommendation 1/77 of the Joint Committee set up under that Agreement",
      getLangConfig("EN"),
    );
    expect(refs).toContainEqual(expect.objectContaining({
      target: "1/77",
      actType: "recommendation",
      actCelex: null,
      externalInstitutional: true,
    }));
  });

  it("recognises party-prefixed Joint Committee recommendations as external", () => {
    const refs = extractCrossRefsFromText(
      "Recommendation 1/79 of the EEC-Austria Joint Committee - Community transit",
      getLangConfig("EN"),
    );
    expect(refs).toContainEqual(expect.objectContaining({
      target: "1/79",
      actCelex: null,
      externalInstitutional: true,
    }));
  });

  it("recognises Association Council decisions as external", () => {
    const refs = extractCrossRefsFromText(
      "Association Council Decision 4/72, as amended by Decision 1/75",
      getLangConfig("EN"),
    );
    expect(refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: "4/72", externalInstitutional: true, actCelex: null }),
      expect.objectContaining({ target: "1/75", externalInstitutional: true, actCelex: null }),
    ]));
  });

  it("keeps Court decision citations out of the sector-3 act resolver", () => {
    const refs = extractCrossRefsFromText(
      "the decision of the Court in the case AEG emphasized paragraph 37 of Decision 107/82 of 25 October 1983",
      getLangConfig("EN"),
    );
    expect(refs).toContainEqual(expect.objectContaining({
      target: "107/82",
      externalCaseLaw: true,
      actCelex: null,
    }));
  });

  it("keeps expressly regional instruments external to EU law", () => {
    const refs = extractCrossRefsFromText(
      "Law No 51 of the region of Lombardy and Decision No 11/21587 of the regional government",
      getLangConfig("EN"),
    );
    expect(refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ raw: "Law No 51", nationalLaw: true, actCelex: null }),
      expect.objectContaining({ raw: "Decision No 11/21587", externalNational: true, actCelex: null }),
    ]));
  });

  it("repairs a footnote digit flattened onto a four-digit instrument year", () => {
    const refs = extractCrossRefsFromText("Regulation (EC) No 1864/20042", getLangConfig("EN"));
    expect(refs).toContainEqual(expect.objectContaining({
      raw: "Regulation (EC) No 1864/20042",
      target: "1864/2004",
      actCelex: "32004R1864",
    }));
  });

  it("repairs a two-digit year split across adjacent old HTML fragments", () => {
    const refs = extractCrossRefsFromText("Council Regulation (EEC) No 2894/7 // 9 ,", getLangConfig("EN"));
    expect(refs).toContainEqual(expect.objectContaining({
      raw: "Regulation (EEC) No 2894/7",
      target: "2894/79",
      actCelex: "31979R2894",
    }));
  });

  it("repairs a split year immediately followed by a footnote marker", () => {
    const refs = extractCrossRefsFromText("Regulation (EEC) No 2192/8 1 (4)", getLangConfig("EN"));
    expect(refs).toContainEqual(expect.objectContaining({
      target: "2192/81",
      actCelex: "31981R2192",
    }));
  });

  it("resolves historical regulations with a trailing EEC suffix", () => {
    const refs = extractCrossRefsFromText("Regulation 3286/80/EEC", getLangConfig("EN"));
    expect(refs).toContainEqual(expect.objectContaining({
      actCelex: "31980R3286",
    }));
  });

  it("resolves old year-first decisions with four-digit numbers", () => {
    const refs = extractCrossRefsFromText("Decision No 80/1186/EEC", getLangConfig("EN"));
    expect(refs).toContainEqual(expect.objectContaining({
      actCelex: "31980D1186",
    }));
  });

  it("resolves modern year-first decisions that retain a No label", () => {
    const refs = extractCrossRefsFromText("Decision No 2005/802/EC", getLangConfig("EN"));
    expect(refs).toContainEqual(expect.objectContaining({
      actCelex: "32005D0802",
    }));
  });

  it("uses an explicit Council issuer for historical number-first regulations", () => {
    const refs = extractCrossRefsFromText("Council Regulation 3448/93", getLangConfig("EN"));
    expect(refs).toContainEqual(expect.objectContaining({
      actCelex: "31993R3448",
    }));
  });

  it("carries an explicit Commission issuer to a same-sentence short-form repeat", () => {
    const refs = extractCrossRefsFromText(
      "Commission Regulation 1636/98, hereinafter Regulation 1636/98, applies.",
      getLangConfig("EN"),
    );
    // Identical citations share one graph edge, but the short form must not
    // displace the fully resolved citation that precedes it.
    expect(refs.filter((ref) => ref.target === "1636/98")).toEqual([
      expect.objectContaining({ actCelex: "31998R1636" }),
    ]);
  });

  it("recognises Estonian and Greek directive labels in multilingual annexes", () => {
    const estonian = extractCrossRefsFromText("direktiivis 90/426/EMÜ", getLangConfig("EN"));
    const greek = extractCrossRefsFromText("οδηγία 90/426/ΕΟΚ", getLangConfig("EN"));
    expect(estonian).toContainEqual(expect.objectContaining({ actCelex: "31990L0426" }));
    expect(greek).toContainEqual(expect.objectContaining({ actCelex: "31990L0426" }));
  });

  it("recognises multilingual directive and decision labels in annex copies", () => {
    const directives = extractCrossRefsFromText("Direktīvas 97/78/EK", getLangConfig("EN"));
    const decisions = extractCrossRefsFromText("décision 93/352/CEE; απόφαση 2003/630; Decisiones 2003/630/CE; päätös 2003/630/EY", getLangConfig("EN"));
    expect(directives).toContainEqual(expect.objectContaining({ actCelex: "31978L0097" }));
    expect(decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ actCelex: "31993D0352" }),
      expect.objectContaining({ actCelex: "32003D0630" }),
    ]));
  });

  it("resolves an explicit High Authority recommendation as an ECSC act", () => {
    const refs = extractCrossRefsFromText("High Authority recommendation 1/64", getLangConfig("EN"));
    expect(refs).toContainEqual(expect.objectContaining({
      actCelex: "31964S0001",
      ecscAuthority: true,
    }));
  });

  it("uses an explicit Council issuer to disambiguate number-first regulations", () => {
    const refs = extractCrossRefsFromText("Council Regulation 2040/2000", getLangConfig("EN"));
    expect(refs).toContainEqual(expect.objectContaining({
      actCelex: "32000R2040",
    }));
  });
});

describe("parseFmxToCombined — amendment scope", () => {
  it("attributes bare replacement-article references to the act named in the heading", () => {
    const articles =
      `<ARTICLE IDENTIFIER="001"><TI.ART>Article 1</TI.ART>` +
      `<STI.ART>Amendments to Directive 2002/22/EC</STI.ART>` +
      `<ALINEA><P>Directive 2002/22/EC is amended as follows: Article 7 is replaced; Article 23a is inserted.</P></ALINEA>` +
      `</ARTICLE>` +
      `<ARTICLE IDENTIFIER="002"><TI.ART>Article 2</TI.ART><ALINEA><P>Entry into force.</P></ALINEA></ARTICLE>`;
    const xml = `<ACT xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://formex.publications.europa.eu/schema/formex-05.59-20170418.xd"><BIB.INSTANCE><LG.DOC>EN</LG.DOC></BIB.INSTANCE><ENACTING.TERMS><DIVISION>${articles}</DIVISION></ENACTING.TERMS></ACT>`;
    const refs = parseFmxToCombined(xml).crossReferences["1"];
    const scoped = refs.filter((ref) => ref.amendmentScope);
    expect(scoped.map((ref) => ref.articleNumber)).toEqual(["7", "23a"]);
    expect(scoped.every((ref) => ref.actCelex === "32002L0022")).toBe(true);
    expect(refs.some((ref) => ref.type === "article" && ["7", "23a"].includes(ref.target))).toBe(false);
  });
});

describe("parseFmxToCombined — correlation tables", () => {
  it("does not turn ambiguous old-act cells into broken internal links", () => {
    const xml =
      `<ACT xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://formex.publications.europa.eu/schema/formex-05.59-20170418.xd">` +
      `<BIB.INSTANCE><LG.DOC>EN</LG.DOC></BIB.INSTANCE>` +
      `<ENACTING.TERMS><DIVISION><ARTICLE IDENTIFIER="001"><TI.ART>Article 1</TI.ART><ALINEA><P>Body.</P></ALINEA></ARTICLE></DIVISION></ENACTING.TERMS>` +
      `<ANNEX><TITLE><TI><NP><TXT>ANNEX I</TXT></NP></TI><STI><P>Correlation table</P></STI></TITLE>` +
      `<CONTENTS><P>Directive 89/552/EEC This Directive Article 10a Article 1</P></CONTENTS></ANNEX>` +
      `</ACT>`;
    const result = parseFmxToCombined(xml);
    const refs = result.crossReferences.annex_I;
    expect(refs.some((ref) => ref.type === "article" && ref.target === "10a")).toBe(false);
    expect(refs.some((ref) => ref.actCelex === "31989L0552")).toBe(true);
    expect(result.annexes[0].annex_html).toContain("Article 10a");
    expect(result.annexes[0].annex_html).not.toContain('href="#article-10a"');
    expect(result.annexes[0].annex_html).toContain('href="#article-1"');
  });
});

describe("parseFmxToCombined — internal-link integrity", () => {
  it("leaves absent article targets as plain text", () => {
    const xml =
      `<ACT xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://formex.publications.europa.eu/schema/formex-05.59-20170418.xd">` +
      `<BIB.INSTANCE><LG.DOC>EN</LG.DOC></BIB.INSTANCE><ENACTING.TERMS><DIVISION>` +
      `<ARTICLE IDENTIFIER="001"><TI.ART>Article 1</TI.ART><ALINEA><P>See Article 99.</P></ALINEA></ARTICLE>` +
      `</DIVISION></ENACTING.TERMS></ACT>`;
    const result = parseFmxToCombined(xml);
    expect(result.articles[0].article_html).toContain("Article 99");
    expect(result.articles[0].article_html).not.toContain('href="#article-99"');
    expect(result.crossReferences["1"]).toBeUndefined();
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

  const articleLinkTargets = (html) =>
    [...injectCrossRefLinks(html, lang).matchAll(/data-ref-article="(\d+)"/g)].map((m) => m[1]);

  it("links every member of a comma-separated article list to the act", () => {
    const html = "<p>Articles 15, 16 and 17 of Regulation (EU) 2016/679 shall apply.</p>";
    const result = injectCrossRefLinks(html, lang);
    expect(articleLinkTargets(html).sort()).toEqual(["15", "16", "17"]);
    // Each list member links to the external act, not an internal anchor.
    expect(result).not.toContain('href="#article-15"');
    expect(result).toContain('data-ref-year="2016"');
  });

  it("links both endpoints of an article range", () => {
    const html = "<p>as set out in Articles 12 to 22 of Regulation (EU) 2016/679.</p>";
    expect(articleLinkTargets(html).sort()).toEqual(["12", "22"]);
  });

  it("links each coordinated article bound to one act", () => {
    const html = "<p>Article 6(4) and Article 9(2), point (g), of Regulation (EU) 2016/679.</p>";
    const result = injectCrossRefLinks(html, lang);
    expect(articleLinkTargets(html).sort()).toEqual(["6", "9"]);
    expect(result).toContain('data-ref-point="g"');
  });

  it("links both coordinated internal articles (not just the first)", () => {
    const html = "<p>governed by Article 5 and Article 6 of this Regulation.</p>";
    const result = injectCrossRefLinks(html, lang);
    expect(articleLinkTargets(html).sort()).toEqual(["5", "6"]);
    // Internal references keep the in-document anchor.
    expect(result).toContain('href="#article-5"');
    expect(result).toContain('href="#article-6"');
  });
});

describe("extractCrossRefsFromText — multi-article citations", () => {
  const lang = getLangConfig("EN");

  const gdprRefs = (text) =>
    extractCrossRefsFromText(text, lang)
      .filter((r) => r.type === "external" && r.target === "2016/679" && r.articleNumber);

  it("binds every coordinated article to one external act (AI Act GDPR case)", () => {
    const refs = gdprRefs(
      "in accordance with Article 6(4) and Article 9(2), point (g), of Regulation (EU) 2016/679"
    );
    const byArticle = Object.fromEntries(refs.map((r) => [r.articleNumber, r]));
    expect(Object.keys(byArticle).sort()).toEqual(["6", "9"]);
    expect(byArticle["6"].paragraph).toBe("4");
    expect(byArticle["9"].paragraph).toBe("2");
    expect(byArticle["9"].point).toBe("g"); // ", point (g)" is captured
    expect(refs.every((ref) => ref.actCelex === "32016R0679")).toBe(true);
  });

  it("expands comma lists to individual article edges", () => {
    const refs = gdprRefs("Articles 15, 16 and 17 of Regulation (EU) 2016/679 shall apply");
    expect(refs.map((r) => r.articleNumber).sort()).toEqual(["15", "16", "17"]);
  });

  it("expands article ranges", () => {
    const refs = gdprRefs("as referred to in Articles 12 to 22 of Regulation (EU) 2016/679");
    expect(refs).toHaveLength(11);
    expect(refs.map((r) => r.articleNumber)).toContain("12");
    expect(refs.map((r) => r.articleNumber)).toContain("22");
  });

  it("keeps distinct articles of the same act as separate edges (dedup key)", () => {
    // Both bind to GDPR; the old dedup key omitted articleNumber and collapsed them.
    const refs = gdprRefs("Article 6 and Article 9 of Regulation (EU) 2016/679");
    expect(new Set(refs.map((r) => r.articleNumber)).size).toBe(2);
  });

  it("binds each article to its own act in 'Art A of X and Art B of Y'", () => {
    const refs = extractCrossRefsFromText(
      "Article 5 of Directive 2002/58/EC and Article 8 of Directive 95/46/EC",
      lang
    ).filter((r) => r.type === "external");
    const map = Object.fromEntries(refs.map((r) => [r.articleNumber, r.target]));
    expect(map["5"]).toBe("2002/58/EC");
    expect(map["8"]).toBe("95/46/EC");
    expect(refs.find((r) => r.articleNumber === "5")?.actCelex).toBe("32002L0058");
    expect(refs.find((r) => r.articleNumber === "8")?.actCelex).toBe("31995L0046");
  });

  it("uses language grammar adapters for non-English lists and ranges", () => {
    const german = extractCrossRefsFromText(
      "Artikel 5 und 6 der Richtlinie 2002/58/EG",
      getLangConfig("DE"),
    ).filter((r) => r.type === "external" && r.articleNumber);
    expect(german.map((r) => r.articleNumber)).toEqual(["5", "6"]);
    expect(german.every((r) => r.actCelex === "32002L0058")).toBe(true);

    const french = extractCrossRefsFromText(
      "Articles 5 à 7 de la Directive 2002/58/CE",
      getLangConfig("FR"),
    ).filter((r) => r.type === "external" && r.articleNumber);
    expect(french.map((r) => r.articleNumber)).toEqual(["5", "6", "7"]);
    expect(french.every((r) => r.actCelex === "32002L0058")).toBe(true);

    const additional = [
      ["PL", "Artykuły 5 i 6 dyrektywy 2002/58/WE"],
      ["CS", "Články 5 a 6 směrnice 2002/58/ES"],
      ["SV", "Artiklar 5 och 6 i Direktiv 2002/58/EG"],
      ["RO", "Articolele 5 și 6 din Directiva 2002/58/CE"],
    ];
    for (const [code, text] of additional) {
      const refs = extractCrossRefsFromText(text, getLangConfig(code))
        .filter((r) => r.type === "external" && r.articleNumber);
      expect(refs.map((r) => r.articleNumber), code).toEqual(["5", "6"]);
      expect(refs.every((r) => r.actCelex === "32002L0058"), code).toBe(true);
    }
  });

  it("normalizes pre-1999 No number/year regulations without confusing the number for a year", () => {
    const [ref] = extractCrossRefsFromText(
      "Article 10 of Regulation (EEC) No 2306/70",
      lang,
    ).filter((item) => item.type === "external");

    expect(ref.year).toBe("1970");
    expect(ref.number).toBe("2306");
    expect(ref.actCelex).toBe("31970R2306");
  });

  it("accepts spaced legacy parentheticals and the abbreviated N marker", () => {
    const [ref] = extractCrossRefsFromText(
      "ARTICLE 10 OF REGULATION ( EEC ) N 2306/70",
      lang,
    ).filter((item) => item.type === "external");
    expect(ref).toMatchObject({
      articleNumber: "10",
      year: "1970",
      number: "2306",
      actCelex: "31970R2306",
    });
  });

  it("uses the F descriptor for Framework Decisions", () => {
    const [ref] = extractCrossRefsFromText(
      "Article 2 of Framework Decision 2002/584/JHA",
      lang,
    ).filter((item) => item.type === "external");
    expect(ref).toMatchObject({
      articleNumber: "2",
      actType: "framework decision",
      actCelex: "32002F0584",
    });
  });

  it("binds treaty and contextual articles instead of emitting broken internal targets", () => {
    const treatyRefs = extractCrossRefsFromText("Articles 101 and 102 TFEU", lang);
    expect(treatyRefs.filter((r) => r.type === "article")).toHaveLength(0);
    expect(treatyRefs.filter((r) => r.articleNumber).map((r) => r.articleNumber)).toEqual(["101", "102"]);
    expect(treatyRefs.filter((r) => r.articleNumber).every((r) => r.actCelex === "12012E")).toBe(true);

    const contextual = extractCrossRefsFromText("Article 23 of that Directive", lang);
    expect(contextual).toHaveLength(1);
    expect(contextual[0]).toMatchObject({
      type: "external",
      articleNumber: "23",
      actType: "directive",
      contextual: true,
    });
  });

  it("hydrates said-act references from an explicit antecedent in the same sentence", () => {
    const refs = extractCrossRefsFromText(
      "Article 21 of Directive 75/319/EEC applies in the procedures in Article 25 of the said Directive",
      lang,
    );
    const article25 = refs.find((ref) => ref.articleNumber === "25");
    expect(article25).toMatchObject({
      type: "external",
      actCelex: "31975L0319",
      articleNumber: "25",
      contextual: true,
    });
  });

  it("binds repeated referred-to-in definitions to their trailing common act", () => {
    const refs = extractCrossRefsFromText(
      "the approach referred to in Article 143(1), the model referred to in Article 221, "
      + "and the method referred to in Articles 283 and 363 of Regulation (EU) No 575/2013",
      lang,
    );
    const articles = refs.filter((ref) => ref.actCelex === "32013R0575" && ref.articleNumber)
      .map((ref) => ref.articleNumber);
    expect(articles).toEqual(["143", "221", "283", "363"]);
  });

  it("classifies named national legislation as external instead of an internal article", () => {
    const refs = extractCrossRefsFromText(
      "Article 201 of Italian Legislative Decree No 58 of 24 February 1998",
      lang,
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      type: "external",
      articleNumber: "201",
      nationalLaw: true,
    });
  });

  it("binds Charter articles to the Charter CELEX record", () => {
    const refs = extractCrossRefsFromText(
      "Articles 7, 8(1) and 21 of the Charter of Fundamental Rights of the European Union",
      lang,
    );
    expect(refs.filter((r) => r.type === "article")).toHaveLength(0);
    const charterRefs = refs.filter((r) => r.actCelex === "12012P" && r.articleNumber);
    expect(charterRefs.map((r) => r.articleNumber)).toEqual(["7", "8", "21"]);
    expect(charterRefs.find((r) => r.articleNumber === "8")?.paragraph).toBe("1");
  });

  it("keeps this act internal but treats that act as contextual", () => {
    const current = extractCrossRefsFromText("Article 5 of this Regulation", lang);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ type: "article", target: "5" });

    const other = extractCrossRefsFromText("Article 9 of that Regulation", lang);
    expect(other).toHaveLength(1);
    expect(other[0]).toMatchObject({
      type: "external",
      articleNumber: "9",
      actType: "regulation",
      contextual: true,
    });
  });

  it("binds thereof to a nearby named act but not across a sentence boundary", () => {
    const refs = extractCrossRefsFromText(
      "Regulation (EU) 2019/1150 applies, including Article 24(3) thereof",
      lang,
    );
    expect(refs.find((r) => r.articleNumber === "24")).toMatchObject({
      type: "external",
      target: "2019/1150",
      actCelex: "32019R1150",
      paragraph: "3",
    });

    const separated = extractCrossRefsFromText(
      "Regulation (EU) 2019/1150 applies. Article 24(3) thereof",
      lang,
    );
    expect(separated.find((r) => r.type === "external" && r.articleNumber === "24")).toBeFalsy();
    expect(separated.find((r) => r.type === "article" && r.target === "24")).toBeTruthy();
  });

  it("resolves Recommendation articles used by a later thereof reference", () => {
    const refs = extractCrossRefsFromText(
      "Recommendation 2003/361/EC during the 12 months following loss of that status pursuant to Article 4(2) thereof",
      lang,
    );
    expect(refs.find((r) => r.articleNumber === "4")).toMatchObject({
      type: "external",
      target: "2003/361/EC",
      actType: "recommendation",
      actCelex: "32003H0361",
      paragraph: "2",
    });
  });

  it("extracts plural instrument labels", () => {
    const refs = extractCrossRefsFromText(
      "Directives 89/686/EEC and 94/9/EC complement Regulations (EC) No 765/2008",
      lang,
    ).filter((ref) => ref.type === "external");
    expect(refs.find((ref) => ref.target === "89/686/EEC")).toMatchObject({
      actType: "directive",
      actCelex: "31989L0686",
    });
    expect(refs.find((ref) => ref.target === "765/2008")).toMatchObject({
      actType: "regulation",
      actCelex: "32008R0765",
    });
  });

  it("binds historical bare-Treaty citations instead of making internal links", () => {
    const refs = extractCrossRefsFromText("rules laid down in Articles 81 and 82 of the Treaty", lang);
    expect(refs.filter((ref) => ref.type === "article")).toHaveLength(0);
    expect(refs.filter((ref) => ref.treaty && ref.articleNumber).map((ref) => ref.articleNumber))
      .toEqual(["81", "82"]);
  });

  it("binds an ordinal paragraph citation through punctuation to TFEU", () => {
    const refs = extractCrossRefsFromText("Article 263, first paragraph, TFEU", lang);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      type: "external",
      articleNumber: "263",
      paragraph: "1",
      actCelex: "12012E",
    });
  });

  it("binds protocol article lists to named Protocol targets", () => {
    const refs = extractCrossRefsFromText("Articles 2 and 2a of Protocol No 22", lang);
    expect(refs.filter((r) => r.type === "article")).toHaveLength(0);
    const protocolRefs = refs.filter((r) => r.protocol && r.articleNumber);
    expect(protocolRefs.map((r) => r.articleNumber)).toEqual(["2", "2a"]);
    expect(protocolRefs.every((r) => r.target === "Protocol No 22")).toBe(true);
  });

  it("expands paragraph and point ranges and retains nested points", () => {
    const refs = extractCrossRefsFromText(
      "Article 5(2) to (6), Article 19(1)(a) to (e), and Article 4(2)(a)(i)",
      lang,
    );
    expect(refs.filter((r) => r.target === "5").map((r) => r.paragraph)).toEqual(["2", "3", "4", "5", "6"]);
    expect(refs.filter((r) => r.target === "19").map((r) => r.point)).toEqual(["a", "b", "c", "d", "e"]);
    expect(refs.find((r) => r.target === "4")?.point).toBe("a(i)");
  });

  it("does not bind an article to an act across unrelated prose", () => {
    // "Article 7 and take account of the objectives of Regulation 2018/1725":
    // Article 7 must stay an internal ref, not bind to the regulation.
    const refs = extractCrossRefsFromText(
      "Member States shall apply Article 7 and take account of the objectives of Regulation (EU) 2018/1725",
      lang
    );
    const article7 = refs.find((r) => r.type === "article" && r.target === "7");
    expect(article7).toBeTruthy();
    const boundTo1725 = refs.find((r) => r.type === "external" && r.articleNumber === "7");
    expect(boundTo1725).toBeFalsy();
  });
});
