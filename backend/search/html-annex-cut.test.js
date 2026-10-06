const test = require("node:test");
const assert = require("node:assert/strict");

const { cutHtmlAtFirstAnnex, operativeHtmlWithinLimit } = require("./html-annex-cut");

const article = '<div class="eli-subdivision" id="art_1"><p class="oj-ti-art">Article 1</p><p class="oj-normal">The Agreement is approved.</p></div>';

test("cuts at the first ELI annex container", () => {
  const html = `<body>${article}<div class="eli-container" id="anx_1"><p class="oj-doc-ti">ANNEX 1</p><table class="oj-table"></table></div></body>`;
  const cut = cutHtmlAtFirstAnnex(html);
  assert.equal(cut.operativeHtml, `<body>${article}`);
  assert.equal(cut.hasArticle, true);
});

test("cuts at an ANNEX doc-title heading when the rendition has no anx_ ids", () => {
  // Shape of 32006D0580: a "LIST OF ANNEXES" title precedes the first annex
  // and must not be mistaken for it.
  const html = `${article}<p class="oj-doc-ti">LIST OF ANNEXES</p><p class="oj-normal">Annex I</p>`
    + '<p class="oj-doc-ti" id="d1e32">ANNEX&nbsp;I (SAA Annex I)</p><p class="oj-doc-ti">TARIFF CONCESSIONS</p>';
  const cut = cutHtmlAtFirstAnnex(html);
  assert.equal(cut.operativeHtml, `${article}<p class="oj-doc-ti">LIST OF ANNEXES</p><p class="oj-normal">Annex I</p>`);
});

test("cuts at an annex heading class", () => {
  const html = `${article}<p class="title-annex-norm">Annex</p>`;
  assert.equal(cutHtmlAtFirstAnnex(html).operativeHtml, article);
});

test("reports no annex and no article when the markers are absent", () => {
  const cut = cutHtmlAtFirstAnnex('<p class="oj-normal">Prose only.</p>');
  assert.equal(cut.annexOffset, -1);
  assert.equal(cut.hasArticle, false);
});

test("operativeHtmlWithinLimit rejects unsafe fallbacks as oversized", () => {
  const annex = `<div id="anx_1">${"x".repeat(500)}</div>`;
  assert.equal(operativeHtmlWithinLimit(article + annex, article.length), article);

  const cases = [
    ["no annex", article + "y".repeat(500)],
    ["no article before the annex", `<div id="anx_1">ANNEX</div>${article}`],
    ["operative part still too large", article + "z".repeat(500) + annex],
  ];
  for (const [label, html] of cases) {
    assert.throws(() => operativeHtmlWithinLimit(html, article.length), (error) => {
      assert.equal(error.oversized, true, label);
      assert.match(error.message, /no safe operative-only fallback/);
      return true;
    }, label);
  }
});
