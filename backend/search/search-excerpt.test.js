const test = require("node:test");
const assert = require("node:assert/strict");

const {
  EXCERPT_MAX_LENGTH,
  buildExcerptFromCombined,
  extractExcerptFromXml,
} = require("./search-build");
const { enrichSearchRecord } = require("./search-ranking");

// A small synthetic FMX document exercising the same shape parseFmxToCombined
// expects from real EUR-Lex downloads: BIB.INSTANCE/LG.DOC for language,
// GR.CONSID/CONSID recitals, and ENACTING.TERMS/ARTICLE articles. Article 3's
// text is a control: it must never leak into the excerpt.
const SAMPLE_FMX_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ACT>
  <BIB.INSTANCE><LG.DOC>EN</LG.DOC></BIB.INSTANCE>
  <TITLE><TI><P>Regulation on Widget Automation</P></TI></TITLE>
  <PREAMBLE>
    <GR.CONSID>
      <CONSID><NP><NO.P>(1)</NO.P><TXT>Automated decision-making systems are increasingly used across the internal market and require a harmonised legal framework to protect fundamental rights.</TXT></NP></CONSID>
      <CONSID><NP><NO.P>(2)</NO.P><TXT>This Regulation establishes transparency obligations for providers of automated decision-making systems.</TXT></NP></CONSID>
    </GR.CONSID>
  </PREAMBLE>
  <ENACTING.TERMS>
    <ARTICLE IDENTIFIER="001">
      <TI.ART>Article 1</TI.ART>
      <STI.ART>Subject matter</STI.ART>
      <ALINEA><P>This Regulation lays down harmonised rules on automated decision-making systems placed on the market of the Union.</P></ALINEA>
    </ARTICLE>
    <ARTICLE IDENTIFIER="002">
      <TI.ART>Article 2</TI.ART>
      <STI.ART>Scope</STI.ART>
      <ALINEA><P>This Regulation applies to providers and deployers of automated decision-making systems established within the Union.</P></ALINEA>
    </ARTICLE>
    <ARTICLE IDENTIFIER="003">
      <TI.ART>Article 3</TI.ART>
      <STI.ART>Definitions</STI.ART>
      <ALINEA><P>For the purposes of this Regulation, unrelatedwidgetgadgetterm means a control widget that must never appear in the excerpt.</P></ALINEA>
    </ARTICLE>
  </ENACTING.TERMS>
