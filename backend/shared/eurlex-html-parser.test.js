const test = require("node:test");
const assert = require("node:assert/strict");

const {
  closeSharedPlaywrightBrowser,
  fetchEurlexHtmlLaw,
  fetchAndParseEurlexHtmlLaw,
  getSharedPlaywrightBrowser,
  getSharedPlaywrightPage,
  isRetriablePlaywrightError,
  parseEurlexHtmlToCombined,
} = require("./eurlex-html-parser");

const SAMPLE_HTML = `<!DOCTYPE html>
<html lang="EN">
<head>
  <meta name="DC.description" content="Directive 2002/58/EC concerning privacy in electronic communications">
</head>
<body>
  <div id="TexteOnly">
    <p>
      <TXT_TE>
        <p>Directive 2002/58/EC of the European Parliament and of the Council</p>
        <p>of 12 July 2002</p>
        <p>concerning the processing of personal data and the protection of privacy in the electronic communications sector</p>
        <p>Whereas:</p>
        <p>(1) First recital text.</p>
        <p>(2) Second recital text mentioning Article 2.</p>
        <p>Article 1</p>
        <p>Scope</p>
        <p>1. This Directive lays down rules.</p>
        <p>Article 2</p>
        <p>Definitions</p>
        <p>The following definitions shall also apply:</p>
        <p>(a) "user" means any natural person using a service;</p>
        <p>(b) "traffic data" means any data processed for billing.</p>
      </TXT_TE>
    </p>
  </div>
</body>
</html>`;

test("parseEurlexHtmlToCombined extracts title, recitals, articles, and definitions", async () => {
  const parsed = await parseEurlexHtmlToCombined(SAMPLE_HTML, "ENG");

  assert.equal(parsed.langCode, "EN");
  assert.equal(parsed.title, "Directive 2002/58/EC concerning privacy in electronic communications");
  assert.equal(parsed.recitals.length, 2);
  assert.equal(parsed.articles.length, 2);
  assert.equal(parsed.articles[0].article_number, "1");
  assert.equal(parsed.articles[0].article_title, "Scope");
  assert.match(parsed.articles[0].article_html, /This Directive lays down rules/);
  assert.equal(parsed.definitions.length, 2);
  assert.equal(parsed.definitions[0].term, "user");
  assert.match(parsed.definitions[0].definition, /natural person using a service/i);
});

test("parseEurlexHtmlToCombined retains unnumbered legacy decision measures", async () => {
  const html = `<!DOCTYPE html><html lang="EN"><head><meta name="DC.description" content="Council Decision" /></head><body><div id="TexteOnly"><p><TXT_TE>
    <p>****</p><p>COUNCIL DECISION</p><p>OF 25 JUNE 1979</p>
    <p>THE COUNCIL DECIDES TO TAKE INTERIM MEASURES UNDER ARTICLE 102 OF THE ACT OF ACCESSION.</p>
    <p>1. Member States shall conduct their fishery accordingly.</p><p>2. The measures apply until 31 October 1979.</p>
  </TXT_TE></p></div></body></html>`;
  const parsed = await parseEurlexHtmlToCombined(html, "ENG");

  assert.equal(parsed.articles.length, 1);
  assert.equal(parsed.articles[0].article_number, "text");
  assert.equal(parsed.articles[0].display_label, "Decision text");
  assert.equal(parsed.articles[0].is_unnumbered, true);
  assert.match(parsed.articles[0].article_html, /Member States shall conduct their fishery/);
  assert.match(parsed.articles[0].article_html, /Article 102/i);
});

test("parseEurlexHtmlToCombined retains unnumbered European Parliament decisions", async () => {
  const html = `<!DOCTYPE html><html lang="EN"><body><div id="TexteOnly"><p><TXT_TE>
    <p>DECISION OF THE EUROPEAN PARLIAMENT OF 16 NOVEMBER 1979</p>
    <p>1. Grants a discharge to the Commission.</p><p>2. Instructs its President to communicate this Decision.</p>
  </TXT_TE></p></div></body></html>`;
  const parsed = await parseEurlexHtmlToCombined(html, "ENG");

  assert.equal(parsed.articles.length, 1);
  assert.equal(parsed.articles[0].display_label, "Decision text");
  assert.match(parsed.articles[0].article_html, /Grants a discharge/i);
});

