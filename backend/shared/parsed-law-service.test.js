const test = require('node:test');
const assert = require('node:assert/strict');

const { createParsedLawResolver } = require('./parsed-law-service');
const { ClientError } = require('./api-utils');

const os = require('os');
const path = require('path');
const fs = require('fs');

// Minimal but real Formex XML the actual parser (jsdom-backed) turns into a
// combined law with one article, so these tests exercise the real
// prepareLawPayload -> fs.promises.readFile -> parseFmxXml path the consolidated
// fallback uses, not a mocked shortcut.
const MINIMAL_FMX_WITH_ARTICLE = `<?xml version="1.0" encoding="UTF-8"?>
<ACT xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://formex.publications.europa.eu/schema/formex-05.59-20170418.xd">
  <BIB.INSTANCE><LG.DOC>EN</LG.DOC></BIB.INSTANCE>
  <ENACTING.TERMS>
    <DIVISION>
      <ARTICLE IDENTIFIER="001">
        <TI.ART>Article 1</TI.ART>
        <ALINEA><P>Consolidated body text.</P></ALINEA>
      </ARTICLE>
    </DIVISION>
  </ENACTING.TERMS>
</ACT>`;

const EMPTY_FMX = `<?xml version="1.0" encoding="UTF-8"?>
<ACT xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://formex.publications.europa.eu/schema/formex-05.59-20170418.xd">
  <BIB.INSTANCE><LG.DOC>EN</LG.DOC></BIB.INSTANCE>
</ACT>`;

// An as-adopted document with both recitals and one article (Article 1),
// used for the requested-version compose tests: the consolidated fixture
// below carries Article 1 (unchanged) plus a new Article 2 that has no
// as-adopted counterpart, so tests can assert both the recital pairing and
// `insertedInVersion`.
const AS_ADOPTED_FMX_WITH_RECITALS_AND_ARTICLE = `<?xml version="1.0" encoding="UTF-8"?>
<ACT xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://formex.publications.europa.eu/schema/formex-05.59-20170418.xd">
  <BIB.INSTANCE><LG.DOC>EN</LG.DOC></BIB.INSTANCE>
  <PREAMBLE>
    <GR.CONSID>
      <CONSID><NP><NO.P>(1)</NO.P><TXT>As-adopted recital text.</TXT></NP></CONSID>
    </GR.CONSID>
  </PREAMBLE>
  <ENACTING.TERMS>
    <DIVISION>
      <ARTICLE IDENTIFIER="001">
        <TI.ART>Article 1</TI.ART>
        <ALINEA><P>As-adopted body text.</P></ALINEA>
      </ARTICLE>
    </DIVISION>
  </ENACTING.TERMS>
</ACT>`;

// The consolidated ("as amended") version of the act above: Article 1 is
// unchanged, and Article 2 was inserted by a later amendment — EUR-Lex's
// consolidated Formex carries no <PREAMBLE.RECITALS>/<GR.CONSID> block at
// all, which is exactly what the compose is for.
const CONSOLIDATED_FMX_WITH_TWO_ARTICLES = `<?xml version="1.0" encoding="UTF-8"?>
<ACT xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://formex.publications.europa.eu/schema/formex-05.59-20170418.xd">
  <BIB.INSTANCE><LG.DOC>EN</LG.DOC></BIB.INSTANCE>
  <ENACTING.TERMS>
    <DIVISION>
      <ARTICLE IDENTIFIER="001">
        <TI.ART>Article 1</TI.ART>
        <ALINEA><P>As-adopted body text.</P></ALINEA>
      </ARTICLE>
      <ARTICLE IDENTIFIER="002">
        <TI.ART>Article 2</TI.ART>
        <ALINEA><P>Inserted-by-amendment body text.</P></ALINEA>
      </ARTICLE>
    </DIVISION>
  </ENACTING.TERMS>
</ACT>`;

