const test = require('node:test');
const assert = require('node:assert/strict');

const {
  bindArticleRefsToExternalRefs,
  bindThereofArticleRefs,
  dedupeReferences,
  parseInstrumentIdentifier,
  resolveInstrumentCelex,
  scanArticleEnumerations,
} = require('./legal-reference-core.cjs');

test('shared scanner expands lists, bounded ranges, and abbreviated points', () => {
  const list = scanArticleEnumerations('Articles 12 to 15 and Article 18(2), point (g)');

  assert.deepEqual(
    list[0].items.map(({ articleNumber, paragraph, point }) => ({ articleNumber, paragraph, point })),
    [
      { articleNumber: '12', paragraph: null, point: null },
      { articleNumber: '13', paragraph: null, point: null },
      { articleNumber: '14', paragraph: null, point: null },
      { articleNumber: '15', paragraph: null, point: null },
      { articleNumber: '18', paragraph: '2', point: 'g' },
    ],
  );
});

test('shared scanner expands paragraph and alphabetic point ranges', () => {
  const paragraphs = scanArticleEnumerations('Article 5(2) to (6)');
  const points = scanArticleEnumerations('Article 19(1)(a) to (e)');
  assert.deepEqual(paragraphs[0].items.map((item) => item.paragraph), ['2', '3', '4', '5', '6']);
  assert.deepEqual(points[0].items.map((item) => item.point), ['a', 'b', 'c', 'd', 'e']);
});

test('shared scanner consumes three or more abbreviated paragraph members', () => {
  const refs = scanArticleEnumerations('Article 6(2), (3) and (4) of this Directive');
  assert.deepEqual(refs[0].items.map((item) => item.paragraph), ['2', '3', '4']);
  assert.equal(refs[0].end, 'Article 6(2), (3) and (4)'.length);
});

test('shared scanner accepts bare named points and numeric paragraph qualifiers', () => {
  const refs = scanArticleEnumerations(
    'Article 4, point 5, and Article 10, paragraph 2(b), of Regulation 1/2003',
  );
  assert.deepEqual(
    refs[0].items.map(({ articleNumber, paragraph, point }) => ({ articleNumber, paragraph, point })),
    [
      { articleNumber: '4', paragraph: null, point: '5' },
      { articleNumber: '10', paragraph: '2', point: 'b' },
    ],
  );
});

test('shared scanner consumes bracketed ordinal qualifiers', () => {
  const refs = scanArticleEnumerations('Article 10a(5), [first] subparagraph, (a) and (b)');
  assert.deepEqual(refs[0].items.map((item) => item.point), [null, 'a', 'b']);
});

test('shared scanner tolerates historical spaces inside parenthetical qualifiers', () => {
  const refs = scanArticleEnumerations('Articles 6 ( 2 ) and 7 ( 3 ) ( a )');
  assert.deepEqual(
    refs[0].items.map(({ articleNumber, paragraph, point }) => ({ articleNumber, paragraph, point })),
    [
      { articleNumber: '6', paragraph: '2', point: null },
      { articleNumber: '7', paragraph: '3', point: 'a' },
    ],
  );
});

test('shared scanner retains ordinal paragraph qualifiers before an act', () => {
  const refs = scanArticleEnumerations('Article 263, first paragraph, TFEU');
  assert.equal(refs[0].items[0].articleNumber, '263');
  assert.equal(refs[0].items[0].paragraph, '1');
  assert.equal(refs[0].end, 'Article 263, first paragraph'.length);
});

test('shared resolver handles modern and legacy EU numbering conventions', () => {
  assert.equal(
    resolveInstrumentCelex({ actType: 'directive', identifier: '2004/48/EC' }),
    '32004L0048',
  );
  assert.equal(
    resolveInstrumentCelex({ actType: 'regulation', identifier: '44/2001', hasNo: true }),
    '32001R0044',
  );
  assert.equal(
    resolveInstrumentCelex({ actType: 'regulation', identifier: '1/2003', hasNo: true }),
    '32003R0001',
  );
  assert.equal(
    resolveInstrumentCelex({ actType: 'regulation', identifier: '193/75', allowHistoricalNoLabel: true }),
    '31975R0193',
  );
  assert.equal(
    resolveInstrumentCelex({ actType: 'regulation', identifier: '574/72' }),
    '31972R0574',
  );
  assert.equal(
    resolveInstrumentCelex({ actType: 'decision', identifier: '3289/75/ECSC' }),
    '31975S3289',
  );
  assert.equal(
    resolveInstrumentCelex({ actType: 'recommendation', identifier: '1/64', ecscAuthority: true }),
    '31964S0001',
  );
  assert.equal(
    resolveInstrumentCelex({ actType: 'regulation', identifier: '2040/2000', institutionalIssuer: true }),
    '32000R2040',
  );
  assert.equal(
    resolveInstrumentCelex({ actType: 'regulation', identifier: '2016/679' }),
    '32016R0679',
  );
  assert.equal(
    resolveInstrumentCelex({ actType: 'recommendation', identifier: '2003/361/EC' }),
    '32003H0361',
  );
  assert.equal(
    resolveInstrumentCelex({ actType: 'directive', identifier: '64/433/EEC', hasNo: true }),
    '31964L0433',
  );
});

