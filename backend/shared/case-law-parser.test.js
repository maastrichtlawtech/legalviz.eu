const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  CITATION_PARSER_VERSION,
  extractArticleCitationsFromText,
  hydrateContextualRefs,
  resolveInstrumentCelex,
} = require('./case-law-parser');

function refsFromHtml(html) {
  const dom = new JSDOM(html);
  return extractArticleCitationsFromText(dom.window.document.body.textContent);
}

test('case-law citation parser has an explicit cache-invalidating version', () => {
  assert.equal(CITATION_PARSER_VERSION, 14);
});

test('keeps ECHR citations explicit without treating them as unresolved EU acts', () => {
  const parsed = extractArticleCitationsFromText('Article 10 of the ECHR.');
  assert.deepEqual(parsed.articleRefs.map(({ article, act, actCelex, externalConvention }) => ({
    article, act, actCelex, externalConvention,
  })), [{ article: '10', act: 'ECHR', actCelex: null, externalConvention: true }]);
});

test('parses coordinated articles and a trailing named point from modern judgment HTML', () => {
  const parsed = refsFromHtml(`
    <div class="coj-container">
      <p class="coj-normal">Article 6(4) and Article 9(2), point (g), of Regulation (EU) 2016/679</p>
    </div>
  `);

  assert.deepEqual(
    parsed.articleRefs.map(({ article, paragraph, point, actCelex }) => ({ article, paragraph, point, actCelex })),
    [
      { article: '6', paragraph: '4', point: null, actCelex: '32016R0679' },
      { article: '9', paragraph: '2', point: 'g', actCelex: '32016R0679' },
    ],
  );
});

test('parses lists and resolves non-whitelisted directives in older Curia HTML', () => {
  const parsed = refsFromHtml(`
    <P class="C01PointnumeroteAltN">Articles 15, 16 and 17 of Directive 2004/48/EC must be interpreted as meaning ...</P>
  `);

  assert.deepEqual(parsed.articleRefs.map((ref) => ref.article), ['15', '16', '17']);
  assert.ok(parsed.articleRefs.every((ref) => ref.actCelex === '32004L0048'));
});

test('expands bounded ranges found in pre-2004 OJ-style HTML', () => {
  const parsed = refsFromHtml(`
    <font class="oj-font2">Articles 12 to 15 of Council Directive 95/46/EC</font>
  `);

  assert.deepEqual(parsed.articleRefs.map((ref) => ref.article), ['12', '13', '14', '15']);
  assert.ok(parsed.articleRefs.every((ref) => ref.actCelex === '31995L0046'));
});

test('parses abbreviated points and direct treaty citations', () => {
  const parsed = extractArticleCitationsFromText(
    'Article 6(1)(a) and (b) of the GDPR must be read in the light of Article 16 TFEU.',
  );

  assert.deepEqual(
    parsed.articleRefs.map(({ article, paragraph, point, actCelex }) => ({ article, paragraph, point, actCelex })),
    [
      { article: '6', paragraph: '1', point: 'a', actCelex: '32016R0679' },
      { article: '6', paragraph: '1', point: 'b', actCelex: '32016R0679' },
      { article: '16', paragraph: null, point: null, actCelex: '12012E' },
    ],
  );
});

test('parses abbreviated paragraph lists', () => {
  const parsed = extractArticleCitationsFromText('Article 15(1) and (3) of the GDPR');
  assert.deepEqual(
    parsed.articleRefs.map(({ article, paragraph, point }) => ({ article, paragraph, point })),
    [
      { article: '15', paragraph: '1', point: null },
      { article: '15', paragraph: '3', point: null },
    ],
  );
});

test('resolves old and new instrument-number conventions without a whitelist', () => {
  assert.equal(
    resolveInstrumentCelex({ actType: 'regulation', identifier: '44/2001', hasNo: true }),
    '32001R0044',
  );
  assert.equal(
    resolveInstrumentCelex({ actType: 'regulation', identifier: '2022/2065' }),
    '32022R2065',
  );
  assert.equal(
    resolveInstrumentCelex({ actType: 'directive', identifier: '93/13' }),
    '31993L0013',
  );
  assert.equal(
    resolveInstrumentCelex({ actType: 'decision', identifier: '2000/520' }),
    '32000D0520',
  );
});

test('recognises qualified instrument names used in judgments', () => {
  const parsed = extractArticleCitationsFromText(
    'Article 8 of Council Framework Decision 2008/977/JHA and Article 4 of Commission Implementing Decision (EU) 2021/915.',
  );
  assert.deepEqual(
    parsed.articleRefs.map(({ article, actCelex }) => ({ article, actCelex })),
    [
      { article: '8', actCelex: '32008F0977' },
      { article: '4', actCelex: '32021D0915' },
    ],
  );
});

