const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildEliCandidates,
  createReferenceResolver,
  extractCelexFromText,
  parseEurlexUrl,
  parseReferenceText,
  parseStructuredReference,
  validateCelex,
} = require('./reference-utils');
const { cacheGet, cacheSet, toSearchLang } = require('./api-utils');
const { JsonLegalCacheStore } = require('../search/legal-cache-store');

const fixturePath = path.join(__dirname, '..', 'search', '__fixtures__', 'search-fixture.json');

test('parseReferenceText extracts act type and year/number', () => {
  const parsed = parseReferenceText('Regulation (EU) 2016/679 on data protection');
  assert.equal(parsed.actType, 'regulation');
  assert.equal(parsed.year, '2016');
  assert.equal(parsed.number, '679');
});

test('parseStructuredReference normalizes structured fields', () => {
  const parsed = parseStructuredReference({
    actType: 'Directive',
    year: 2018,
    number: 1972,
    suffix: 'jha',
    ojColl: 'l',
    ojNo: '321',
    ojYear: '2018',
  });
  assert.equal(parsed.actType, 'directive');
  assert.equal(parsed.suffix, 'JHA');
  assert.equal(parsed.ojColl, 'L');
  assert.equal(parsed.normalized, 'directive 2018 1972');
});

test('extractCelexFromText finds CELEX in raw and encoded forms', () => {
  assert.equal(extractCelexFromText('foo CELEX:32016R0679 bar'), '32016R0679');
  assert.equal(extractCelexFromText('foo CELEX%3A32022R2065 bar'), '32022R2065');
});

test('parseEurlexUrl recognizes direct CELEX URLs', () => {
  const parsed = parseEurlexUrl('https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679');
  assert.equal(parsed.type, 'celex');
  assert.equal(parsed.celex, '32016R0679');
});

test('parseEurlexUrl recognizes ELI URLs', () => {
  const parsed = parseEurlexUrl('https://eur-lex.europa.eu/eli/reg/2016/679/oj');
  assert.equal(parsed.type, 'eli');
  assert.equal(parsed.eli, 'http://data.europa.eu/eli/reg/2016/679/oj');
  assert.equal(parsed.reference.actType, 'regulation');
  assert.equal(parsed.reference.year, '2016');
  assert.equal(parsed.reference.number, '679');
});

test('buildEliCandidates handles decision JHA suffix', () => {
  const candidates = buildEliCandidates({
    actType: 'decision',
    year: '2008',
    number: '977',
    suffix: 'JHA',
  });
  assert.ok(candidates.includes('http://publications.europa.eu/resource/eli/dec_framw/2008/977/oj'));
  assert.ok(candidates.includes('http://publications.europa.eu/resource/eli/dec/2008/977/oj'));
});

test('validateCelex accepts canonical CELEX format', () => {
  assert.equal(validateCelex('32016R0679'), true);
  assert.equal(validateCelex('32016R0679(01)'), true);
  assert.equal(validateCelex('GDPR'), false);
});

test('validateCelex accepts two-letter descriptors for preparatory documents', () => {
  assert.equal(validateCelex('52021PC0206'), true);
  assert.equal(validateCelex('52026PC0502'), true);
  assert.equal(validateCelex('52021DC0118'), true);
});

test('parseEurlexUrl recognizes Commission-document (COM) URLs', () => {
  const parsed = parseEurlexUrl('https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=COM:2026:502:FIN');
  assert.equal(parsed.type, 'com');
  assert.equal(parsed.com.docType, 'COM');
  assert.equal(parsed.com.year, '2026');
  assert.equal(parsed.com.number, '502');
  assert.equal(parsed.com.suffix, 'FIN');
});

function createResolver({ store, fetchImpl }) {
  const originalFetch = global.fetch;
  if (fetchImpl) {
    global.fetch = fetchImpl;
  }

  const resolver = createReferenceResolver({
    EURLEX_BASE: 'https://eur-lex.europa.eu',
    RESOLUTION_CACHE_MS: 60_000,
    TIMEOUT_MS: 1_000,
    cacheGet,
    cacheSet,
    legalCacheStore: store,
    resolutionCache: new Map(),
    toSearchLang,
  });

  return {
    resolver,
    restore() {
      global.fetch = originalFetch;
    },
  };
}

function createAmbiguousStore() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-cache-ambiguous-'));
  const tempPath = path.join(tempDir, 'ambiguous.json');
  fs.writeFileSync(tempPath, JSON.stringify({
    generatedAt: '2026-03-28T00:00:00.000Z',
    count: 2,
    records: [
      {
        celex: '32020R0123',
        title: 'Regulation (EU) 2020/123',
        type: 'regulation',
        date: '2020-01-01',
        eli: 'http://data.europa.eu/eli/reg/2020/123/oj',
        fmxAvailable: true,
        fmxUnavailable: false,
      },
      {
        celex: '32020R0123',
        title: 'Regulation (EU) 2020/123 duplicate',
        type: 'regulation',
        date: '2020-01-02',
        eli: 'http://data.europa.eu/eli/reg/2020/123/oj',
        fmxAvailable: true,
        fmxUnavailable: false,
      },
    ],
  }, null, 2));

  const store = new JsonLegalCacheStore(tempPath);
  store.load();
  return store;
}