</ACT>`;

test("extractExcerptFromXml pulls recitals and Article 1/2 body text via the shared FMX parser", async () => {
  const excerpt = await extractExcerptFromXml(SAMPLE_FMX_XML);

  assert.match(excerpt, /automated decision-making systems/i);
  assert.match(excerpt, /harmonised legal framework/i);
  assert.match(excerpt, /harmonised rules on automated decision-making systems/i);
  assert.match(excerpt, /applies to providers and deployers/i);
  // Article 3 body text must not leak into the excerpt.
  assert.doesNotMatch(excerpt, /unrelatedwidgetgadgetterm/i);
});

test("buildExcerptFromCombined truncates to EXCERPT_MAX_LENGTH", () => {
  const longText = "widget ".repeat(2000);
  const combined = {
    recitals: [{ recital_number: "1", recital_text: longText }],
    articles: [
      { article_number: "1", article_html: `<p>${longText}</p>` },
      { article_number: "2", article_html: "<p>scope text</p>" },
    ],
  };

  const excerpt = buildExcerptFromCombined(combined);
  assert.ok(excerpt.length <= EXCERPT_MAX_LENGTH, `excerpt too long: ${excerpt.length}`);
});

test("buildExcerptFromCombined keeps Article 1/2 text even when recitals overflow the budget", () => {
  // Regression: a large act's recitals (tens of KB) must not crowd the
  // subject-matter/scope articles out of the truncated excerpt.
  const hugeRecitals = "boilerplate ".repeat(5000); // ~60KB, far exceeds EXCERPT_MAX_LENGTH
  const combined = {
    recitals: [{ recital_number: "1", recital_text: hugeRecitals }],
    articles: [
      { article_number: "1", article_html: "<p>SUBJECTMATTERSENTINEL lays down harmonised rules</p>" },
      { article_number: "2", article_html: "<p>SCOPESENTINEL applies to providers in the Union</p>" },
    ],
  };

  const excerpt = buildExcerptFromCombined(combined);
  assert.match(excerpt, /SUBJECTMATTERSENTINEL/, "Article 1 subject-matter text must survive");
  assert.match(excerpt, /SCOPESENTINEL/, "Article 2 scope text must survive");
  assert.match(excerpt, /boilerplate/, "recitals still fill the remaining budget");
  assert.ok(excerpt.length <= EXCERPT_MAX_LENGTH, `excerpt too long: ${excerpt.length}`);
});

test("buildExcerptFromCombined folds in parsed definitions (domain vocabulary)", () => {
  const combined = {
    recitals: [{ recital_number: "1", recital_text: "purpose text" }],
    articles: [
      { article_number: "1", article_html: "<p>subject matter text</p>" },
      { article_number: "2", article_html: "<p>scope text</p>" },
    ],
    // The parser locates these by heading, so their article number is irrelevant
    // here (GDPR's definitions are Article 4, not 3).
    definitions: [
      { term: "automated decision-making", definition: "a process producing legal effects without human intervention" },
      { term: "provider", definition: "a natural or legal person developing an automated system" },
    ],
  };

  const excerpt = buildExcerptFromCombined(combined);
  assert.match(excerpt, /subject matter text/, "Art 1/2 still present");
  assert.match(excerpt, /automated decision-making/, "definition term folded in");
  assert.match(excerpt, /without human intervention/, "definition body folded in");
  assert.match(excerpt, /purpose text/, "recitals still fill the remainder");
});

test("buildExcerptFromCombined keeps Article 1/2 and definitions when recitals overflow", () => {
  const hugeRecitals = "boilerplate ".repeat(5000); // ~60KB, far exceeds EXCERPT_MAX_LENGTH
  const combined = {
    recitals: [{ recital_number: "1", recital_text: hugeRecitals }],
    articles: [{ article_number: "1", article_html: "<p>SUBJECTMATTERSENTINEL lays down rules</p>" }],
    definitions: [{ term: "DEFTERMSENTINEL", definition: "a defined concept" }],
  };

  const excerpt = buildExcerptFromCombined(combined);
  assert.match(excerpt, /SUBJECTMATTERSENTINEL/, "subject-matter survives recital overflow");
  assert.match(excerpt, /DEFTERMSENTINEL/, "definitions survive recital overflow");
  assert.ok(excerpt.length <= EXCERPT_MAX_LENGTH, `excerpt too long: ${excerpt.length}`);
});

test("buildExcerptFromCombined only pulls Article 1 and Article 2, skipping other articles", () => {
  const combined = {
    recitals: [],
    articles: [
      { article_number: "1", article_html: "<p>subject matter text</p>" },
      { article_number: "2", article_html: "<p>scope text</p>" },
      { article_number: "3", article_html: "<p>definitions text should be excluded</p>" },
    ],
  };

  const excerpt = buildExcerptFromCombined(combined);
  assert.match(excerpt, /subject matter text/);
  assert.match(excerpt, /scope text/);
  assert.doesNotMatch(excerpt, /definitions text/);
});

test("buildExcerptFromCombined indexes explicitly unnumbered decision text", () => {
  const excerpt = buildExcerptFromCombined({
    recitals: [],
    articles: [{
      article_number: "text",
      is_unnumbered: true,
      article_html: "<p>MERGERDECISIONSENTINEL confirms the concentration is compatible with the common market.</p>",
    }],
  });

  assert.match(excerpt, /MERGERDECISIONSENTINEL/);
});

test("buildExcerptFromCombined falls back to annex-only measures", () => {
  const excerpt = buildExcerptFromCombined({
    articles: [],
    recitals: [],
    annexes: [{ annex_html: "<p>QUANTITATIVE LIMITS ADJUSTED FOR 1980</p>" }],
  });
  assert.match(excerpt, /QUANTITATIVE LIMITS ADJUSTED FOR 1980/);
});

test("buildExcerptFromCombined degrades to an empty string for missing/malformed input", () => {
  assert.equal(buildExcerptFromCombined(null), "");
  assert.equal(buildExcerptFromCombined(undefined), "");
  assert.equal(buildExcerptFromCombined({}), "");
  assert.equal(buildExcerptFromCombined({ recitals: null, articles: null }), "");
});

test("extractExcerptFromXml resolves to an empty string (not a rejection) for unparsable XML", async () => {
  const excerpt = await extractExcerptFromXml("this is not xml at all <<< &&&");
  assert.equal(excerpt, "");
});

test("extractExcerptFromXml resolves to an empty string for XML with no recitals/articles", async () => {
  const excerpt = await extractExcerptFromXml("<ACT><TITLE><TI><P>Empty act</P></TI></TITLE></ACT>");
  assert.equal(excerpt, "");
});

test("extractExcerptFromXml skips (does not parse) oversized XML to protect the heap", async () => {
  // A >6MB blob must return "" without building a DOM — guards against the
  // annex-heavy acts that OOM'd the harvest workers.
  const huge = `<ACT><FILLER>${"x".repeat(6 * 1024 * 1024 + 16)}</FILLER></ACT>`;
  const excerpt = await extractExcerptFromXml(huge);
  assert.equal(excerpt, "");
});

test("enrichSearchRecord defaults excerpt to an empty string when absent (old cache records)", () => {
  const record = enrichSearchRecord({
    celex: "32020R0123",
    title: "Regulation (EU) 2020/123 on widgets",
    type: "regulation",
    date: "2020-01-01",
    eli: "http://data.europa.eu/eli/reg/2020/123/oj",
    fmxAvailable: true,
    fmxUnavailable: false,
  });

  assert.equal(record.excerpt, "");
});

test("enrichSearchRecord preserves a provided excerpt string", () => {
  const record = enrichSearchRecord({
    celex: "32020R0123",
    title: "Regulation (EU) 2020/123 on widgets",
    type: "regulation",
    date: "2020-01-01",
    eli: "http://data.europa.eu/eli/reg/2020/123/oj",
    fmxAvailable: true,
    fmxUnavailable: false,
    excerpt: "automated decision-making systems must be transparent",
  });

  assert.equal(record.excerpt, "automated decision-making systems must be transparent");
});
