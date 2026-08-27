const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

const { registerTools, htmlToText } = require('./register-tools');

const FIXTURE_LAW = {
  celex: '32016R0679',
  lang: 'ENG',
  title: 'General Data Protection Regulation',
  langCode: 'EN',
  source: 'fmx',
  format: 'combined-v1',
  articles: [
    {
      article_number: '1',
      article_title: 'Subject-matter and objectives',
      division: { chapter: { number: 'I', title: 'General provisions' }, section: null },
      article_html: '<p>This Regulation lays down rules.</p><p>It protects fundamental rights.</p>',
    },
    {
      article_number: '17',
      article_title: 'Right to erasure',
      division: { chapter: { number: 'III', title: 'Rights of the data subject' }, section: { number: '3', title: 'Rectification and erasure' } },
      article_html: '<p>The data subject shall have the right to obtain erasure.</p>',
    },
  ],
  recitals: [
    { recital_number: '1', recital_text: 'The protection of natural persons.', recital_html: '<p>The protection of natural persons.</p>' },
    { recital_number: '2', recital_text: 'The principles should apply.', recital_html: '<p>The principles should apply.</p>' },
  ],
  annexes: [],
  definitions: [
    { term: 'personal data', definition: 'any information relating to an identified person' },
    { term: 'processing', definition: 'any operation performed on personal data' },
  ],
  crossReferences: { 17: [{ type: 'article', target: '4' }] },
};

const ownedCacheDirs = new WeakMap();

function makeDeps(overrides = {}) {
  const cacheDir = overrides.FMX_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  const deps = {
    legalCacheStore: {
      searchLaws: () => [{ celex: '32016R0679', title: 'GDPR', type: 'regulation', matchReason: 'title_exact' }],
      searchFulltextUnits: () => [],
      getByCelex: (celex) => (celex === '32016R0679' ? { celex, title: 'GDPR', eli: 'http://data.europa.eu/eli/reg/2016/679/oj' } : null),
    },
    resolveReference: async (parsed) => ({ resolved: { celex: '32018L1972', eli: null, source: 'search-cache' }, parsed, tried: [], fallback: null }),
    resolveEurlexUrl: async (url) => ({ sourceUrl: url, resolved: { celex: '32016R0679', source: 'search-cache' }, tried: [], fallback: null }),
    runSparqlQuery: async () => ({ results: { bindings: [] } }),
    resolveParsedLaw: async () => FIXTURE_LAW,
    FMX_DIR: cacheDir,
    analytics: { recordMcpTool: () => {} },
    citationGraphStore: {
      isReady: () => true,
      getArticleCitations: (celex, article, pagination) => ({ celex, article, citingProvisions: [], citingJudgments: [], counts: { total: 0 }, pagination }),
      getActCitations: (celex) => ({ celex, byArticle: [], counts: { total: 0 } }),
    },
    ...overrides,
  };
  if (overrides.FMX_DIR === undefined) ownedCacheDirs.set(deps, cacheDir);
  return deps;
}

function cleanupDeps(deps) {
  const cacheDir = ownedCacheDirs.get(deps);
  if (cacheDir === undefined) return;
  ownedCacheDirs.delete(deps);
  fs.rmSync(cacheDir, { recursive: true, force: true });
}

async function withClient(deps, fn) {
  const server = new McpServer({ name: 'eurlex-test', version: '1.0.0' });
  let client;
  try {
    registerTools(server, deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return await fn(client);
  } finally {
    try {
      if (client) await client.close();
    } finally {
      try {
        await server.close();
      } finally {
        cleanupDeps(deps);
      }
    }
  }
}

function parseResult(result) {
  return JSON.parse(result.content[0].text);
}

test('lists the expected tools', async () => {
  await withClient(makeDeps(), async (client) => {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ['get_case_law', 'get_citing_provisions', 'get_law_part', 'get_law_relations', 'resolve', 'search_eu_law', 'search_law_text']
    );
  });
});

test('get_citing_provisions returns article details with pagination', async () => {
  const calls = [];
  const deps = makeDeps({
    citationGraphStore: {
      isReady: () => true,
      getArticleCitations: (celex, article, pagination) => {
        calls.push({ celex, article, pagination });
        return { celex, article, citingProvisions: [{ celex: '32024R1689', unit: '6' }], citingJudgments: [], counts: { total: 1 }, pagination };
      },
    },
  });
  await withClient(deps, async (client) => {
    const body = parseResult(await client.callTool({
      name: 'get_citing_provisions',
      arguments: { celex: '32016R0679', article: '6', limit: 20, offset: 5 },
    }));
    assert.equal(body.counts.total, 1);
    assert.deepEqual(calls, [{ celex: '32016R0679', article: '6', pagination: { limit: 20, offset: 5 } }]);
  });
});

