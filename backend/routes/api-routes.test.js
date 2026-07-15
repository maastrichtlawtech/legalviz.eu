const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { registerApiRoutes } = require("./api-routes");
const { createParsedLawResolver } = require("../shared/parsed-law-service");
const { createReferenceResolver } = require("../shared/reference-utils");
const { ClientError, cacheGet, cacheSet, safeErrorResponse, toSearchLang } = require("../shared/api-utils");
const { CitationGraphStore } = require("../search/citation-graph-store");
const { JsonLegalCacheStore } = require("../search/legal-cache-store");

const fixturePath = path.join(__dirname, "..", "search", "__fixtures__", "search-fixture.json");
const gdprFmxPath = path.join(__dirname, "..", "..", "src", "__fixtures__", "gdpr.fmx.xml");

function createAppRecorder() {
  const routes = new Map();
  return {
    routes,
    get(routePath, ...handlers) {
      routes.set(routePath, handlers[handlers.length - 1]);
    },
    post(routePath, ...handlers) {
      routes.set(`POST ${routePath}`, handlers[handlers.length - 1]);
    },
  };
}

function createResponseRecorder() {
  return {
    headers: {},
    headersSent: false,
    statusCode: 200,
    payload: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      this.headersSent = true;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
}

async function withOpenRouterEnv(env, fn) {
  const previous = {
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    ARTICLE_QA_OPENROUTER_API_KEY: process.env.ARTICLE_QA_OPENROUTER_API_KEY,
    LAW_SUMMARY_OPENROUTER_API_KEY: process.env.LAW_SUMMARY_OPENROUTER_API_KEY,
    RECITAL_TITLE_OPENROUTER_API_KEY: process.env.RECITAL_TITLE_OPENROUTER_API_KEY,
  };

  for (const key of Object.keys(previous)) {
    delete process.env[key];
  }
  Object.assign(process.env, env);

  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function registerTestRoutes(overrides = {}) {
  const app = createAppRecorder();
  const store = new JsonLegalCacheStore(fixturePath);
  store.load();

  const deps = {
    CELEX_NAMES: {},
    EURLEX_BASE: "https://eur-lex.europa.eu",
    FMX_DIR: path.join(__dirname, "..", "fmx-downloads"),
    RATE_LIMIT_MAX: 100,
    RESOLUTION_CACHE_MS: 60_000,
    cacheGet,
    cacheSet,
    citationGraphStore: {
      isReady: () => true,
      getArticleCitations: (celex, article, pagination) => ({ celex, article, pagination, citingProvisions: [], citingJudgments: [], counts: { total: 0 } }),
      getActCitations: (celex) => ({ celex, byArticle: [], counts: { total: 0 } }),
    },
    findDownloadUrls: async () => ({ type: "xml", urls: [] }),
    findFmx4Uri: async () => "unused",
    legalCacheStore: store,
    parseReferenceText: (text) => ({ raw: text, year: "2015", number: "2366", actType: "directive" }),
    parseStructuredReference: (input) => ({
      raw: input.raw || "",
      actType: String(input.actType || "").toLowerCase(),
      year: String(input.year || ""),
      number: String(input.number || ""),
      suffix: input.suffix || null,
      ojColl: input.ojColl || null,
      ojNo: input.ojNo || null,
      ojYear: input.ojYear || null,
    }),
    prepareLawPayload: async (celex, lang) => ({ servePath: `${celex}:${lang}` }),
    rateLimitMiddleware: (req, res, next) => next?.(),
    resolutionCache: new Map(),
    resolveEurlexUrl: async () => ({
      sourceUrl: "https://eur-lex.europa.eu/eli/dir/2015/2366/oj",
      parsed: { type: "eli" },
      resolved: {
        celex: "32015L2366",
        eli: "http://data.europa.eu/eli/dir/2015/2366/oj",
        source: "search-cache",
      },
      tried: [{ source: "search-cache", celex: "32015L2366" }],
      fallback: null,
    }),
    resolveReference: async () => ({
      resolved: {
        celex: "32015L2366",
        eli: "http://data.europa.eu/eli/dir/2015/2366/oj",
        source: "search-cache",
      },
      tried: [{ source: "search-cache", celex: "32015L2366" }],
      fallback: null,
    }),
    runSparqlQuery: async () => ({ results: { bindings: [] } }),
    safeErrorResponse,
    sendLawResponse: (res, servePath) => {
      res.body = { servePath };
      res.headersSent = true;
    },
    validateCelex: () => true,
    validateLang: (lang) => String(lang || "ENG").toUpperCase(),
    ...overrides,
  };

  if (!deps.resolveParsedLaw) {
    deps.resolveParsedLaw = createParsedLawResolver({
      prepareLawPayload: deps.prepareLawPayload,
      fetchAndParseHtmlLaw: deps.fetchAndParseHtmlLaw,
      CELEX_NAMES: deps.CELEX_NAMES,
    });
  }

  registerApiRoutes(app, deps);

  return { app, store };
}

function createAmbiguousStore() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "api-routes-ambiguous-"));
  const tempPath = path.join(tempDir, "ambiguous.json");
  fs.writeFileSync(tempPath, JSON.stringify({
    generatedAt: "2026-03-28T00:00:00.000Z",
    count: 2,
    records: [
      {
        celex: "32020R0123",
        title: "Regulation (EU) 2020/123",
        type: "regulation",
        date: "2020-01-01",
        eli: "http://data.europa.eu/eli/reg/2020/123/oj",
        fmxAvailable: true,
        fmxUnavailable: false,
      },
      {
        celex: "32020R0123",
        title: "Regulation (EU) 2020/123 duplicate",
        type: "regulation",
        date: "2020-01-02",
        eli: "http://data.europa.eu/eli/reg/2020/123/oj",
        fmxAvailable: true,
        fmxUnavailable: false,
      },
    ],
  }, null, 2));

  const store = new JsonLegalCacheStore(tempPath);
  store.load();
  return store;
}