test("parseEurlexHtmlToCombined retains narrative unnumbered Council decisions", async () => {
  const html = `<!DOCTYPE html><html lang="EN"><body><div id="TexteOnly"><p><TXT_TE>
    <p>COUNCIL DECISION OF 29 DECEMBER 1981 CONCERNING FISHERY ACTIVITIES</p>
    <p>THE COUNCIL HAS DECIDED AS FOLLOWS:</p>
    <p>FROM 1 JANUARY 1982 THE MEMBER STATES SHALL CONDUCT THEIR FISHING ACTIVITIES IN ACCORDANCE WITH THE USUAL SEASONAL CYCLES.</p>
  </TXT_TE></p></div></body></html>`;
  const parsed = await parseEurlexHtmlToCombined(html, "ENG");

  assert.equal(parsed.articles.length, 1);
  assert.equal(parsed.articles[0].is_unnumbered, true);
  assert.match(parsed.articles[0].article_html, /FISHING ACTIVITIES/i);
});

const STRUCTURED_HTML = `<!DOCTYPE html>
<html lang="EN">
<body>
  <p class="oj-doc-ti">Directive (EU) 2015/2366 of the European Parliament and of the Council</p>
  <div class="eli-subdivision" id="rct_1">
    <table><tr><td>(1)</td><td>First recital text. Article 99 applies.</td></tr></table>
  </div>
  <div class="eli-subdivision" id="art_1">
    <div class="eli-title">
      <p class="oj-ti-art">Article 1</p>
      <p class="oj-sti-art">Subject matter</p>
    </div>
    <p>This Directive lays down rules.</p>
  </div>
</body>
</html>`;

test("parseEurlexHtmlToCombined reuses the legacy structured EUR-Lex HTML layout", async () => {
  const parsed = await parseEurlexHtmlToCombined(STRUCTURED_HTML, "ENG");

  assert.equal(parsed.articles.length, 1);
  assert.equal(parsed.articles[0].article_number, "1");
  assert.equal(parsed.articles[0].article_title, "Subject matter");
  assert.equal(parsed.recitals.length, 1);
  assert.equal(parsed.recitals[0].recital_number, "1");
  assert.equal(parsed.crossReferences.recital_1, undefined);
  assert.doesNotMatch(parsed.recitals[0].recital_html, /data-ref-article="99"/);
});

const FLAT_DIVISION_HTML = `<!DOCTYPE html>
<html lang="EN">
<head>
  <meta name="DC.description" content="Directive 95/46/EC">
</head>
<body>
  <div id="TexteOnly">
    <p>
      <TXT_TE>
        <p>Article 4</p>
        <p>National law applicable</p>
        <p>1. Each Member State shall apply the national provisions it adopts pursuant to this Directive.</p>
        <p>CHAPTER II GENERAL RULES ON THE LAWFULNESS OF THE PROCESSING OF PERSONAL DATA</p>
        <p>Article 5</p>
        <p>Member States shall, within the limits of the provisions of this Chapter, determine more precisely the conditions under which the processing of personal data is lawful.</p>
        <p>SECTION I</p>
        <p>PRINCIPLES RELATING TO DATA QUALITY</p>
        <p>Article 6</p>
        <p>1. Member States shall provide that personal data must be processed fairly and lawfully.</p>
      </TXT_TE>
    </p>
  </div>
</body>
</html>`;

const LEGISWRITE_COM_HTML = `<!DOCTYPE html>
<html lang="EN">
<body>
  <div class="content">
    <p class="Statut"><span>Proposal for a</span></p>
    <p class="Typedudocument"><span>REGULATION OF THE EUROPEAN PARLIAMENT AND OF THE COUNCIL</span></p>
    <p class="Titreobjet"><span>ON A SAMPLE MATTER</span></p>
    <p class="li ManualHeading1"><span>1.</span><span>EXPLANATORY MEMORANDUM</span></p>
    <p class="Normal"><span>Some explanatory prose that must not become a recital.</span></p>
    <p class="li ManualConsidrant"><span class="num"><span>(1)</span></span><span>First recital text.</span></p>
    <p class="li ManualConsidrant"><span class="num"><span>(2)</span></span><span>Second recital mentioning Article 2.</span></p>
    <p class="Formuledadoption"><span>HAVE ADOPTED THIS REGULATION:</span></p>
    <p class="SectionTitle"><span>TITLE I</span></p>
    <p class="SectionTitle"><span>GENERAL PROVISIONS</span></p>
    <p class="Titrearticle"><span>Article 1</span><span> <br>Subject matter</span></p>
    <p class="Normal"><span>This Regulation lays down rules.</span></p>
    <p class="Titrearticle"><span>Article 2</span><span> <br>Definitions</span></p>
    <p class="Normal"><span>For the purposes of this Regulation, the following definitions apply.</span></p>
    <p class="Annexetitre"><span>ANNEX </span><span>I</span><br><span>SAMPLE ANNEX</span></p>
    <p class="Normal"><span>Annex body content.</span></p>
  </div>
</body>
</html>`;