function writeTempXml(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parsed-law-service-test-'));
  const filePath = path.join(dir, 'law.xml');
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

test('resolveParsedLaw uses the HTML fallback path when skipFmxProbe is set and caches the result', async () => {
  let htmlCalls = 0;
  const resolveParsedLaw = createParsedLawResolver({
    prepareLawPayload: async () => { throw new Error('prepareLawPayload should not be called'); },
    fetchAndParseHtmlLaw: async (celex, lang) => {
      htmlCalls += 1;
      return { source: 'eurlex-html', title: `Law ${celex} ${lang}`, articles: [], recitals: [], annexes: [], definitions: [], crossReferences: {} };
    },
    CELEX_NAMES: { '32016R0679': 'GDPR' },
  });

  const first = await resolveParsedLaw('32016R0679', 'ENG', { skipFmxProbe: true });
  assert.equal(first.source, 'eurlex-html');
  assert.equal(first.name, 'GDPR');
  assert.equal(first.format, 'combined-v1');
  assert.equal(first.hasContent, false);

  const second = await resolveParsedLaw('32016R0679', 'ENG', { skipFmxProbe: true });
  assert.equal(second.title, first.title);
  assert.equal(htmlCalls, 1, 'second call for the same celex/lang should be served from cache');

  // A different language is a distinct cache key.
  await resolveParsedLaw('32016R0679', 'FRA', { skipFmxProbe: true });
  assert.equal(htmlCalls, 2);
});

test('resolveParsedLaw falls back to HTML when the FMX probe returns a 404', async () => {
  let htmlCalls = 0;
  const resolveParsedLaw = createParsedLawResolver({
    prepareLawPayload: async () => {
      throw new ClientError('No FMX files found', 404, 'fmx_not_found');
    },
    fetchAndParseHtmlLaw: async () => {
      htmlCalls += 1;
      return { source: 'eurlex-html', articles: [], recitals: [], annexes: [], definitions: [], crossReferences: {} };
    },
  });

  const result = await resolveParsedLaw('32006R1907', 'ENG');

  assert.equal(result.source, 'eurlex-html');
  assert.equal(htmlCalls, 1);
});

test('resolveParsedLaw propagates an FMX read error instead of falling back to HTML', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parsed-law-service-read-error-'));
  let htmlCalls = 0;
  try {
    const resolveParsedLaw = createParsedLawResolver({
      prepareLawPayload: async () => ({ servePath: path.join(dir, 'missing.xml') }),
      fetchAndParseHtmlLaw: async () => {
        htmlCalls += 1;
        return { source: 'eurlex-html', articles: [], recitals: [], annexes: [], definitions: [], crossReferences: {} };
      },
    });

    await assert.rejects(
      () => resolveParsedLaw('32006R1907', 'ENG'),
      (error) => error.code === 'ENOENT'
    );
    assert.equal(htmlCalls, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveParsedLaw propagates servedLang from the HTML fallback without overriding the requested lang', async () => {
  // Simulates the real fetchAndParseHtmlLawCached in server.js, which always serves
  // English HTML (servedLang) even when a different language was requested (lang),
  // so callers can tell the two apart instead of the content being silently mislabeled.
  const resolveParsedLaw = createParsedLawResolver({
    prepareLawPayload: async () => { throw new Error('prepareLawPayload should not be called'); },
    fetchAndParseHtmlLaw: async (celex, lang) => ({
      celex,
      lang,
      servedLang: 'ENG',
      source: 'eurlex-html',
      title: `Law ${celex}`,
      articles: [],
      recitals: [],
      annexes: [],
      definitions: [],
      crossReferences: {},
    }),
  });

  const result = await resolveParsedLaw('32016R0679', 'FRA', { skipFmxProbe: true });
  assert.equal(result.lang, 'FRA', 'top-level lang should stay the requested language for routing/URL state');
  assert.equal(result.servedLang, 'ENG', 'servedLang should surface the language actually served');
});

test('resolveParsedLaw stamps hasContent from parsed collections after spreading the parser result', async () => {
  const resolveParsedLaw = createParsedLawResolver({
    prepareLawPayload: async () => { throw new Error('prepareLawPayload should not be called'); },
    fetchAndParseHtmlLaw: async (celex) => ({
      title: `Law ${celex}`,
      articles: celex === 'empty' ? [] : [{}],
      recitals: [],
      annexes: [],
      definitions: [],
      crossReferences: {},
      hasContent: true,
    }),
  });

  const empty = await resolveParsedLaw('empty', 'ENG', { skipFmxProbe: true });
  const populated = await resolveParsedLaw('populated', 'ENG', { skipFmxProbe: true });

  assert.equal(empty.hasContent, false);
  assert.equal(populated.hasContent, true);
});

test('consolidated fallback: fires when the as-adopted FMX parses to nothing and returns fmx-consolidated content', async () => {
  const emptyXmlPath = writeTempXml(EMPTY_FMX);
  const consolidatedXmlPath = writeTempXml(MINIMAL_FMX_WITH_ARTICLE);

  const prepareLawPayloadCalls = [];
  const resolveParsedLaw = createParsedLawResolver({
    prepareLawPayload: async (celex) => {
      prepareLawPayloadCalls.push(celex);
      return { servePath: celex === '32006R1907' ? emptyXmlPath : consolidatedXmlPath };
    },
    CELEX_NAMES: { '32006R1907': 'REACH' },
    fetchConsolidatedVersions: async (celex) => {
      assert.equal(celex, '32006R1907');
      return { versions: [{ celex: '02006R1907-20260511', date: '2026-05-11' }] };
    },
    runSparqlQuery: async () => ({}),
  });

  const result = await resolveParsedLaw('32006R1907', 'ENG', {});

  assert.equal(result.source, 'fmx-consolidated');
  assert.equal(result.hasContent, true);
  assert.equal(result.articles.length, 1);
  assert.deepEqual(result.consolidatedVersion, { celex: '02006R1907-20260511', date: '2026-05-11' });
  assert.deepEqual(prepareLawPayloadCalls, ['32006R1907', '02006R1907-20260511']);

  // Memoized under the base CELEX, not the consolidated one.
  const cached = await resolveParsedLaw('32006R1907', 'ENG', {});
  assert.equal(cached.source, 'fmx-consolidated');
  assert.deepEqual(prepareLawPayloadCalls, ['32006R1907', '02006R1907-20260511'], 'second call should be served from cache');
});

test('consolidated fallback: applies even when skipFmxProbe is set', async () => {
  const consolidatedXmlPath = writeTempXml(MINIMAL_FMX_WITH_ARTICLE);

  // skipFmxProbe only means "don't probe this act's own FMX" — it must not
  // suppress the consolidated fallback, and the html fallback (which runs
  // first when skipFmxProbe is set) still parses to nothing here.
  const resolveParsedLawSkip = createParsedLawResolver({
    prepareLawPayload: async () => ({ servePath: consolidatedXmlPath }),
    fetchAndParseHtmlLaw: async () => ({ source: 'eurlex-html', title: 'REACH', articles: [], recitals: [], annexes: [], definitions: [], crossReferences: {} }),
    fetchConsolidatedVersions: async () => ({ versions: [{ celex: '02006R1907-20260511', date: '2026-05-11' }] }),
    runSparqlQuery: async () => ({}),
  });

  const result = await resolveParsedLawSkip('32006R1907', 'ENG', { skipFmxProbe: true });
  assert.equal(result.source, 'fmx-consolidated');
  assert.equal(result.hasContent, true);
});

test('consolidated fallback: does not fire when every consolidated version is future-dated', async () => {
  const emptyXmlPath = writeTempXml(EMPTY_FMX);
  let prepareLawPayloadCallCount = 0;

  const resolveParsedLaw = createParsedLawResolver({
    prepareLawPayload: async () => {
      prepareLawPayloadCallCount += 1;
      return { servePath: emptyXmlPath };
    },
    fetchConsolidatedVersions: async () => ({ versions: [{ celex: '02006R1907-20990101', date: '2099-01-01' }] }),
    runSparqlQuery: async () => ({}),
  });

  const result = await resolveParsedLaw('32006R1907', 'ENG', {});

  assert.equal(result.source, 'fmx');
  assert.equal(result.hasContent, false);
  assert.equal(result.consolidatedVersion, undefined);
  // Only the base-CELEX FMX probe should have run — no consolidated version
  // is "current" (selectConsolidatedVersions.current is null), so
  // prepareLawPayload must not be called a second time for a future-dated
  // consolidated CELEX.
  assert.equal(prepareLawPayloadCallCount, 1);
});

test('consolidated fallback: a fetchConsolidatedVersions throw leaves the empty result intact', async () => {
  const emptyXmlPath = writeTempXml(EMPTY_FMX);

  const resolveParsedLaw = createParsedLawResolver({
    prepareLawPayload: async () => ({ servePath: emptyXmlPath }),
    fetchConsolidatedVersions: async () => { throw new Error('Cellar is down'); },
    runSparqlQuery: async () => ({}),
  });

  const result = await resolveParsedLaw('32006R1907', 'ENG', {});

  assert.equal(result.source, 'fmx');
  assert.equal(result.hasContent, false);
  assert.equal(result.consolidatedVersion, undefined);
});

test('consolidated fallback: a non-sector-3 id never calls SPARQL', async () => {
  const { fetchConsolidatedVersions } = require('./law-queries');
  const emptyXmlPath = writeTempXml(EMPTY_FMX);
  let sparqlCalled = false;

  const resolveParsedLaw = createParsedLawResolver({
    prepareLawPayload: async () => ({ servePath: emptyXmlPath }),
    // The real fetchConsolidatedVersions: it short-circuits to [] for an id
    // that isn't shaped like an original act, without calling runSparqlQuery.
    fetchConsolidatedVersions,
    runSparqlQuery: async () => { sparqlCalled = true; return {}; },
  });

  // Already a point-in-time consolidated id, not an original-act CELEX.
  const result = await resolveParsedLaw('02006R1907-20260511', 'ENG', {});

  assert.equal(result.source, 'fmx');
  assert.equal(result.hasContent, false);
  assert.equal(sparqlCalled, false);
});

test('consolidated fallback: does not run at all when content is already present', async () => {
  const populatedXmlPath = writeTempXml(MINIMAL_FMX_WITH_ARTICLE);
  let fallbackCalled = false;

  const resolveParsedLaw = createParsedLawResolver({
    prepareLawPayload: async () => ({ servePath: populatedXmlPath }),
    fetchConsolidatedVersions: async () => { fallbackCalled = true; return { versions: [] }; },
    runSparqlQuery: async () => ({}),
  });

  const result = await resolveParsedLaw('32016R0679', 'ENG', {});

  assert.equal(result.source, 'fmx');
  assert.equal(result.hasContent, true);
  assert.equal(fallbackCalled, false);
});

test('requested version "current": composes consolidated articles with as-adopted recitals', async () => {
  const asAdoptedPath = writeTempXml(AS_ADOPTED_FMX_WITH_RECITALS_AND_ARTICLE);
  const consolidatedPath = writeTempXml(CONSOLIDATED_FMX_WITH_TWO_ARTICLES);

  const resolveParsedLaw = createParsedLawResolver({
    prepareLawPayload: async (celex) => ({
      servePath: celex === '32013R0575' ? asAdoptedPath : consolidatedPath,
    }),
    fetchConsolidatedVersions: async (celex) => {
      assert.equal(celex, '32013R0575');
      return { versions: [{ celex: '02013R0575-20260626', date: '2026-06-26' }] };
    },
    runSparqlQuery: async () => ({}),
  });

  const result = await resolveParsedLaw('32013R0575', 'ENG', { version: 'current' });

  assert.equal(result.source, 'fmx-consolidated');
  assert.equal(result.version, 'current');
  assert.equal(result.versionCelex, '02013R0575-20260626');
  assert.equal(result.versionDate, '2026-06-26');
  assert.equal(result.recitalsSource, 'as-adopted');
  assert.deepEqual(result.consolidatedVersion, { celex: '02013R0575-20260626', date: '2026-06-26' });
  assert.equal(result.versionUnavailable, undefined);

  // Articles come from the consolidated document (both Article 1 and 2)…
  assert.equal(result.articles.length, 2);
  // …while recitals come from the as-adopted document, not the consolidated
  // one (which carries none at all).
  assert.equal(result.recitals.length, 1);
  assert.equal(result.recitals[0].recital_text, 'As-adopted recital text.');
});

test('requested version "current": insertedInVersion is set only on articles with no as-adopted counterpart', async () => {
  const asAdoptedPath = writeTempXml(AS_ADOPTED_FMX_WITH_RECITALS_AND_ARTICLE);
  const consolidatedPath = writeTempXml(CONSOLIDATED_FMX_WITH_TWO_ARTICLES);

  const resolveParsedLaw = createParsedLawResolver({
    prepareLawPayload: async (celex) => ({
      servePath: celex === '32013R0575' ? asAdoptedPath : consolidatedPath,
    }),
    fetchConsolidatedVersions: async () => ({ versions: [{ celex: '02013R0575-20260626', date: '2026-06-26' }] }),
    runSparqlQuery: async () => ({}),
  });

  const result = await resolveParsedLaw('32013R0575', 'ENG', { version: 'current' });

  const byNumber = Object.fromEntries(result.articles.map((a) => [a.article_number, a]));
  assert.equal(byNumber['1'].insertedInVersion, undefined, 'Article 1 exists as-adopted, so it must not be flagged');
  assert.equal(byNumber['2'].insertedInVersion, true, 'Article 2 has no as-adopted counterpart');
});

test('requested version "current": does not label every article inserted when the as-adopted baseline is empty', async () => {
  const emptyAsAdoptedPath = writeTempXml(EMPTY_FMX);
  const consolidatedPath = writeTempXml(CONSOLIDATED_FMX_WITH_TWO_ARTICLES);

  const resolveParsedLaw = createParsedLawResolver({
    prepareLawPayload: async (celex) => ({
      servePath: celex === '32013R0575' ? emptyAsAdoptedPath : consolidatedPath,
    }),
    fetchConsolidatedVersions: async () => ({ versions: [{ celex: '02013R0575-20260626', date: '2026-06-26' }] }),
    runSparqlQuery: async () => ({}),
  });

  const result = await resolveParsedLaw('32013R0575', 'ENG', { version: 'current' });

  assert.equal(result.articles.length, 2);
  assert.equal(
    result.articles.some((article) => article.insertedInVersion),
    false,
    'an empty baseline cannot prove that any consolidated article was inserted',
  );
});

test('requested version "current": falls back with versionUnavailable when no consolidated version exists', async () => {
  const asAdoptedPath = writeTempXml(AS_ADOPTED_FMX_WITH_RECITALS_AND_ARTICLE);

  const resolveParsedLaw = createParsedLawResolver({
    prepareLawPayload: async () => ({ servePath: asAdoptedPath }),
    fetchConsolidatedVersions: async () => ({ versions: [] }),
    runSparqlQuery: async () => ({}),
  });

  const result = await resolveParsedLaw('32013R0575', 'ENG', { version: 'current' });

  assert.equal(result.versionUnavailable, true);
  assert.equal(result.source, 'fmx');
  assert.equal(result.version, undefined);
  // The as-adopted content is served intact, not an empty stub.
  assert.equal(result.articles.length, 1);
  assert.equal(result.recitals.length, 1);
});

test('requested version "current": falls back with versionUnavailable when every consolidated version is future-dated', async () => {
  const asAdoptedPath = writeTempXml(AS_ADOPTED_FMX_WITH_RECITALS_AND_ARTICLE);

  const resolveParsedLaw = createParsedLawResolver({
    prepareLawPayload: async () => ({ servePath: asAdoptedPath }),
    fetchConsolidatedVersions: async () => ({ versions: [{ celex: '02013R0575-20990101', date: '2099-01-01' }] }),
    runSparqlQuery: async () => ({}),
  });

  const result = await resolveParsedLaw('32013R0575', 'ENG', { version: 'current' });

  assert.equal(result.versionUnavailable, true);
  assert.equal(result.source, 'fmx');
  assert.equal(result.articles.length, 1);
});

test('requested version "current": falls back with versionUnavailable when the consolidated fetch fails (Cellar/SPARQL outage or 406)', async () => {
  const asAdoptedPath = writeTempXml(AS_ADOPTED_FMX_WITH_RECITALS_AND_ARTICLE);

  const resolveParsedLaw = createParsedLawResolver({
    prepareLawPayload: async () => ({ servePath: asAdoptedPath }),
    fetchConsolidatedVersions: async () => { throw new Error('Cellar returned 406'); },
    runSparqlQuery: async () => ({}),
  });

  const result = await resolveParsedLaw('32013R0575', 'ENG', { version: 'current' });

  assert.equal(result.versionUnavailable, true);
  assert.equal(result.source, 'fmx');
  assert.equal(result.articles.length, 1);
  assert.equal(result.recitals.length, 1);
});

test('as-adopted and requested-version "current" results are cached under distinct keys', async () => {
  const asAdoptedPath = writeTempXml(AS_ADOPTED_FMX_WITH_RECITALS_AND_ARTICLE);
  const consolidatedPath = writeTempXml(CONSOLIDATED_FMX_WITH_TWO_ARTICLES);
  let prepareCalls = 0;
  let fetchConsolidatedCalls = 0;

  const resolveParsedLaw = createParsedLawResolver({
    prepareLawPayload: async (celex) => {
      prepareCalls += 1;
      return { servePath: celex === '32013R0575' ? asAdoptedPath : consolidatedPath };
    },
    fetchConsolidatedVersions: async () => {
      fetchConsolidatedCalls += 1;
      return { versions: [{ celex: '02013R0575-20260626', date: '2026-06-26' }] };
    },
    runSparqlQuery: async () => ({}),
  });

  const asAdopted = await resolveParsedLaw('32013R0575', 'ENG', {});
  assert.equal(asAdopted.source, 'fmx');
  assert.equal(asAdopted.articles.length, 1);
  assert.equal(fetchConsolidatedCalls, 0, 'the as-adopted parse has content, so no consolidated fetch is needed');

  const current = await resolveParsedLaw('32013R0575', 'ENG', { version: 'current' });
  assert.equal(current.source, 'fmx-consolidated');
  assert.equal(current.articles.length, 2);
  assert.equal(fetchConsolidatedCalls, 1);
  // Each resolveParsedLaw call is cached under its own key, so the requested
  // version's own call re-probes the as-adopted FMX (to get the recitals to
  // compose with) in addition to fetching the consolidated document — that
  // is the second and third prepareLawPayload calls.
  assert.equal(prepareCalls, 3);

  // Both are now served from cache without any further fetch/parse work.
  const asAdoptedAgain = await resolveParsedLaw('32013R0575', 'ENG', {});
  const currentAgain = await resolveParsedLaw('32013R0575', 'ENG', { version: 'current' });
  assert.equal(asAdoptedAgain.articles.length, 1);
  assert.equal(currentAgain.articles.length, 2);
  assert.equal(prepareCalls, 3, 'cached calls must not re-fetch either version');
  assert.equal(fetchConsolidatedCalls, 1);
});