test("GET /api/resolve-reference returns cache-backed resolution payload", async () => {
  const { app } = registerTestRoutes();
  const handler = app.routes.get("/api/resolve-reference");
  const res = createResponseRecorder();

  await handler({
    query: { actType: "directive", year: "2015", number: "2366", lang: "ENG" },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.resolved.celex, "32015L2366");
  assert.equal(res.payload.resolved.source, "search-cache");
});

test('GET article cited-by passes validated pagination to the citation graph', async () => {
  const calls = [];
  const { app } = registerTestRoutes({
    citationGraphStore: {
      isReady: () => true,
      getArticleCitations: (celex, article, pagination) => {
        calls.push({ celex, article, pagination });
        return { celex, article, citingProvisions: [{ celex: '32024R1689', unit: '6' }], citingJudgments: [], counts: { total: 1 }, pagination };
      },
    },
  });
  const handler = app.routes.get('/api/laws/:celex/articles/:n/cited-by');
  const res = createResponseRecorder();
  await handler({ params: { celex: '32016R0679', n: '6' }, query: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, [{ celex: '32016R0679', article: '6', pagination: { limit: 50, offset: 0 } }]);
  assert.equal(res.payload.counts.total, 1);
});

test('GET article cited-by returns normalized recital and annex units', async () => {
  const graphPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'api-citation-graph-')), 'graph.json');
  fs.writeFileSync(graphPath, JSON.stringify({
    graphVersion: 1,
    edges: [
      { kind: 'legislation', sourceCelex: '32024R1689', sourceUnitType: 'recital', sourceUnit: 'recital_140', targetCelex: '32016R0679', targetArticle: '6' },
      { kind: 'legislation', sourceCelex: '32024R1689', sourceUnitType: 'annex', sourceUnit: 'annex_I', targetCelex: '32016R0679', targetArticle: '6' },
    ],
  }));
  const citationGraphStore = new CitationGraphStore(graphPath);
  assert.equal(citationGraphStore.load(), true);
  const { app } = registerTestRoutes({ citationGraphStore });
  const handler = app.routes.get('/api/laws/:celex/articles/:n/cited-by');
  const res = createResponseRecorder();

  await handler({ params: { celex: '32016R0679', n: '6' }, query: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.citingProvisions.map(({ unitType, unit }) => ({ unitType, unit })), [
    { unitType: 'annex', unit: 'I' },
    { unitType: 'recital', unit: '140' },
  ]);
});