test('shared identifier normalization disambiguates year-first and No number-first forms', () => {
  assert.deepEqual(
    parseInstrumentIdentifier({ actType: 'directive', identifier: '95/46/EC' }),
    { year: '1995', number: '46', suffix: 'EC' },
  );
  assert.deepEqual(
    parseInstrumentIdentifier({ actType: 'regulation', identifier: '2306/70', hasNo: true }),
    { year: '1970', number: '2306', suffix: null },
  );
  assert.deepEqual(
    parseInstrumentIdentifier({ actType: 'regulation', identifier: '44/2001', hasNo: true }),
    { year: '2001', number: '44', suffix: null },
  );
  assert.deepEqual(
    parseInstrumentIdentifier({ actType: 'regulation', identifier: '1924/2006', hasNo: true }),
    { year: '2006', number: '1924', suffix: null },
  );
  assert.deepEqual(
    parseInstrumentIdentifier({ actType: 'regulation', identifier: '2027/97', hasNo: true }),
    { year: '1997', number: '2027', suffix: null },
  );
  assert.deepEqual(
    parseInstrumentIdentifier({ actType: 'regulation', identifier: '2017/1001', hasNo: true }),
    { year: '2017', number: '1001', suffix: null },
  );
  assert.deepEqual(
    parseInstrumentIdentifier({ actType: 'regulation', identifier: '2038/1999', hasNo: true }),
    { year: '1999', number: '2038', suffix: null },
  );
  assert.deepEqual(
    parseInstrumentIdentifier({ actType: 'regulation', identifier: '1924/2006' }),
    { year: '2006', number: '1924', suffix: null },
  );
  assert.deepEqual(
    parseInstrumentIdentifier({ actType: 'regulation', identifier: '2306/70' }),
    { year: null, number: null, suffix: null },
  );
});

test('shared binder joins only nearby article-of-act phrases', () => {
  const boundText = 'Article 5 of Directive 2002/58/EC';
  const article = [{ type: 'article', target: '5', start: 0, end: 9 }];
  const actStart = boundText.indexOf('Directive');
  const external = [{ type: 'external', target: '2002/58/EC', start: actStart, end: boundText.length }];
  const bound = bindArticleRefsToExternalRefs(boundText, article, external);

  assert.equal(bound.articleRefs.length, 0);
  assert.equal(bound.externalRefs[0].articleNumber, '5');

  const unrelatedText = 'Article 5 must be considered alongside Directive 2002/58/EC';
  const unrelatedStart = unrelatedText.indexOf('Directive');
  const unrelated = bindArticleRefsToExternalRefs(
    unrelatedText,
    article,
    [{ ...external[0], start: unrelatedStart, end: unrelatedText.length }],
  );
  assert.equal(unrelated.articleRefs.length, 1);
  assert.equal(unrelated.externalRefs[0].articleNumber, undefined);
});

test('shared binder accepts definite articles and closed legal-list qualifiers', () => {
  const text = 'Articles 19a, 29a or 40a, as the case may be, of the Directive 2013/34/EU';
  const actStart = text.indexOf('Directive');
  const articleEnd = text.indexOf(', as the case');
  const bound = bindArticleRefsToExternalRefs(
    text,
    [{ type: 'article', target: '19a', start: 0, end: articleEnd }],
    [{ type: 'external', target: '2013/34/EU', start: actStart, end: text.length }],
  );
  assert.equal(bound.articleRefs.length, 0);
  assert.equal(bound.externalRefs[0].articleNumber, '19a');
});