test('parses historical Treaty names and spaced article typography', () => {
  const parsed = extractArticleCitationsFromText(
    'Article 177 of the EEC Treaty; Articles 85 and 86 of the EC Treaty; '
    + 'Article 6 ( 3 ) of Regulation No 136/64/EEC.',
  );
  assert.deepEqual(
    parsed.articleRefs.map(({ article, paragraph, act, actCelex }) => ({ article, paragraph, act, actCelex })),
    [
      { article: '177', paragraph: null, act: 'EEC Treaty', actCelex: '11957E' },
      { article: '85', paragraph: null, act: 'EC Treaty', actCelex: '12002E' },
      { article: '86', paragraph: null, act: 'EC Treaty', actCelex: '12002E' },
      { article: '6', paragraph: '3', act: '136/64', actCelex: '31964R0136' },
    ],
  );
});

test('parses EEC-prefixed, bracketed, basic, and semicolon-separated instruments', () => {
  const parsed = extractArticleCitationsFromText(
    'Article 7 of EEC Regulation No 1612/68; '
    + 'Article 8 of [Directive 91/414/EEC]; '
    + 'Article 14 of the basic Regulation No 516/77; '
    + 'Article 48; Regulation No 38/64/EEC.',
  );
  assert.deepEqual(
    parsed.articleRefs.map(({ article, actCelex }) => ({ article, actCelex })),
    [
      { article: '7', actCelex: '31968R1612' },
      { article: '8', actCelex: '31991L0414' },
      { article: '14', actCelex: '31977R0516' },
      { article: '48', actCelex: '31964R0038' },
    ],
  );
});

test('disambiguates Directive No year-first and legacy Decision number-first forms', () => {
  const parsed = extractArticleCitationsFromText(
    'Article 9 of Directive No 64/433/EEC and Article 1 of Commission Decision 3632/93/ECSC.',
  );
  assert.deepEqual(
    parsed.articleRefs.map(({ article, actCelex }) => ({ article, actCelex })),
    [
      { article: '9', actCelex: '31964L0433' },
      { article: '1', actCelex: '31993D3632' },
    ],
  );
});

test('disambiguates historical No-labelled year/number forms without guessing damaged identifiers', () => {
  const parsed = extractArticleCitationsFromText(
    'Article 4 of Council Decision No 65/271/EEC; '
    + 'Article 1 of Decision No 83/396; '
    + 'Article 4(1) of Regulation No 90/435; '
    + 'Article 5 of Regulation (EC) No 1924/2006; '
    + 'Article 2 of Regulation No 2027/97; '
    + 'Article 7 of Regulation (EU) No 2017/1001; '
    + 'Article 27 of Regulation No 2038/1999; '
    + 'Article 1 of Regulation 1924/2006; '
    + 'Articles 2 and 5 of Council Directive 228/67; '
    + 'Article 5(3) of Directive 199/44.',
  );
  assert.deepEqual(parsed.articleRefs.map(({ article, actCelex }) => ({ article, actCelex })), [
    { article: '4', actCelex: '31965D0271' },
    { article: '1', actCelex: '31983D0396' },
    { article: '4', actCelex: '31990R0435' },
    { article: '5', actCelex: '32006R1924' },
    { article: '2', actCelex: '31997R2027' },
    { article: '7', actCelex: '32017R1001' },
    { article: '27', actCelex: '31999R2038' },
    { article: '1', actCelex: '32006R1924' },
    { article: '2', actCelex: '31967L0228' },
    { article: '5', actCelex: '31967L0228' },
    { article: '5', actCelex: null },
  ]);
});

test('resolves historic Euratom Treaty citations', () => {
  const parsed = extractArticleCitationsFromText('Article 150 of the EAEC Treaty.');
  assert.equal(parsed.articleRefs[0].act, 'Euratom Treaty');
  assert.equal(parsed.articleRefs[0].actCelex, '11957A');
});

test('repairs only uniquely corroborated omitted identifier digits in the same judgment', () => {
  const parsed = extractArticleCitationsFromText(
    'Article 10 of Regulation No 574/2; Article 107 of Regulation No 574/72; '
    + 'Article 5 of Directive 199/44; Article 8 of Directive 1999/44; '
    + 'Article 226 of Directive 206/112; Article 178 of Directive 2006/112; '
    + 'Article 14 of Directive 210/24.',
  );
  assert.deepEqual(parsed.articleRefs.map(({ article, act, actCelex }) => ({ article, act, actCelex })), [
    { article: '10', act: '574/72', actCelex: '31972R0574' },
    { article: '107', act: '574/72', actCelex: '31972R0574' },
    { article: '5', act: '1999/44', actCelex: '31999L0044' },
    { article: '8', act: '1999/44', actCelex: '31999L0044' },
    { article: '226', act: '2006/112', actCelex: '32006L0112' },
    { article: '178', act: '2006/112', actCelex: '32006L0112' },
    { article: '14', act: '210/24', actCelex: null },
  ]);
});