test('GET article cited-by rejects pagination outside its bounds', async () => {
  const { app } = registerTestRoutes();
  const handler = app.routes.get('/api/laws/:celex/articles/:n/cited-by');
  const res = createResponseRecorder();
  await handler({ params: { celex: '32016R0679', n: '6' }, query: { limit: '201' } }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.code, 'invalid_pagination');
});

test('GET act cited-by maps an unavailable graph to 503', async () => {
  const { app } = registerTestRoutes({
    citationGraphStore: { isReady: () => false, getStatus: () => ({ ready: false, reason: 'missing' }) },
  });
  const handler = app.routes.get('/api/laws/:celex/cited-by');
  const res = createResponseRecorder();
  await handler({ params: { celex: '32016R0679' }, query: {} }, res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.payload.code, 'citation_graph_unavailable');
});

test("GET /api/laws/by-reference serves FMX after cache-backed resolution", async () => {
  const { app } = registerTestRoutes();
  const handler = app.routes.get("/api/laws/by-reference");
  const res = createResponseRecorder();

  await handler({
    query: { actType: "directive", year: "2015", number: "2366", lang: "ENG" },
  }, res);

  assert.equal(res.headers["X-Resolved-CELEX"], "32015L2366");
  assert.equal(res.headers["X-Resolved-ELI"], "http://data.europa.eu/eli/dir/2015/2366/oj");
  assert.deepEqual(res.body, { servePath: "32015L2366:ENG" });
});

test("GET /api/resolve-reference returns 404 payload on unresolved fallback", async () => {
  const { app } = registerTestRoutes({
    resolveReference: async () => ({
      resolved: null,
      tried: [{ source: "search-cache", miss: true }],
      fallback: { type: "eurlex-search", url: "https://eur-lex.europa.eu/search.html?qid=test" },
    }),
  });
  const handler = app.routes.get("/api/resolve-reference");
  const res = createResponseRecorder();

  await handler({
    query: { actType: "directive", year: "2015", number: "9999", lang: "ENG" },
  }, res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.payload.resolved, null);
  assert.equal(res.payload.fallback.type, "eurlex-search");
});

test("GET /api/laws/by-reference returns fmx_not_found after cache-backed resolution", async () => {
  const { app } = registerTestRoutes({
    prepareLawPayload: async () => {
      throw new ClientError("Resolved CELEX 32015L2366, but no FMX files are available", 404, "fmx_missing_inner");
    },
  });
  const handler = app.routes.get("/api/laws/by-reference");
  const res = createResponseRecorder();

  await handler({
    query: { actType: "directive", year: "2015", number: "2366", lang: "ENG" },
  }, res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.payload.code, "fmx_not_found");
  assert.equal(res.payload.details.resolved.celex, "32015L2366");
});

