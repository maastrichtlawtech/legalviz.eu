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

function makeDeps(overrides = {}) {
  return {
    legalCacheStore: {
      searchLaws: () => [{ celex: '32016R0679', title: 'GDPR', type: 'regulation', matchReason: 'title_exact' }],
      getByCelex: (celex) => (celex === '32016R0679' ? { celex, title: 'GDPR', eli: 'http://data.europa.eu/eli/reg/2016/679/oj' } : null),
    },
    resolveReference: async (parsed) => ({ resolved: { celex: '32018L1972', eli: null, source: 'search-cache' }, parsed, tried: [], fallback: null }),
    resolveEurlexUrl: async (url) => ({ sourceUrl: url, resolved: { celex: '32016R0679', source: 'search-cache' }, tried: [], fallback: null }),
    runSparqlQuery: async () => ({ results: { bindings: [] } }),
    resolveParsedLaw: async () => FIXTURE_LAW,
    FMX_DIR: path.join(os.tmpdir(), 'mcp-test-nonexistent'),
    analytics: { recordMcpTool: () => {} },
    citationGraphStore: {
      isReady: () => true,
      getArticleCitations: (celex, article, pagination) => ({ celex, article, citingProvisions: [], citingJudgments: [], counts: { total: 0 }, pagination }),
      getActCitations: (celex) => ({ celex, byArticle: [], counts: { total: 0 } }),
    },
    ...overrides,
  };
}

async function withClient(deps, fn) {
  const server = new McpServer({ name: 'eurlex-test', version: '1.0.0' });
  registerTools(server, deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
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
      ['get_case_law', 'get_citing_provisions', 'get_law_part', 'get_law_relations', 'resolve', 'search_eu_law']
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

  await withClient(makeDeps({ FMX_DIR: cacheDir }), async (client) => {
    const body = parseResult(await client.callTool({ name: 'get_law_part', arguments: { celex: '32016R0679', part: 'structure' } }));
    const first = body.recitals.find((r) => r.number === '1');
    assert.equal(first.title, 'Protection of natural persons');
  });
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

test('htmlToText strips markup and keeps block breaks', () => {
  assert.equal(htmlToText('<p>One.</p><p>Two.</p>'), 'One.\n\nTwo.');
  assert.equal(htmlToText('A<br>B'), 'A\nB');
  assert.equal(htmlToText(''), '');
});