test('normalises ambiguous and footnote-suffixed historical case-law identifiers', () => {
  const parsed = extractArticleCitationsFromText(
    'Article 36 of Regulation 40/94; Article 1 of Decision No 3632/9364/ECSC.',
  );
  assert.deepEqual(
    parsed.articleRefs.map(({ article, act, actCelex }) => ({ article, act, actCelex })),
    [
      { article: '36', act: '40/94', actCelex: '31994R0040' },
      { article: '1', act: '3632/93', actCelex: '31993D3632' },
    ],
  );
});

test('parses First Directive and same-Treaty historical shorthand', () => {
  const parsed = extractArticleCitationsFromText(
    'Article 4 of First Directive 89/104/EEC and Article 7 of the same Treaty.',
  );
  assert.equal(parsed.articleRefs[0].actCelex, '31989L0104');
  assert.equal(parsed.articleRefs[1].act, 'Treaty');
  assert.equal(parsed.articleRefs[1].contextual, true);
});

test('tolerates respectively and ellipses in reported-case citation typography', () => {
  const parsed = extractArticleCitationsFromText(
    'Articles 3 and 12 respectively of First Directive 89/104/EEC; '
    + 'Article 7 … of [Directive 89/104/EEC].',
  );
  assert.deepEqual(parsed.articleRefs.map(({ article, actCelex }) => ({ article, actCelex })), [
    { article: '3', actCelex: '31989L0104' },
    { article: '12', actCelex: '31989L0104' },
    { article: '7', actCelex: '31989L0104' },
  ]);
});

test('parses reporter brackets, unparenthesized points, and final indents', () => {
  const parsed = extractArticleCitationsFromText(
    'Articles 26(2), 28 and 34 [TFEU]; Article 47 of the [Charter]; '
    + 'Article 4, point 5, of Regulation (EEC) No 2913/92; '
    + 'Article 10(1), final indent, of Directive 98/34/EC.',
  );
  assert.deepEqual(
    parsed.articleRefs.map(({ article, paragraph, point, actCelex }) => ({ article, paragraph, point, actCelex })),
    [
      { article: '26', paragraph: '2', point: null, actCelex: '12012E' },
      { article: '28', paragraph: null, point: null, actCelex: '12012E' },
      { article: '34', paragraph: null, point: null, actCelex: '12012E' },
      { article: '47', paragraph: null, point: null, actCelex: '12012P' },
      { article: '4', paragraph: null, point: '5', actCelex: '31992R2913' },
      { article: '10', paragraph: '1', point: null, actCelex: '31998L0034' },
    ],
  );
});

test('binds articles across coordinated annex clauses and quoted labels', () => {
  const parsed = extractArticleCitationsFromText(
    'Articles 3, 3a and 11 of, and annexes II and VI to, Regulation (EU) No 833/2014; '
    + 'Article 3, ‘beneficiaries’, of Directive 2004/38/EC.',
  );
  assert.deepEqual(parsed.articleRefs.map(({ article, actCelex }) => ({ article, actCelex })), [
    { article: '3', actCelex: '32014R0833' },
    { article: '3a', actCelex: '32014R0833' },
    { article: '11', actCelex: '32014R0833' },
    { article: '3', actCelex: '32004L0038' },
  ]);
});

test('handles bracket order, bracketed institutions, recitals, and annex variants', () => {
  const parsed = extractArticleCitationsFromText(
    'Articles 7 and/or 8 of [the Charter; Articles 4 and 7 of [Council] Decision 1999/468/EC; '
    + 'Article 2(3) and recital 9 of Directive 2006/123/EC; '
    + 'Article 4 and annex II of Decision 2013/448/EU; '
    + 'Article 1(3) of that same Directive.',
  );
  assert.deepEqual(parsed.articleRefs.map(({ article, actCelex, contextual }) => ({ article, actCelex, contextual })), [
    { article: '7', actCelex: '12012P', contextual: false },
    { article: '8', actCelex: '12012P', contextual: false },
    { article: '4', actCelex: '31999D0468', contextual: false },
    { article: '7', actCelex: '31999D0468', contextual: false },
    { article: '2', actCelex: '32006L0123', contextual: false },
    { article: '4', actCelex: '32013D0448', contextual: false },
    { article: '1', actCelex: null, contextual: true },
  ]);
});