test("parseEurlexHtmlToCombined parses LegisWrite Commission-proposal layout", async () => {
  const parsed = await parseEurlexHtmlToCombined(LEGISWRITE_COM_HTML, "ENG");

  assert.match(parsed.title, /^Proposal for a REGULATION OF THE EUROPEAN PARLIAMENT/);
  assert.equal(parsed.recitals.length, 2);
  assert.equal(parsed.recitals[0].recital_number, "1");
  assert.match(parsed.recitals[0].recital_text, /First recital text/);
  assert.equal(parsed.articles.length, 2);
  assert.equal(parsed.articles[0].article_number, "1");
  assert.equal(parsed.articles[0].article_title, "Subject matter");
  assert.equal(parsed.articles[0].division.chapter.number, "TITLE I");
  assert.equal(parsed.articles[0].division.chapter.title, "GENERAL PROVISIONS");
  assert.match(parsed.articles[0].article_html, /This Regulation lays down rules/);
  // Explanatory-memorandum prose before the recitals must not leak into the body.
  assert.ok(parsed.articles.every((a) => !/explanatory prose/i.test(a.article_html)));
  assert.equal(parsed.annexes.length, 1);
  assert.equal(parsed.annexes[0].annex_id, "I");
  assert.match(parsed.annexes[0].annex_html, /Annex body content/);
});

// Pre-1990s EEC/ECSC acts ship as a <TXT_TE> fragment with an unnumbered
// "Whereas …" preamble (no "(N)" recital markers) and a "HAS ADOPTED …"
// enacting formula before Article 1 — the shape the FMX-less HTML corpus is full of.
const OLD_WHEREAS_HTML = `<!DOCTYPE html>
<html lang="EN">
<head><meta name="DC.description" content="Council Directive 64/428/EEC"></head>
<body>
  <div id="TexteOnly">
    <TXT_TE>
      <p>COUNCIL DIRECTIVE of 7 July 1964</p>
      <p>THE COUNCIL OF THE EUROPEAN ECONOMIC COMMUNITY,</p>
      <p>Having regard to the Treaty establishing the European Economic Community;</p>
      <p>Having regard to the proposal from the Commission;</p>
      <p>Whereas the General Programmes provide for freedom of establishment;</p>
      <p>Whereas wholesale trade activities have been liberalised;</p>
      <p>and whereas that liberalisation should continue in stages;</p>
      <p>HAS ADOPTED THIS DIRECTIVE:</p>
      <p>Article 1</p>
      <p>Member States shall abolish the restrictions referred to in the General Programme.</p>
      <p>Article 2</p>
      <p>This Directive is addressed to the Member States.</p>
    </TXT_TE>
  </div>
</body>
</html>`;

test("parseEurlexHtmlToCombined extracts unnumbered Whereas recitals from old acts", async () => {
  const parsed = await parseEurlexHtmlToCombined(OLD_WHEREAS_HTML, "ENG");

  // Two "Whereas …" paragraphs → two recitals; the continuation line ("and
  // whereas …") folds into the second, not a third.
  assert.equal(parsed.recitals.length, 2);
  assert.equal(parsed.recitals[0].recital_number, "1");
  assert.match(parsed.recitals[0].recital_text, /^the General Programmes provide/);
  assert.equal(parsed.recitals[1].recital_number, "2");
  assert.match(parsed.recitals[1].recital_text, /liberalised.*continue in stages/);
  // The "HAS ADOPTED …" enacting formula must never be swallowed into a recital.
  assert.ok(parsed.recitals.every((r) => !/HAS ADOPTED/i.test(r.recital_text)));
  assert.equal(parsed.articles.length, 2);
  assert.equal(parsed.articles[0].article_number, "1");
});