test("GET /api/laws/:celex/parsed falls back to EUR-Lex HTML when FMX is unavailable", async () => {
  const { app } = registerTestRoutes({
    prepareLawPayload: async () => {
      throw new ClientError("No FMX files are available", 404, "fmx_not_found");
    },
    fetchAndParseHtmlLaw: async (celex, lang) => ({
      celex,
      lang,
      source: "eurlex-html",
      format: "combined-v1",
      title: "Directive 2002/58/EC",
      langCode: "EN",
      articles: [{ article_number: "1", article_title: "Scope", article_html: "<p>Body</p>", division: { chapter: { number: "", title: "" }, section: null } }],
      recitals: [{ recital_number: "1", recital_text: "Recital", recital_html: "<p>Recital</p>" }],
      annexes: [],
      definitions: [],
      crossReferences: {},
    }),
  });
  const handler = app.routes.get("/api/laws/:celex/parsed");
  const res = createResponseRecorder();

  await handler({
    params: { celex: "32002L0058" },
    query: { lang: "ENG" },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.source, "eurlex-html");
  assert.equal(res.payload.format, "combined-v1");
  assert.equal(res.payload.title, "Directive 2002/58/EC");
  assert.equal(res.payload.articles.length, 1);
});

test("GET /api/laws/:celex/parsed skips the FMX probe when requested", async () => {
  let prepareCalled = false;
  const { app } = registerTestRoutes({
    prepareLawPayload: async () => {
      prepareCalled = true;
      return { servePath: "unexpected" };
    },
    fetchAndParseHtmlLaw: async (celex, lang) => ({
      celex,
      lang,
      source: "eurlex-html",
      format: "combined-v1",
      title: "Directive 2013/36/EU",
      langCode: "EN",
      articles: [],
      recitals: [],
      annexes: [],
      definitions: [],
      crossReferences: {},
    }),
  });
  const handler = app.routes.get("/api/laws/:celex/parsed");
  const res = createResponseRecorder();

  await handler({
    params: { celex: "32013L0036" },
    query: { lang: "DEU", skipFmxProbe: "1" },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.source, "eurlex-html");
  assert.equal(prepareCalled, false);
});

test("GET /api/laws/:celex/case-law uses a short cache ttl", async () => {
  const resolutionCache = new Map();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "case-law-route-"));
  const { app } = registerTestRoutes({
    FMX_DIR: cacheDir,
    RESOLUTION_CACHE_MS: 86_400_000,
    resolutionCache,
    runSparqlQuery: async () => ({ results: { bindings: [] } }),
  });
  const handler = app.routes.get("/api/laws/:celex/case-law");
  const res = createResponseRecorder();
  await handler({
    params: { celex: "31995L0046" },
    query: {},
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, { celex: "31995L0046", cases: [] });

  const entry = resolutionCache.get("case-law:31995L0046");
  assert.ok(entry, "Expected case-law response to be cached");

  // Measure from cache insertion, not request start: the underlying lookup can
  // legitimately take longer than the test tolerance under a busy full suite.
  const ttlMs = entry.expiresAt - Date.now();
  assert.ok(ttlMs <= 5 * 60 * 1000 + 1_000, `Expected short cache ttl, got ${ttlMs}ms`);
  assert.ok(ttlMs >= 5 * 60 * 1000 - 1_000, `Expected short cache ttl, got ${ttlMs}ms`);
});

test("AI-backed static routes require their own OpenRouter key or the shared fallback on cache miss", async () => {
  await withOpenRouterEnv({ ARTICLE_QA_OPENROUTER_API_KEY: "qa-key" }, async () => {
    const { app } = registerTestRoutes();
    const handler = app.routes.get("/api/laws/:celex/recital-titles");
    const res = createResponseRecorder();

    await handler({
      params: { celex: "32016R0679" },
      query: { lang: "ENG" },
    }, res);

    assert.equal(res.statusCode, 503);
    assert.equal(res.payload.code, "openrouter_unconfigured");
    assert.match(res.payload.error, /recital titles/);
  });

  await withOpenRouterEnv({ RECITAL_TITLE_OPENROUTER_API_KEY: "title-key" }, async () => {
    // The recital-titles-only key does not grant access to the summary
    // endpoint, which requires its own key or the shared OPENROUTER_API_KEY
    // fallback. The summary handler now checks this before doing any
    // expensive work (resolving/parsing the law), so this should fail fast
    // with openrouter_unconfigured rather than reaching resolveParsedLaw.
    let resolveParsedLawCalled = false;
    const { app } = registerTestRoutes({
      resolveParsedLaw: async () => {
        resolveParsedLawCalled = true;
        throw new Error("resolveParsedLaw should not be called without an API key");
      },
    });
    const handler = app.routes.get("/api/laws/:celex/summary");
    const res = createResponseRecorder();

    await handler({
      params: { celex: "32016R0679" },
      query: { lang: "ENG", skipFmxProbe: "1" },
    }, res);

    assert.equal(res.statusCode, 503);
    assert.equal(res.payload.code, "openrouter_unconfigured");
    assert.match(res.payload.error, /OpenRouter API key/);
    assert.equal(resolveParsedLawCalled, false);
  });
});

// These two tests exercise the *real* getSource/getParsedLaw closures wired
// up inside the /api/laws/:celex/summary handler (unlike the "cache miss"
// test above, which always passes skipFmxProbe=1 and therefore never calls
// getSource or the FMX parse branch of getParsedLaw). They are regression
// tests for two bugs that a stub-heavy test suite missed: (1) parseFmxXml
// was never imported into api-routes.js, so any FMX-backed summary request
// threw `ReferenceError: parseFmxXml is not defined`; (2) getSource's 404
// fallback was guarded by `typeof fetchAndParseHtmlLaw === 'function'`, an
// identifier that was never in scope in api-routes.js (it's only wired into
// server.js's resolveParsedLaw), so the guard was always false and HTML-only
// laws got a re-thrown 404 instead of falling back to HTML parsing.
// A dummy API key is supplied in these two tests so the route's early
// "no API key configured" fast-fail guard (see below) does not short-circuit
// before getSource/getParsedLaw run. global.fetch is stubbed to fail
// synchronously (no real network call) once the pipeline reaches the actual
// chat call, so a successful fetch invocation is itself proof that
// getSource()/getParsedLaw() completed without error.
test("GET /api/laws/:celex/summary drives the real getSource/getParsedLaw closures for an FMX law", async () => {
  await withOpenRouterEnv({ LAW_SUMMARY_OPENROUTER_API_KEY: "test-key" }, async () => {
    const gdprXml = fs.readFileSync(gdprFmxPath, "utf8");
    const { app } = registerTestRoutes({
      prepareLawPayload: async () => ({ servePath: gdprFmxPath }),
    });
    const handler = app.routes.get("/api/laws/:celex/summary");
    const res = createResponseRecorder();

    let fetchCalled = false;
    const originalFetch = global.fetch;
    global.fetch = async () => {
      fetchCalled = true;
      throw new Error("network disabled in test");
    };

    try {
      await handler({
        params: { celex: "32016R0679" },
        query: { lang: "ENG" },
      }, res);
    } finally {
      global.fetch = originalFetch;
    }

    // Reaching the (stubbed) chat call proves getSource() read the fixture
    // and getParsedLaw() successfully parsed it with parseFmxXml (a
    // ReferenceError there would surface before fetch is ever called, and
    // gdprXml would never have been read at all).
    assert.ok(gdprXml.length > 0);
    assert.ok(fetchCalled, "Expected the summary pipeline to reach the chat call");
    assert.equal(res.statusCode, 500);
  });
});

test("GET /api/laws/:celex/summary falls back to HTML parsing when FMX is unavailable for a law", async () => {
  await withOpenRouterEnv({ LAW_SUMMARY_OPENROUTER_API_KEY: "test-key" }, async () => {
    const { app } = registerTestRoutes({
      prepareLawPayload: async () => {
        throw new ClientError("FMX not found", 404, "fmx_not_found");
      },
      fetchAndParseHtmlLaw: async (celex, lang) => ({
        celex,
        lang,
        source: "eurlex-html",
        format: "combined-v1",
        title: "Regulation (EU) 2016/679",
        langCode: "EN",
        articles: [{ article_number: "1", article_title: "Subject matter", article_html: "<p>This Regulation lays down rules.</p>", division: { chapter: { title: "General provisions" } } }],
        recitals: [{ recital_number: "1", recital_text: "Protection of natural persons.", recital_html: "<p>Protection of natural persons.</p>" }],
        annexes: [],
        definitions: [],
        crossReferences: {},
      }),
    });
    const handler = app.routes.get("/api/laws/:celex/summary");
    const res = createResponseRecorder();

    let fetchCalled = false;
    const originalFetch = global.fetch;
    global.fetch = async () => {
      fetchCalled = true;
      throw new Error("network disabled in test");
    };

    try {
      await handler({
        params: { celex: "32016R0679" },
        query: { lang: "ENG" },
      }, res);
    } finally {
      global.fetch = originalFetch;
    }

    // With the guard bug, getSource() re-throws the 404 from
    // prepareLawPayload instead of swallowing it, so the handler would
    // respond 404 here instead of falling through to the HTML parse and
    // reaching the (stubbed) chat call.
    assert.ok(fetchCalled, "Expected the summary pipeline to fall through to HTML parsing and reach the chat call");
    assert.equal(res.statusCode, 500);
  });
});

test("Case-law-digest routes fail fast without an OpenRouter key, before resolving/parsing the law", async () => {
  await withOpenRouterEnv({}, async () => {
    let resolveParsedLawCalled = false;
    const { app } = registerTestRoutes({
      resolveParsedLaw: async () => {
        resolveParsedLawCalled = true;
        throw new Error("resolveParsedLaw should not be called without an API key");
      },
    });

    const articleHandler = app.routes.get("/api/laws/:celex/articles/:n/case-law-digest");
    const articleRes = createResponseRecorder();
    await articleHandler({
      params: { celex: "32016R0679", n: "5" },
      query: { lang: "ENG" },
    }, articleRes);

    assert.equal(articleRes.statusCode, 503);
    assert.equal(articleRes.payload.code, "openrouter_unconfigured");
    assert.equal(resolveParsedLawCalled, false);

    const digestHandler = app.routes.get("/api/laws/:celex/case-law-digest");
    const digestRes = createResponseRecorder();
    await digestHandler({
      params: { celex: "32016R0679" },
      query: { lang: "ENG" },
    }, digestRes);

    assert.equal(digestRes.statusCode, 503);
    assert.equal(digestRes.payload.code, "openrouter_unconfigured");
    assert.equal(resolveParsedLawCalled, false);
  });
});

test("GET /api/_stats requires the header token and rejects the query-param form", async () => {
  const previousToken = process.env.ANALYTICS_TOKEN;
  try {
    delete process.env.ANALYTICS_TOKEN;
    const { app: appWithoutToken } = registerTestRoutes();
    const noTokenHandler = appWithoutToken.routes.get("/api/_stats");
    const noTokenRes = createResponseRecorder();
    await noTokenHandler({ headers: {}, query: {} }, noTokenRes);
    assert.equal(noTokenRes.statusCode, 404);

    process.env.ANALYTICS_TOKEN = "secret-token";
    const { app } = registerTestRoutes({
      analytics: { getStats: () => ({ ok: true }) },
    });
    const handler = app.routes.get("/api/_stats");

    const missingHeaderRes = createResponseRecorder();
    await handler({ headers: {}, query: {} }, missingHeaderRes);
    assert.equal(missingHeaderRes.statusCode, 401);

    // The query-param fallback must no longer grant access, even though the
    // token value is correct, since it leaks into access/proxy logs.
    const queryParamRes = createResponseRecorder();
    await handler({ headers: {}, query: { token: "secret-token" } }, queryParamRes);
    assert.equal(queryParamRes.statusCode, 401);

    const wrongHeaderRes = createResponseRecorder();
    await handler({ headers: { "x-analytics-token": "wrong-token" }, query: {} }, wrongHeaderRes);
    assert.equal(wrongHeaderRes.statusCode, 401);

    const okRes = createResponseRecorder();
    await handler({ headers: { "x-analytics-token": "secret-token" }, query: {} }, okRes);
    assert.equal(okRes.statusCode, 200);
    assert.deepEqual(okRes.payload, { ok: true });
  } finally {
    if (previousToken === undefined) {
      delete process.env.ANALYTICS_TOKEN;
    } else {
      process.env.ANALYTICS_TOKEN = previousToken;
    }
  }
});

test("GET /api/resolve-url returns cache-backed ELI resolution", async () => {
  const store = new JsonLegalCacheStore(fixturePath);
  store.load();

  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error("fetch should not be called for cache hit");
  };

  try {
    const resolver = createReferenceResolver({
      EURLEX_BASE: "https://eur-lex.europa.eu",
      RESOLUTION_CACHE_MS: 60_000,
      TIMEOUT_MS: 1_000,
      cacheGet,
      cacheSet,
      legalCacheStore: store,
      resolutionCache: new Map(),
      toSearchLang,
    });

    const { app } = registerTestRoutes({
      legalCacheStore: store,
      resolveEurlexUrl: resolver.resolveEurlexUrl,
    });
    const handler = app.routes.get("/api/resolve-url");
    const res = createResponseRecorder();

    await handler({
      query: { url: "https://eur-lex.europa.eu/eli/dir/2015/2366/oj", lang: "ENG" },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.resolved.celex, "32015L2366");
    assert.equal(res.payload.resolved.source, "search-cache");
  } finally {
    global.fetch = originalFetch;
  }
});

test("GET /api/resolve-url returns pure OJ fallback payload when cache and resolver cannot resolve", async () => {
  const store = new JsonLegalCacheStore(fixturePath);
  store.load();

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { results: { bindings: [] } };
    },
  });

  try {
    const resolver = createReferenceResolver({
      EURLEX_BASE: "https://eur-lex.europa.eu",
      RESOLUTION_CACHE_MS: 60_000,
      TIMEOUT_MS: 1_000,
      cacheGet,
      cacheSet,
      legalCacheStore: store,
      resolutionCache: new Map(),
      toSearchLang,
    });

    const { app } = registerTestRoutes({
      legalCacheStore: store,
      resolveEurlexUrl: resolver.resolveEurlexUrl,
    });
    const handler = app.routes.get("/api/resolve-url");
    const res = createResponseRecorder();

    await handler({
      query: { url: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=OJ:L:2015:00999:TOC", lang: "ENG" },
    }, res);

    assert.equal(res.statusCode, 404);
    assert.equal(res.payload.resolved, null);
    assert.equal(res.payload.fallback.type, "open-source-url");
  } finally {
    global.fetch = originalFetch;
  }
});