test('shared binder carries coordinated treaty articles to a trailing bare acronym', () => {
  const text = 'Article 169(1), and point (a) of Article 169(2), TFEU';
  const actStart = text.indexOf('TFEU');
  const bound = bindArticleRefsToExternalRefs(
    text,
    [{ type: 'article', target: '169', paragraph: '1', start: 0, end: 'Article 169(1)'.length }],
    [{ type: 'external', target: 'TFEU', start: actStart, end: text.length, allowBareArticleBinding: true }],
  );
  assert.equal(bound.articleRefs.length, 0);
  assert.equal(bound.externalRefs[0].articleNumber, '169');
  assert.equal(bound.externalRefs[0].paragraph, '1');
});

test('shared binder crosses a nested article-of-article list to the common act', () => {
  const text = 'Article 10a and point (a) of Article 10b(1) of Directive 90/385/EEC';
  const actStart = text.indexOf('Directive');
  const bound = bindArticleRefsToExternalRefs(
    text,
    [{ type: 'article', target: '10a', start: 0, end: 'Article 10a'.length }],
    [{ type: 'external', target: '90/385/EEC', start: actStart, end: text.length }],
  );
  assert.equal(bound.articleRefs.length, 0);
  assert.equal(bound.externalRefs[0].articleNumber, '10a');
});

test('thereof binder uses only an explicit act in the same sentence', () => {
  const text = 'Regulation (EU) 2019/1150 applies, including Article 24(3) thereof';
  const articleStart = text.indexOf('Article');
  const articleEnd = text.indexOf(' thereof');
  const actEnd = text.indexOf(' applies');
  const bound = bindThereofArticleRefs(
    text,
    [{ type: 'article', target: '24', paragraph: '3', start: articleStart, end: articleEnd }],
    [{ type: 'external', target: '2019/1150', actCelex: '32019R1150', start: 0, end: actEnd }],
  );
  assert.equal(bound.articleRefs.length, 0);
  assert.equal(bound.externalRefs[0].articleNumber, '24');
  assert.equal(bound.externalRefs[0].paragraph, '3');
  assert.equal(bound.externalRefs[0].actCelex, '32019R1150');

  const separated = text.replace(' applies, including ', ' applies. ');
  const separatedArticleStart = separated.indexOf('Article');
  const separatedArticleEnd = separated.indexOf(' thereof');
  const unbound = bindThereofArticleRefs(
    separated,
    [{ type: 'article', target: '24', paragraph: '3', start: separatedArticleStart, end: separatedArticleEnd }],
    [{ type: 'external', target: '2019/1150', start: 0, end: actEnd }],
  );
  assert.equal(unbound.articleRefs.length, 1);
  assert.equal(unbound.externalRefs.length, 0);

  const flattenedFootnote =
    'Directive (EU) 2018/1972 (OJ L 321, 17.12.2018, p. 36). and, in particular, Article 61 thereof';
  const footnoteArticleStart = flattenedFootnote.indexOf('Article');
  const footnoteArticleEnd = flattenedFootnote.indexOf(' thereof');
  const footnoteActEnd = flattenedFootnote.indexOf(' (OJ');
  const footnoteBound = bindThereofArticleRefs(
    flattenedFootnote,
    [{ type: 'article', target: '61', start: footnoteArticleStart, end: footnoteArticleEnd }],
    [{ type: 'external', target: '2018/1972', start: 0, end: footnoteActEnd }],
  );
  assert.equal(footnoteBound.articleRefs.length, 0);
  assert.equal(footnoteBound.externalRefs[0].articleNumber, '61');
});

test('thereof binder accepts a contextual Treaty antecedent', () => {
  const text = 'Article 137 of the Treaty supports Article 136 thereof';
  const articleStart = text.indexOf('Article 136');
  const articleEnd = articleStart + 'Article 136'.length;
  const treatyStart = text.indexOf('the Treaty');
  const bound = bindThereofArticleRefs(
    text,
    [{ type: 'article', target: '136', start: articleStart, end: articleEnd }],
    [{ type: 'external', target: 'the Treaty', start: treatyStart, end: treatyStart + 10,
      contextual: true, treaty: true }],
  );
  assert.equal(bound.articleRefs.length, 0);
  assert.equal(bound.externalRefs[0].articleNumber, '136');
});

test('shared dedupe preserves separate article edges to the same act', () => {
  const refs = dedupeReferences([
    { type: 'external', target: '2016/679', articleNumber: '6' },
    { type: 'external', target: '2016/679', articleNumber: '9' },
    { type: 'external', target: '2016/679', articleNumber: '6' },
  ]);

  assert.deepEqual(refs.map((ref) => ref.articleNumber), ['6', '9']);
});