// Old single-provision amending acts carry a "SOLE ARTICLE" label (or nothing)
// instead of a numbered "Article N" heading.
const SOLE_ARTICLE_HTML = `<!DOCTYPE html>
<html lang="EN">
<head><meta name="DC.description" content="Council Regulation (EEC) No 2681/72"></head>
<body>
  <div id="TexteOnly">
    <TXT_TE>
      <p>REGULATION (EEC) No 2681/72 OF THE COUNCIL of 12 December 1972</p>
      <p>THE COUNCIL OF THE EUROPEAN COMMUNITIES,</p>
      <p>Whereas the method of calculation should be clarified;</p>
      <p>HAS ADOPTED THIS REGULATION:</p>
      <p>SOLE ARTICLE</p>
      <p>Article 10 of Regulation (EEC) No 2306/70 shall be replaced by the following text.</p>
      <p>THIS REGULATION SHALL BE BINDING IN ITS ENTIRETY AND DIRECTLY APPLICABLE IN ALL MEMBER STATES.</p>
      <p>DONE AT BRUSSELS, 12 DECEMBER 1972.</p>
    </TXT_TE>
  </div>
</body>
</html>`;

test("parseEurlexHtmlToCombined recovers a single article from a 'SOLE ARTICLE' act", async () => {
  const parsed = await parseEurlexHtmlToCombined(SOLE_ARTICLE_HTML, "ENG");

  // No numbered "Article N" heading, but the operative text after the enacting
  // formula is salvaged as a lone Article 1.
  assert.equal(parsed.articles.length, 1);
  assert.equal(parsed.articles[0].article_number, "1");
  // The "SOLE ARTICLE" label is dropped; the operative sentence is kept. (The
  // cross-ref linker wraps "Article 10" and "Regulation …" as separate links, so
  // compare the de-tagged text rather than the raw HTML.)
  const soleText = parsed.articles[0].article_html.replace(/<[^>]+>/g, "");
  assert.match(soleText, /Article 10 of Regulation/);
  assert.doesNotMatch(parsed.articles[0].article_html, /SOLE ARTICLE/i);
  // The closing/binding formula and signature must not leak into the body.
  assert.doesNotMatch(parsed.articles[0].article_html, /SHALL BE BINDING|DONE AT/i);
  // The preamble recital is still parsed independently.
  assert.equal(parsed.recitals.length, 1);
});

// 1990s directives number their recitals "(N) Whereas …" with a "Having regard
// to …" citation block above and no standalone "Whereas:" heading (e.g. Directive
// 95/46/EC). The preamble must be scanned for "(N)" markers, and the enacting
// formula must not be swallowed into the last recital.
const NUMBERED_WHEREAS_HTML = `<!DOCTYPE html>
<html lang="EN">
<head><meta name="DC.description" content="Directive 95/46/EC"></head>
<body>
  <div id="TexteOnly">
    <TXT_TE>
      <p>DIRECTIVE 95/46/EC OF THE EUROPEAN PARLIAMENT AND OF THE COUNCIL of 24 October 1995</p>
      <p>THE EUROPEAN PARLIAMENT AND THE COUNCIL OF THE EUROPEAN UNION,</p>
      <p>Having regard to the Treaty establishing the European Community, and in particular Article 100a thereof,</p>
      <p>Having regard to the proposal from the Commission (1),</p>
      <p>(1) Whereas the objectives of the Community include establishing an internal market;</p>
      <p>(2) Whereas data-processing systems are designed to serve man;</p>
      <p>(3) Whereas the establishment of an internal market requires the free movement of personal data;</p>
      <p>HAVE ADOPTED THIS DIRECTIVE:</p>
      <p>Article 1</p>
      <p>Member States shall protect the fundamental rights of natural persons.</p>
      <p>Article 2</p>
      <p>This Directive is addressed to the Member States.</p>
    </TXT_TE>
  </div>
</body>
</html>`;

test("parseEurlexHtmlToCombined parses '(N) Whereas' numbered recitals without a 'Whereas:' heading", async () => {
  const parsed = await parseEurlexHtmlToCombined(NUMBERED_WHEREAS_HTML, "ENG");

  // Three "(N) Whereas …" paragraphs → three numbered recitals; the "Having
  // regard to …" citation lines above must not be mistaken for recitals.
  assert.equal(parsed.recitals.length, 3);
  assert.deepEqual(parsed.recitals.map((r) => r.recital_number), ["1", "2", "3"]);
  assert.match(parsed.recitals[0].recital_text, /objectives of the Community/);
  // The enacting formula sits between the last recital and Article 1 — it must
  // never be folded into recital 3.
  assert.ok(parsed.recitals.every((r) => !/HAVE ADOPTED/i.test(r.recital_text)));
  assert.equal(parsed.articles.length, 2);
});