test('resolveReference uses legal cache before Cellar', async () => {
  const store = new JsonLegalCacheStore(fixturePath);
  store.load();

  const { resolver, restore } = createResolver({
    store,
    fetchImpl: async () => {
      throw new Error('fetch should not be called for cache hit');
    },
  });

  try {
    const result = await resolver.resolveReference({
      actType: 'directive',
      year: '2015',
      number: '2366',
      raw: 'Directive 2015/2366',
    }, 'ENG');

    assert.equal(result.resolved?.celex, '32015L2366');
    assert.equal(result.resolved?.source, 'search-cache');
  } finally {
    restore();
  }
});

test('resolveReference falls back to Cellar when cache match is ambiguous', async () => {
  const store = createAmbiguousStore();
  const fetchCalls = [];

  const { resolver, restore } = createResolver({
    store,
    fetchImpl: async (url) => {
      fetchCalls.push(String(url));
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            results: {
              bindings: [
                { celex: { value: 'http://publications.europa.eu/resource/celex/32020R0123' } },
              ],
            },
          };
        },
      };
    },
  });

  try {
    const result = await resolver.resolveReference({
      actType: 'regulation',
      year: '2020',
      number: '123',
      raw: 'Regulation 2020/123',
    }, 'ENG');

    assert.equal(result.resolved?.celex, '32020R0123');
    assert.equal(result.resolved?.source, 'cellar-sparql');
    assert.equal(fetchCalls.length, 1);
  } finally {
    restore();
  }
});

test('resolveEurlexUrl resolves ELI URL from legal cache first', async () => {
  const store = new JsonLegalCacheStore(fixturePath);
  store.load();

  const { resolver, restore } = createResolver({
    store,
    fetchImpl: async () => {
      throw new Error('fetch should not be called for cache hit');
    },
  });

  try {
    const result = await resolver.resolveEurlexUrl('https://eur-lex.europa.eu/eli/dir/2015/2366/oj', 'ENG');
    assert.equal(result.resolved?.celex, '32015L2366');
    assert.equal(result.resolved?.source, 'search-cache');
  } finally {
    restore();
  }
});

test('resolveEurlexUrl resolves OJ-shaped URL from legal cache when deterministic', async () => {
  const store = new JsonLegalCacheStore(fixturePath);
  store.load();

  const { resolver, restore } = createResolver({
    store,
    fetchImpl: async () => {
      throw new Error('fetch should not be called for cache hit');
    },
  });

  try {
    const result = await resolver.resolveEurlexUrl('https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=OJ:L:2015:02366:TOC', 'ENG');
    assert.equal(result.resolved?.celex, '32015L2366');
    assert.equal(result.resolved?.source, 'search-cache');
  } finally {
    restore();
  }
});

test('resolveEurlexUrl keeps OJ fallback path when cache cannot resolve deterministically', async () => {
  const store = new JsonLegalCacheStore(fixturePath);
  store.load();

  const fetchCalls = [];
  const { resolver, restore } = createResolver({
    store,
    fetchImpl: async (url) => {
      fetchCalls.push(String(url));
      return {
        ok: true,
        status: 200,
        async json() {
          return { results: { bindings: [] } };
        },
      };
    },
  });

  try {
    const result = await resolver.resolveEurlexUrl('https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=OJ:L:2015:00999:TOC', 'ENG');
    assert.equal(result.resolved, null);
    assert.equal(result.fallback?.type, 'open-source-url');
    assert.equal(fetchCalls.length, 4);
  } finally {
    restore();
  }
});

test('resolveEurlexUrl resolves a Commission-document URL via the COMNAT identifier', async () => {
  const store = new JsonLegalCacheStore(fixturePath);
  store.load();

  const fetchCalls = [];
  const { resolver, restore } = createResolver({
    store,
    fetchImpl: async (url) => {
      fetchCalls.push(String(url));
      return {
        ok: true,
        status: 200,
        async json() {
          return { results: { bindings: [{ celex: { value: '52026PC0502' } }] } };
        },
      };
    },
  });

  try {
    const result = await resolver.resolveEurlexUrl('https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=COM:2026:502:FIN', 'ENG');
    assert.equal(result.parsed.type, 'com');
    assert.equal(result.resolved?.celex, '52026PC0502');
    assert.equal(result.resolved?.source, 'cellar-com');
    assert.equal(fetchCalls.length, 1);
    assert.match(decodeURIComponent(fetchCalls[0]), /comnat:COM_2026_0502_FIN/);
  } finally {
    restore();
  }
});

test('resolveEurlexUrl keeps OJ fallback path when cache match is ambiguous', async () => {
  const store = createAmbiguousStore();
  const fetchCalls = [];

  const { resolver, restore } = createResolver({
    store,
    fetchImpl: async (url) => {
      fetchCalls.push(String(url));
      return {
        ok: true,
        status: 200,
        async json() {
          return { results: { bindings: [] } };
        },
      };
    },
  });

  try {
    const result = await resolver.resolveEurlexUrl('https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=OJ:L:2020:00123:TOC', 'ENG');
    assert.equal(result.resolved, null);
    assert.equal(result.fallback?.type, 'open-source-url');
    assert.ok(fetchCalls.length > 0);
  } finally {
    restore();
  }
});