test('handles recital bridges, entitled insertions, and named contextual acts', () => {
  const parsed = extractArticleCitationsFromText(
    'Article 2(3) and recital 9 of Directive 2006/123/EC; '
    + 'Article 4(6) and (7), and in the light of recital 9 of that Directive; '
    + 'Article 133a, entitled ‘transitional national aid’ into Regulation No 73/2009; '
    + 'Article 12 of the Authorisation Directive; Article 2 of the SGEI Decision; '
    + 'Article 1: ‘this Decision applies’.',
  );
  assert.deepEqual(
    parsed.articleRefs.map(({ article, paragraph, act, actCelex, contextual }) => (
      { article, paragraph, act, actCelex, contextual }
    )),
    [
      { article: '2', paragraph: '3', act: '2006/123', actCelex: '32006L0123', contextual: false },
      { article: '4', paragraph: '6', act: 'that Directive', actCelex: null, contextual: true },
      { article: '4', paragraph: '7', act: 'that Directive', actCelex: null, contextual: true },
      { article: '133a', paragraph: null, act: '73/2009', actCelex: '32009R0073', contextual: false },
      { article: '12', paragraph: null, act: 'Authorisation Directive', actCelex: null, contextual: true },
      { article: '2', paragraph: null, act: 'SGEI Decision', actCelex: null, contextual: true },
      { article: '1', paragraph: null, act: 'this Decision', actCelex: null, contextual: true },
    ],
  );
});

test('parses plural instrument labels and contextual act descriptions', () => {
  const parsed = extractArticleCitationsFromText(
    'Article 8(1)(b) of Directives 73/239/EEC; '
    + 'Article 6(2) of this Directive; Article 17(2) of that Charter; '
    + 'Article 10c of the latter Regulation.',
  );
  assert.deepEqual(
    parsed.articleRefs.map(({ article, act, actCelex, contextual }) => ({ article, act, actCelex, contextual })),
    [
      { article: '8', act: '73/239', actCelex: '31973L0239', contextual: false },
      { article: '6', act: 'this Directive', actCelex: null, contextual: true },
      { article: '17', act: 'Charter', actCelex: '12012P', contextual: true },
      { article: '10c', act: 'latter Regulation', actCelex: null, contextual: true },
    ],
  );
});

test('keeps subparagraph, indent, and nested-point qualifiers attached to their acts', () => {
  const parsed = extractArticleCitationsFromText(
    'Article 5(1), first subparagraph, point (g), of Directive 2002/58/EC; '
    + 'Article 2(2)(a), second indent, of Directive 2002/58/EC; '
    + 'Article 4(2)(a)(i) of Directive 2002/58/EC.',
  );
  assert.deepEqual(
    parsed.articleRefs.map(({ article, paragraph, point, actCelex }) => ({ article, paragraph, point, actCelex })),
    [
      { article: '5', paragraph: '1', point: 'g', actCelex: '32002L0058' },
      { article: '2', paragraph: '2', point: 'a', actCelex: '32002L0058' },
      { article: '4', paragraph: '2', point: 'a(i)', actCelex: '32002L0058' },
    ],
  );
});

test('expands paragraph and point ranges', () => {
  const parsed = extractArticleCitationsFromText(
    'Article 5(2) to (6) and Article 19(1)(a) to (e) of Directive 2002/58/EC',
  );
  assert.deepEqual(
    parsed.articleRefs.filter((ref) => ref.article === '5').map((ref) => ref.paragraph),
    ['2', '3', '4', '5', '6'],
  );
  assert.deepEqual(
    parsed.articleRefs.filter((ref) => ref.article === '19').map((ref) => ref.point),
    ['a', 'b', 'c', 'd', 'e'],
  );
});

test('binds read-in-conjunction citations and retains thereof as contextual', () => {
  const joined = extractArticleCitationsFromText(
    'Article 7, read in conjunction with Article 8, of Directive 95/46/EC',
  );
  assert.deepEqual(joined.articleRefs.map((ref) => ref.article), ['7', '8']);
  assert.ok(joined.articleRefs.every((ref) => ref.actCelex === '31995L0046'));

  const thereof = extractArticleCitationsFromText('Article 3(1)(a) thereof');
  assert.equal(thereof.articleRefs[0].contextual, true);
  assert.equal(thereof.articleRefs[0].act, 'thereof');
});

test('keeps contextual citations and hydrates them for the law being interpreted', () => {
  const parsed = extractArticleCitationsFromText('Article 3 of that Directive must be interpreted as meaning ...');
  assert.equal(parsed.articleRefs[0].contextual, true);
  assert.equal(parsed.articleRefs[0].actCelex, null);

  const hydrated = hydrateContextualRefs(parsed.articleRefs, '32004L0048');
  assert.equal(hydrated[0].actCelex, '32004L0048');
  assert.equal(hydrateContextualRefs(parsed.articleRefs, '32022R2065')[0].actCelex, null);
});

test('does not bind an article to an act across unrelated prose', () => {
  const parsed = extractArticleCitationsFromText(
    'Article 7 applies and takes account of the objectives of Regulation (EU) 2018/1725.',
  );
  assert.deepEqual(parsed.articleRefs, []);
});