// Cross-reference + footnote extraction in the plaintext branch. Recital
// preambles used to get no cross-ref injection at all, the crossReferences map
// was hardcoded empty, and "(N) OJ No …" footnote lines were dropped.
const CROSSREF_HTML = `<!DOCTYPE html>
<html lang="EN">
<head><meta name="DC.description" content="Test Directive"></head>
<body>
  <div id="TexteOnly">
    <TXT_TE>
      <p>COUNCIL DIRECTIVE of 1 January 1990</p>
      <p>THE COUNCIL OF THE EUROPEAN COMMUNITIES,</p>
      <p>Having regard to the Treaty on the Functioning of the European Union,</p>
      <p>(1) Whereas Directive 87/373/EEC (1) laid down a procedure that applies here;</p>
      <p>(2) Whereas Article 3 of this Directive should be read together with Regulation 1408/71/EEC and the TFEU;</p>
      <p>HAS ADOPTED THIS DIRECTIVE:</p>
      <p>Article 1</p>
      <p>The scope is defined in Article 2 and by Directive 89/552/EEC.</p>
      <p>Article 2</p>
      <p>This Directive is addressed to the Member States.</p>
      <p>(1) OJ No L 281, 23.11.1995, p. 31.</p>
    </TXT_TE>
  </div>
</body>
</html>`;

test("parseEurlexHtmlToCombined injects cross-refs into recitals and builds a crossReferences map", async () => {
  const parsed = await parseEurlexHtmlToCombined(CROSSREF_HTML, "ENG");

  // P1: recital preambles get cross-ref links injected (previously zero links).
  const recitalHtml = parsed.recitals.map((r) => r.recital_html).join("");
  assert.match(recitalHtml, /class="external-ref"[^>]*data-ref-year="1987"/);
  assert.doesNotMatch(recitalHtml, /data-ref-article="3"/);

  // P2: the crossReferences map is populated for recitals and articles.
  assert.ok(Object.keys(parsed.crossReferences).length > 0, "crossReferences should not be empty");
  const article1Refs = parsed.crossReferences["1"] || [];
  assert.ok(
    article1Refs.some((r) => r.type === "article" && r.target === "2"),
    "Article 1 should reference Article 2",
  );
  assert.ok(
    article1Refs.some((r) => r.type === "external" && r.year === "1989"),
    "Article 1 should reference Directive 89/552/EEC",
  );

  // P3: the "(1) OJ No L 281 …" footnote line is captured as an OJ reference and
  // reattached to recital 1 (which carries the matching "(1)" marker), not dropped.
  const recital1Refs = parsed.crossReferences.recital_1 || [];
  const ojRef = recital1Refs.find((r) => r.type === "oj_ref");
  assert.ok(ojRef, "recital 1 should carry the OJ footnote reference");
  assert.equal(ojRef.ojColl, "L");
  assert.equal(ojRef.ojNo, "281");
  assert.equal(ojRef.ojYear, "1995");

  // P4: treaty references (TFEU) are detected as external refs.
  const treatyRef = Object.values(parsed.crossReferences).flat().find((r) => r.treaty);
  assert.ok(treatyRef, "the TFEU reference should be captured as a treaty ref");
});

// Old <TXT_TE> acts carry annexes after the articles; the plaintext branch used
// to drop them (annexes: []) and let their content bleed into the last article.
const ANNEX_HTML = `<!DOCTYPE html>
<html lang="EN">
<head><meta name="DC.description" content="Council Regulation with annexes"></head>
<body>
  <div id="TexteOnly">
    <TXT_TE>
      <p>THE COUNCIL OF THE EUROPEAN COMMUNITIES,</p>
      <p>Whereas measures are needed;</p>
      <p>HAS ADOPTED THIS REGULATION:</p>
      <p>Article 1</p>
      <p>The scope is defined in Annex I.</p>
      <p>Article 2</p>
      <p>This Regulation shall enter into force on the third day.</p>
      <p>ANNEX I</p>
      <p>LIST OF PRODUCTS</p>
      <p>Product A, Product B, Product C.</p>
      <p>ANNEX II</p>
      <p>Correlation table for the repealed Regulation.</p>
    </TXT_TE>
  </div>
</body>
</html>`;