test("GET /api/resolve-reference falls back when cache lookup is ambiguous", async () => {
  const store = createAmbiguousStore();
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        results: {
          bindings: [
            { celex: { value: "http://publications.europa.eu/resource/celex/32020R0123" } },
          ],
        },
      };
    },
  });

  try {
    const resolver = createReferenceResolver({
      EURLEX_BASE: "https://eur-lex.europa.eu",
      RESOLUTION_CACHE_MS: 60_000,
      TIMEOUT_MS: 1_000,
      cacheGet,
      cacheSet,
      legalCacheStore: store,
      resolutionCache: new Map(),
      toSearchLang,
    });

    const { app } = registerTestRoutes({
      legalCacheStore: store,
      resolveReference: resolver.resolveReference,
      parseStructuredReference: (input) => ({
        raw: input.raw || "",
        actType: "regulation",
        year: "2020",
        number: "123",
        suffix: null,
        ojColl: null,
        ojNo: null,
        ojYear: null,
      }),
    });
    const handler = app.routes.get("/api/resolve-reference");
    const res = createResponseRecorder();

    await handler({
      query: { actType: "regulation", year: "2020", number: "123", lang: "ENG" },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.resolved.celex, "32020R0123");
    assert.equal(res.payload.resolved.source, "cellar-sparql");
  } finally {
    global.fetch = originalFetch;
  }
});