test('get_citing_provisions returns act counts when article is omitted', async () => {
  let calledWith;
  const deps = makeDeps({
    citationGraphStore: {
      isReady: () => true,
      getActCitations: (celex) => {
        calledWith = celex;
        return { celex, totals: { provisions: 2, judgments: 1, total: 3 } };
      },
    },
  });
  await withClient(deps, async (client) => {
    const body = parseResult(await client.callTool({
      name: 'get_citing_provisions', arguments: { celex: '32016R0679' },
    }));
    assert.equal(body.celex, '32016R0679');
    assert.equal(body.totals.total, 3);
    assert.equal(calledWith, '32016R0679');
  });
});

test('get_citing_provisions reports an unavailable citation graph', async () => {
  await withClient(makeDeps({ citationGraphStore: { isReady: () => false } }), async (client) => {
    const result = await client.callTool({
      name: 'get_citing_provisions', arguments: { celex: '32016R0679', article: '6' },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /citation graph is not loaded/i);
  });
});

test('search_eu_law returns ranked results', async () => {
  await withClient(makeDeps(), async (client) => {
    const res = await client.callTool({ name: 'search_eu_law', arguments: { query: 'gdpr' } });
    const body = parseResult(res);
    assert.equal(body.count, 1);
    assert.equal(body.results[0].celex, '32016R0679');
  });
});

test('search_eu_law maps an unavailable cache to a friendly error', async () => {
  const deps = makeDeps({
    legalCacheStore: {
      searchLaws: () => { const e = new Error('nope'); e.code = 'search_cache_unavailable'; throw e; },
    },
  });
  await withClient(deps, async (client) => {
    const res = await client.callTool({ name: 'search_eu_law', arguments: { query: 'gdpr' } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /search index is not loaded/i);
  });
});

test('search_law_text returns matching units and records the attempted query', async () => {
  const calls = [];
  const analyticsCalls = [];
  const deps = makeDeps({
    legalCacheStore: {
      searchFulltextUnits: (query, options) => {
        calls.push({ query, options });
        return [{ celex: '32016R0679', unitType: 'article', number: '17', snippet: 'right to obtain erasure' }];
      },
    },
    analytics: { recordMcpTool: (tool, meta) => analyticsCalls.push({ tool, meta }) },
  });
  await withClient(deps, async (client) => {
    const res = await client.callTool({ name: 'search_law_text', arguments: { query: '  erasure  ', limit: 1 } });
    const body = parseResult(res);
    assert.equal(body.query, 'erasure');
    assert.equal(body.celex, null);
    assert.equal(body.count, 1);
    assert.equal(body.results[0].number, '17');
  });
  assert.deepEqual(calls, [{ query: 'erasure', options: { celex: undefined, limit: 1 } }]);
  assert.deepEqual(analyticsCalls, [{ tool: 'search_law_text', meta: { query: 'erasure' } }]);
});

test('search_law_text normalizes and scopes by CELEX', async () => {
  let call;
  const deps = makeDeps({
    legalCacheStore: {
      searchFulltextUnits: (query, options) => {
        call = { query, options };
        return [{ celex: '32016R0679', unitType: 'article', number: '17', snippet: 'erasure' }];
      },
    },
  });
  await withClient(deps, async (client) => {
    const body = parseResult(await client.callTool({
      name: 'search_law_text',
      arguments: { query: 'erasure', celex: ' 32016r0679 ', limit: 5 },
    }));
    assert.equal(body.celex, '32016R0679');
    assert.equal(body.count, 1);
  });
  assert.deepEqual(call, {
    query: 'erasure',
    options: { celex: '32016R0679', limit: 5 },
  });
});

test('search_law_text treats blank CELEX as omitted', async () => {
  let options;
  const deps = makeDeps({
    legalCacheStore: {
      searchFulltextUnits: (_query, nextOptions) => {
        options = nextOptions;
        return [];
      },
    },
  });
  await withClient(deps, async (client) => {
    const body = parseResult(await client.callTool({
      name: 'search_law_text',
      arguments: { query: 'erasure', celex: '   ' },
    }));
    assert.equal(body.celex, null);
  });
  assert.deepEqual(options, { celex: undefined, limit: undefined });
});

test('search_law_text validates searchable terms before retrieval', async () => {
  let retrieved = false;
  const deps = makeDeps({
    legalCacheStore: {
      searchFulltextUnits: () => {
        retrieved = true;
        const error = new Error('missing fulltext index');
        error.code = 'fulltext_index_unavailable';
        throw error;
      },
    },
  });
  await withClient(deps, async (client) => {
    const res = await client.callTool({ name: 'search_law_text', arguments: { query: '***' } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /searchable term/i);
  });
  assert.equal(retrieved, false);
});

test('search_law_text rejects an invalid CELEX before retrieval', async () => {
  let retrieved = false;
  const deps = makeDeps({
    legalCacheStore: {
      searchFulltextUnits: () => {
        retrieved = true;
        return [];
      },
    },
  });
  await withClient(deps, async (client) => {
    const res = await client.callTool({ name: 'search_law_text', arguments: { query: 'erasure', celex: 'not-a-celex' } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Invalid CELEX/i);
  });
  assert.equal(retrieved, false);
});

test('search_law_text reports an unavailable full-text index without an equivalent fallback', async () => {
  const deps = makeDeps({
    legalCacheStore: {
      searchFulltextUnits: () => {
        const error = new Error('missing fulltext index');
        error.code = 'fulltext_index_unavailable';
        throw error;
      },
    },
  });
  await withClient(deps, async (client) => {
    const res = await client.callTool({ name: 'search_law_text', arguments: { query: 'erasure' } });
    assert.equal(res.isError, true);
    assert.equal(res.content[0].text, 'Full-text index is not available; metadata/title/excerpt search remains available but is not an equivalent fallback.');
  });
});

test('resolve dispatches URL, CELEX, and citation inputs', async () => {
  await withClient(makeDeps(), async (client) => {
    const url = parseResult(await client.callTool({ name: 'resolve', arguments: { reference: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj' } }));
    assert.equal(url.resolved.celex, '32016R0679');

    const celex = parseResult(await client.callTool({ name: 'resolve', arguments: { reference: '32016R0679' } }));
    assert.equal(celex.resolved.celex, '32016R0679');
    assert.equal(celex.resolved.source, 'search-cache');

    const citation = parseResult(await client.callTool({ name: 'resolve', arguments: { reference: 'Directive 2018/1972' } }));
    assert.equal(citation.resolved.celex, '32018L1972');
    assert.ok(citation.parsed);
  });
});

test('resolve rejects an unparseable reference', async () => {
  await withClient(makeDeps(), async (client) => {
    const res = await client.callTool({ name: 'resolve', arguments: { reference: 'something vague' } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Could not parse/i);
  });
});

test('get_law_part structure returns the table of contents', async () => {
  await withClient(makeDeps(), async (client) => {
    const body = parseResult(await client.callTool({ name: 'get_law_part', arguments: { celex: '32016R0679', part: 'structure' } }));
    assert.equal(body.counts.articles, 2);
    assert.equal(body.counts.definitions, 2);
    assert.equal(body.chapters.length, 2);
    assert.equal(body.chapters[0].chapter_number, 'I');
    assert.deepEqual(body.recitals.map((r) => r.number), ['1', '2']);
    assert.deepEqual(body.definitions, ['personal data', 'processing']);
  });
});

test('get_law_part passes version=current through and reports the version it served', async () => {
  let seenOptions = null;
  const deps = makeDeps({
    resolveParsedLaw: async (celex, lang, options) => {
      seenOptions = options;
      return {
        ...FIXTURE_LAW,
        source: 'fmx-consolidated',
        version: 'current',
        versionCelex: '02016R0679-20160504',
        versionDate: '2016-05-04',
        recitalsSource: 'as-adopted',
        articles: [
          FIXTURE_LAW.articles[0],
          { ...FIXTURE_LAW.articles[1], insertedInVersion: true },
        ],
      };
    },
  });

  await withClient(deps, async (client) => {
    const body = parseResult(await client.callTool({
      name: 'get_law_part',
      arguments: { celex: '32016R0679', part: 'structure', version: 'current' },
    }));

    assert.deepEqual(seenOptions, { version: 'current' });
    assert.equal(body.version, 'current');
    assert.equal(body.versionCelex, '02016R0679-20160504');
    assert.equal(body.versionDate, '2016-05-04');
    assert.equal(body.recitalsSource, 'as-adopted');
    // The article added by a later amendment is flagged, so a caller knows
    // not to expect case law or citations for it.
    const flagged = body.chapters
      .flatMap((chapter) => chapter.articles)
      .filter((article) => article.insertedInVersion);
    assert.equal(flagged.length, 1);
  });
});

test('get_law_part omits the version fields entirely when no version is requested', async () => {
  let seenOptions = null;
  const deps = makeDeps({
    resolveParsedLaw: async (celex, lang, options) => { seenOptions = options; return FIXTURE_LAW; },
  });

  await withClient(deps, async (client) => {
    const body = parseResult(await client.callTool({
      name: 'get_law_part',
      arguments: { celex: '32016R0679', part: 'structure' },
    }));

    assert.deepEqual(seenOptions, {});
    assert.ok(!('version' in body), 'as-adopted responses keep their previous shape');
    assert.ok(!('versionCelex' in body));
    assert.ok(!('recitalsSource' in body));
  });
});

test('get_law_part article returns plain text and cross-references', async () => {
  await withClient(makeDeps(), async (client) => {
    const body = parseResult(await client.callTool({ name: 'get_law_part', arguments: { celex: '32016R0679', part: 'article', number: '17' } }));
    assert.equal(body.article_number, '17');
    assert.equal(body.article_title, 'Right to erasure');
    assert.equal(body.section.number, '3');
    assert.match(body.text, /right to obtain erasure/);
    assert.doesNotMatch(body.text, /<p>/);
    assert.equal(body.crossReferences[0].target, '4');
  });
});

test('get_law_part article lists valid numbers when the article is unknown', async () => {
  await withClient(makeDeps(), async (client) => {
    const res = await client.callTool({ name: 'get_law_part', arguments: { celex: '32016R0679', part: 'article', number: '999' } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Available article numbers: 1, 17/);
  });
});

test('get_law_part definitions filters by substring', async () => {
  await withClient(makeDeps(), async (client) => {
    const body = parseResult(await client.callTool({ name: 'get_law_part', arguments: { celex: '32016R0679', part: 'definitions', number: 'processing' } }));
    assert.equal(body.count, 1);
    assert.equal(body.definitions[0].term, 'processing');
  });
});

test('get_law_part recital returns text and soft-fails to no title without a key', async () => {
  const prevKey = process.env.OPENROUTER_API_KEY;
  const prevRecitalKey = process.env.RECITAL_TITLE_OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.RECITAL_TITLE_OPENROUTER_API_KEY;
  try {
    await withClient(makeDeps(), async (client) => {
      const body = parseResult(await client.callTool({ name: 'get_law_part', arguments: { celex: '32016R0679', part: 'recital', number: '1' } }));
      assert.equal(body.recital_number, '1');
      assert.equal(body.title, null);
      assert.match(body.text, /protection of natural persons/);
    });
  } finally {
    if (prevKey !== undefined) process.env.OPENROUTER_API_KEY = prevKey;
    if (prevRecitalKey !== undefined) process.env.RECITAL_TITLE_OPENROUTER_API_KEY = prevRecitalKey;
  }
});

test('get_law_part recital stays cached-only even when an OpenRouter key is configured', async () => {
  // Asserting `title === null` alone does not prove anything: the pre-fix code
  // called ensureRecitalTitles, watched the request fail, and soft-failed to
  // null too. The property that matters is that /mcp -- which carries no
  // generation budget or origin allowlist -- never makes the billed call in
  // the first place, so stub fetch to *succeed* and assert it is never reached.
  const prevKey = process.env.OPENROUTER_API_KEY;
  const originalFetch = global.fetch;
  const fetched = [];
  // A dedicated empty dir keeps this cache-miss test isolated from other tests.
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cached-only-'));
  process.env.OPENROUTER_API_KEY = 'test-key-should-be-ignored';
  global.fetch = async (url, options) => {
    fetched.push(String(url));
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ 1: 'A generated title' }) }, finish_reason: 'stop' }],
        model: 'test-model',
        usage: { total_tokens: 1 },
      }),
    };
  };
  try {
    await withClient(makeDeps({ FMX_DIR: cacheDir }), async (client) => {
      const body = parseResult(await client.callTool({ name: 'get_law_part', arguments: { celex: '32016R0679', part: 'recital', number: '1' } }));
      assert.equal(body.recital_number, '1');
      assert.match(body.text, /protection of natural persons/);
      assert.deepEqual(fetched, [], 'the MCP path must never make a billed generation call on a cache miss');
      assert.equal(body.title, null, 'a cache miss must return no title rather than generating one');
    });
  } finally {
    global.fetch = originalFetch;
    if (prevKey !== undefined) process.env.OPENROUTER_API_KEY = prevKey;
    else delete process.env.OPENROUTER_API_KEY;
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('get_law_part structure surfaces cached recital titles', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-recital-cache-'));
  // Reproduce the service's contentHash so the cache entry is accepted.
  const stripTags = (v) => String(v || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const hash = crypto.createHash('sha256');
  for (const r of FIXTURE_LAW.recitals) {
    hash.update(String(r.recital_number));
    hash.update('\0');
    hash.update(stripTags(r.recital_text));
    hash.update('\0');
  }
  const cache = {
    '32016R0679_ENG': {
      version: 2,
      contentHash: hash.digest('hex'),
      model: 'test-model',
      generatedAt: new Date().toISOString(),
      titles: { 1: 'Protection of natural persons', 2: 'Consistent application' },
    },
  };
  fs.writeFileSync(path.join(cacheDir, 'recital-title-cache-v1.json'), JSON.stringify(cache));

  try {
    await withClient(makeDeps({ FMX_DIR: cacheDir }), async (client) => {
      const body = parseResult(await client.callTool({ name: 'get_law_part', arguments: { celex: '32016R0679', part: 'structure' } }));
      const first = body.recitals.find((r) => r.number === '1');
      assert.equal(first.title, 'Protection of natural persons');
    });
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('get_law_relations merges amendments and implementing acts', async () => {
  await withClient(makeDeps(), async (client) => {
    const body = parseResult(await client.callTool({ name: 'get_law_relations', arguments: { celex: '32016R0679' } }));
    assert.equal(body.celex, '32016R0679');
    assert.deepEqual(body.amendments, []);
    assert.deepEqual(body.implementingActs, []);
  });
});

test('tools reject an invalid CELEX', async () => {
  await withClient(makeDeps(), async (client) => {
    const res = await client.callTool({ name: 'get_law_part', arguments: { celex: 'not-a-celex', part: 'structure' } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Invalid CELEX/i);
  });
});

test('records analytics for each tool invocation', async () => {
  const calls = [];
  const deps = makeDeps({ analytics: { recordMcpTool: (tool, meta) => calls.push({ tool, meta }) } });
  await withClient(deps, async (client) => {
    await client.callTool({ name: 'search_eu_law', arguments: { query: 'gdpr' } });
    await client.callTool({ name: 'get_case_law', arguments: { celex: '32016R0679' } });
  });
  assert.deepEqual(calls[0], { tool: 'search_eu_law', meta: { query: 'gdpr' } });
  assert.deepEqual(calls[1], { tool: 'get_case_law', meta: { celex: '32016R0679' } });
});

test('non-ClientError failures are sanitised before reaching the client', async () => {
  const originalConsoleError = console.error;
  const loggedCalls = [];
  console.error = (...args) => loggedCalls.push(args);
  try {
    const deps = makeDeps({
      resolveParsedLaw: async () => { throw new Error('ENOENT: /var/data/law-cache/secret/32016R0679.json'); },
    });
    await withClient(deps, async (client) => {
      const res = await client.callTool({ name: 'get_law_part', arguments: { celex: '32016R0679', part: 'structure' } });
      assert.equal(res.isError, true);
      assert.doesNotMatch(res.content[0].text, /ENOENT|\/var\/data/);
      assert.match(res.content[0].text, /internal server error/i);
    });
    assert.equal(loggedCalls.length, 1);
    assert.match(loggedCalls[0].join(' '), /ENOENT/);
  } finally {
    console.error = originalConsoleError;
  }
});

test('htmlToText strips markup and keeps block breaks', () => {
  assert.equal(htmlToText('<p>One.</p><p>Two.</p>'), 'One.\n\nTwo.');
  assert.equal(htmlToText('A<br>B'), 'A\nB');
  assert.equal(htmlToText(''), '');
});