test("parseEurlexHtmlToCombined extracts annexes and keeps them out of the last article", async () => {
  const parsed = await parseEurlexHtmlToCombined(ANNEX_HTML, "ENG");

  // Two articles, two annexes; annex content is not swallowed into Article 2.
  assert.equal(parsed.articles.length, 2);
  assert.equal(parsed.annexes.length, 2);
  assert.equal(parsed.annexes[0].annex_id, "I");
  assert.match(parsed.annexes[0].annex_title, /ANNEX I/);
  assert.match(parsed.annexes[0].annex_html, /Product A/);
  assert.equal(parsed.annexes[1].annex_id, "II");
  assert.match(parsed.annexes[1].annex_html, /Correlation table/);
  const lastArticle = parsed.articles[parsed.articles.length - 1];
  assert.doesNotMatch(lastArticle.article_html, /LIST OF PRODUCTS|Correlation table/);
});

test("parseEurlexHtmlToCombined keeps flat chapter and section headings out of article bodies", async () => {
  const parsed = await parseEurlexHtmlToCombined(FLAT_DIVISION_HTML, "ENG");

  assert.equal(parsed.articles.length, 3);
  assert.match(parsed.articles[0].article_html, /National law applicable/);
  assert.doesNotMatch(parsed.articles[0].article_html, /CHAPTER II/);
  assert.doesNotMatch(parsed.articles[1].article_html, /SECTION I/);
  assert.equal(parsed.articles[1].division.chapter.number, "CHAPTER II");
  assert.equal(
    parsed.articles[1].division.chapter.title,
    "GENERAL RULES ON THE LAWFULNESS OF THE PROCESSING OF PERSONAL DATA"
  );
  assert.equal(parsed.articles[2].division.section.number, "SECTION I");
  assert.equal(parsed.articles[2].division.section.title, "PRINCIPLES RELATING TO DATA QUALITY");
});

const LEGACY_XHTML_HTML = `<!DOCTYPE html>
<html lang="EN">
<head>
  <meta name="DC.description" content="Council Directive 90/314/EEC on package travel, package holidays and package tours">
</head>
<body>
  <p class="doc-ti">COUNCIL DIRECTIVE 90/314/EEC</p>
  <p class="normal">Whereas package travel, package holidays and package tours are an important part of the tourist industry;</p>
  <p class="normal">Whereas the consumer should be protected against misleading information;</p>
  <p class="ti-art"><span class="italic">Article 1</span></p>
  <p class="normal">Objective</p>
  <p class="normal">The purpose of this Directive is to approximate the laws of the Member States.</p>
  <p class="ti-art">Article 2</p>
  <p class="normal">(1) For the purposes of this Directive:</p>
  <p class="normal">(a) "organizer" means the person who organizes packages;</p>
</body>
</html>`;

test("parseEurlexHtmlToCombined supports the older XHTML doc-ti/normal/ti-art layout", async () => {
  const parsed = await parseEurlexHtmlToCombined(LEGACY_XHTML_HTML, "ENG");

  assert.equal(parsed.title, "Council Directive 90/314/EEC on package travel, package holidays and package tours");
  assert.equal(parsed.recitals.length, 2);
  assert.equal(parsed.articles.length, 2);
  assert.equal(parsed.articles[0].article_number, "1");
  assert.equal(parsed.articles[0].article_title, "Objective");
  assert.match(parsed.articles[0].article_html, /approximate the laws of the Member States/i);
  assert.equal(parsed.articles[1].article_number, "2");
  assert.match(parsed.articles[1].article_html, /organizer/i);
});

const LEGACY_XHTML_WITH_ANNEX_HTML = `<!DOCTYPE html>
<html lang="EN">
<head>
  <meta name="DC.description" content="Council Directive 93/13/EEC on unfair terms in consumer contracts">
</head>
<body>
  <p class="doc-ti">COUNCIL DIRECTIVE 93/13/EEC</p>
  <p class="normal">Whereas it is necessary to adopt measures progressively establishing the internal market;</p>
  <p class="ti-art"><span class="italic">Article 1</span></p>
  <p class="normal">Purpose</p>
  <p class="normal">The purpose of this Directive is to approximate the laws of the Member States.</p>
  <p class="doc-ti">ANNEX</p>
  <p class="doc-ti">TERMS REFERRED TO IN ARTICLE 3 (3)</p>
  <p class="normal">1. Terms excluding or limiting the legal liability of a seller or supplier.</p>
</body>
</html>`;

test("parseEurlexHtmlToCombined captures annexes from the older XHTML layout", async () => {
  const parsed = await parseEurlexHtmlToCombined(LEGACY_XHTML_WITH_ANNEX_HTML, "ENG");

  assert.equal(parsed.articles.length, 1);
  assert.equal(parsed.annexes.length, 1);
  assert.equal(parsed.annexes[0].annex_id, "ANNEX — TERMS REFERRED TO IN ARTICLE 3 (3)");
  assert.equal(parsed.annexes[0].annex_title, "ANNEX — TERMS REFERRED TO IN ARTICLE 3 (3)");
  assert.match(parsed.annexes[0].annex_html, /legal liability of a seller or supplier/i);
});

// This parser reads a different document format from the Formex one, but it imports that
// parser's cross-reference grammar, so a single PARSER_VERSION versions both outputs — and
// the citation-graph builder reads this field off every parsed law to decide whether a
// published artifact predates a parser fix. An unstamped layout reports `null` there and
// silently exempts itself from staleness detection.
//
// Asserted per layout, not once: the oldest TXT_TE branch builds its own crossReferences
// (it alone needs footnotesByNumber) rather than going through withCrossReferences, so it
// carries a second, separate stamp. That branch is the one every pre-2004 OJ act takes —
// the bulk of the HTML corpus — so a single-layout test would pass while it returned null.
test("parseEurlexHtmlToCombined stamps the shared parser version on every layout", async () => {
  const { PARSER_VERSION } = await import("./formex-parser/fmxParser.mjs");
  const layouts = [
    ["TXT_TE fallback", SAMPLE_HTML],
    ["structured", STRUCTURED_HTML],
    ["legacy XHTML", LEGACY_XHTML_HTML],
    ["LegisWrite", LEGISWRITE_COM_HTML],
  ];

  for (const [layout, html] of layouts) {
    const parsed = await parseEurlexHtmlToCombined(html, "ENG");
    assert.equal(parsed.parserVersion, PARSER_VERSION, `${layout} layout must report the shared parser version`);
  }
});

test("fetchAndParseEurlexHtmlLaw always fetches and parses the English fallback", async () => {
  const originalFetch = global.fetch;
  let requestedUrl = null;
  global.fetch = async (url) => {
    requestedUrl = String(url);
    return {
      ok: true,
      status: 200,
      text: async () => SAMPLE_HTML,
    };
  };

  try {
    const parsed = await fetchAndParseEurlexHtmlLaw({
      celex: "32002L0058",
      lang: "DEU",
      eurlexBase: "https://eur-lex.europa.eu",
      timeoutMs: 5_000,
      includeRawHtml: true,
    });

    assert.match(requestedUrl, /\/legal-content\/EN\/TXT\/HTML\/\?uri=CELEX:32002L0058$/);
    assert.equal(parsed.requestedLang, "DEU");
    assert.equal(parsed.servedLang, "ENG");
    assert.equal(parsed.lang, "ENG");
    assert.equal(parsed.langCode, "EN");
    assert.equal(parsed.articles[0].article_number, "1");
    assert.match(parsed.rawHtml, /Directive 2002\/58\/EC/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("fetchEurlexHtmlLaw always fetches raw English HTML without parsing", async () => {
  const originalFetch = global.fetch;
  let requestedUrl = null;
  global.fetch = async (url) => {
    requestedUrl = String(url);
    return {
      ok: true,
      status: 200,
      text: async () => SAMPLE_HTML,
    };
  };

  try {
    const fetched = await fetchEurlexHtmlLaw({
      celex: "32002L0058",
      lang: "DEU",
      eurlexBase: "https://eur-lex.europa.eu",
      timeoutMs: 5_000,
    });

    assert.match(requestedUrl, /\/legal-content\/EN\/TXT\/HTML\/\?uri=CELEX:32002L0058$/);
    assert.equal(fetched.requestedLang, "DEU");
    assert.equal(fetched.servedLang, "ENG");
    assert.equal(fetched.lang, "ENG");
    assert.equal(fetched.source, "eurlex-html");
    assert.match(fetched.rawHtml, /Directive 2002\/58\/EC/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("fetchAndParseEurlexHtmlLaw surfaces EUR-Lex WAF challenges as a distinct client error", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 202,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "x-amzn-waf-action" ? "challenge" : null;
      },
    },
    text: async () => "<html></html>",
  });

  try {
    await assert.rejects(
      () => fetchAndParseEurlexHtmlLaw({
        celex: "31990L0314",
        lang: "ENG",
        eurlexBase: "https://eur-lex.europa.eu",
        timeoutMs: 5_000,
      }),
      (error) => {
        assert.equal(error.code, "eurlex_html_challenged");
        assert.equal(error.statusCode, 503);
        assert.equal(error.details.celex, "31990L0314");
        assert.equal(error.details.upstreamStatus, 202);
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("fetchAndParseEurlexHtmlLaw can use Playwright on challenge when enabled", async () => {
  const originalFetch = global.fetch;
  let playwrightCalled = false;
  global.fetch = async () => ({
    ok: false,
    status: 202,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "x-amzn-waf-action" ? "challenge" : null;
      },
    },
    text: async () => "<html></html>",
  });

  try {
    const parsed = await fetchAndParseEurlexHtmlLaw({
      celex: "32002L0058",
      lang: "DEU",
      eurlexBase: "https://eur-lex.europa.eu",
      timeoutMs: 5_000,
      usePlaywrightOnChallenge: true,
      playwrightHeadless: false,
      fetchWithPlaywrightImpl: async ({ headless }) => {
        playwrightCalled = true;
        assert.equal(headless, false);
        return SAMPLE_HTML;
      },
    });

    assert.equal(playwrightCalled, true);
    assert.equal(parsed.requestedLang, "DEU");
    assert.equal(parsed.servedLang, "ENG");
    assert.equal(parsed.articles[0].article_number, "1");
  } finally {
    global.fetch = originalFetch;
  }
});

test("fetchEurlexHtmlLaw can use Playwright on challenge when enabled", async () => {
  const originalFetch = global.fetch;
  let playwrightCalled = false;
  global.fetch = async () => ({
    ok: false,
    status: 202,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "x-amzn-waf-action" ? "challenge" : null;
      },
    },
    text: async () => "<html></html>",
  });

  try {
    const fetched = await fetchEurlexHtmlLaw({
      celex: "32002L0058",
      lang: "DEU",
      eurlexBase: "https://eur-lex.europa.eu",
      timeoutMs: 5_000,
      usePlaywrightOnChallenge: true,
      playwrightHeadless: false,
      fetchWithPlaywrightImpl: async ({ headless }) => {
        playwrightCalled = true;
        assert.equal(headless, false);
        return SAMPLE_HTML;
      },
    });

    assert.equal(playwrightCalled, true);
    assert.equal(fetched.requestedLang, "DEU");
    assert.equal(fetched.servedLang, "ENG");
    assert.match(fetched.rawHtml, /Directive 2002\/58\/EC/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("isRetriablePlaywrightError matches transient browser-closure failures", () => {
  assert.equal(isRetriablePlaywrightError(new Error("page.content: Target page, context or browser has been closed")), true);
  assert.equal(isRetriablePlaywrightError(new Error("Page crashed")), true);
  assert.equal(isRetriablePlaywrightError(new Error("No browser found")), false);
});

test("getSharedPlaywrightBrowser reuses the same browser for the same config", async () => {
  let launches = 0;
  const browser = {
    isConnected: () => true,
    close: async () => {},
  };
  const playwright = {
    chromium: {
      launch: async ({ headless }) => {
        launches += 1;
        assert.equal(headless, false);
        return browser;
      },
    },
  };

  try {
    const first = await getSharedPlaywrightBrowser(playwright, {
      playwrightBrowsersPath: "/tmp/pw",
      headless: false,
    });
    const second = await getSharedPlaywrightBrowser(playwright, {
      playwrightBrowsersPath: "/tmp/pw",
      headless: false,
    });
    assert.equal(first, browser);
    assert.equal(second, browser);
    assert.equal(launches, 1);
  } finally {
    await closeSharedPlaywrightBrowser();
  }
});

test("getSharedPlaywrightPage reuses the same page for the same shared browser", async () => {
  let pageCreates = 0;
  const page = {
    isClosed: () => false,
  };
  const browser = {
    isConnected: () => true,
    close: async () => {},
    newPage: async () => {
      pageCreates += 1;
      return page;
    },
  };
  const playwright = {
    chromium: {
      launch: async () => browser,
    },
  };

  try {
    const first = await getSharedPlaywrightPage(playwright, {
      playwrightBrowsersPath: "/tmp/pw",
      headless: false,
    });
    const second = await getSharedPlaywrightPage(playwright, {
      playwrightBrowsersPath: "/tmp/pw",
      headless: false,
    });
    assert.equal(first, page);
    assert.equal(second, page);
    assert.equal(pageCreates, 1);
  } finally {
    await closeSharedPlaywrightBrowser();
  }
});
