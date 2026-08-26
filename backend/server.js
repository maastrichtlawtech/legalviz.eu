const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { JsonLegalCacheStore, DEFAULT_SEARCH_CACHE_PATH } = require('./search/search-index');
const { CitationGraphStore, DEFAULT_CITATION_GRAPH_PATH } = require('./search/citation-graph-store');
const { registerApiRoutes } = require('./routes/api-routes');
const { registerMcpEndpoint } = require('./mcp/mcp-http');
const { createParsedLawResolver, hasParsedLawContent } = require('./shared/parsed-law-service');
const { fetchConsolidatedVersions } = require('./shared/law-queries');
const { createFmxService } = require('./shared/fmx-service');
const { fetchEurlexHtmlLaw, parseEurlexHtmlToCombined, closeSharedPlaywrightBrowser } = require('./shared/eurlex-html-parser');
const { createHtmlCacheService } = require('./shared/html-cache-service');
const { createPersistentCache } = require('./shared/resolution-cache-store');
const { createGenerationLimitMiddleware, createRateLimitMiddleware } = require('./shared/rate-limit');
const { createOriginAllowlistMiddleware } = require('./shared/origin-guard');
const {
  createReferenceResolver,
  parseReferenceText,
  parseStructuredReference,
  RESOLUTION_NEGATIVE_CACHE_MS,
  validateCelex,
} = require('./shared/reference-utils');
const {
  ClientError,
  cacheGet,
  cacheSet,
  safeErrorResponse,
  toSearchLang,
  validateLang
} = require('./shared/api-utils');
const { CapacityError, createSemaphore } = require('./shared/concurrency');
const { createAnalytics } = require('./shared/analytics');

const app = express();
// Trust a fixed number of proxy hops so req.ip reflects the real client
// instead of a client-spoofed X-Forwarded-For header. Operators sitting
// behind more than one reverse proxy should set TRUSTED_PROXY_HOPS to match.
app.set('trust proxy', Number(process.env.TRUSTED_PROXY_HOPS) || 1);
const PORT = process.env.PORT || 3000;

// Shared cache directory for both FMX (*.xml, *.zip) and parsed HTML (*.parsed.json.gz)
const CACHE_DIR = process.env.CACHE_DIR || process.env.FMX_DIR || path.join(__dirname, 'law-cache');
const CELLAR_BASE = 'https://publications.europa.eu/resource';
const EURLEX_BASE = 'https://eur-lex.europa.eu';
const TIMEOUT_MS = 30_000;

// === Rate Limiting ===
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX) || 500; // requests per window (shared across all /api endpoints; one law view is ~6+ calls)

// Separate, far tighter budget for the routes that can trigger a billed model
// call. Charged only when a generation actually happens (see api-routes), so
// reading laws whose titles/summaries/digests are already cached is unaffected.
const GENERATION_LIMIT_WINDOW_MS = parseInt(process.env.GENERATION_LIMIT_WINDOW_MS) || 60 * 60 * 1000; // 1 hour
const GENERATION_LIMIT_MAX = parseInt(process.env.GENERATION_LIMIT_MAX) || 10; // generations per IP per window

// === Storage limits (each type evicts independently within the shared dir) ===
const STORAGE_LIMIT_MB = parseInt(process.env.STORAGE_LIMIT_MB) || 500; // FMX files
const HTML_CACHE_LIMIT_MB = parseInt(process.env.HTML_CACHE_LIMIT_MB) || 200; // parsed HTML

const RESOLUTION_CACHE_MS = 24 * 60 * 60 * 1000;
// Ensure cache directory exists
try {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
} catch {
  // The persistent resolution store reports the single cache degradation.
}

const resolutionCache = createPersistentCache({ cacheDir: CACHE_DIR });
const legalCacheStore = new JsonLegalCacheStore(process.env.SEARCH_CACHE_PATH || DEFAULT_SEARCH_CACHE_PATH);
const citationGraphStore = new CitationGraphStore(
  process.env.CITATION_GRAPH_PATH || DEFAULT_CITATION_GRAPH_PATH,
  { legalCacheStore },
);
const rateLimitMiddleware = createRateLimitMiddleware({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX
});
const generationLimitMiddleware = createGenerationLimitMiddleware({
  windowMs: GENERATION_LIMIT_WINDOW_MS,
  max: GENERATION_LIMIT_MAX
});
// CORS stays permissive everywhere else — the public API and the MCP endpoint
// are meant to be callable from anywhere; only generation is origin-restricted.
const generationOriginMiddleware = createOriginAllowlistMiddleware();

legalCacheStore.load();
citationGraphStore.load();
const analytics = createAnalytics({ cacheDir: CACHE_DIR, dataStore: legalCacheStore });

// Middleware
app.use(cors());
app.use(express.json());
app.use(analytics.middleware);
const { findDownloadUrls, findFmx4Uri, prepareLawPayload, sendLawResponse } = createFmxService({
  CELLAR_BASE,
  FMX_DIR: CACHE_DIR,
  STORAGE_LIMIT_MB,
  TIMEOUT_MS,
});

const htmlCache = createHtmlCacheService({
  CACHE_DIR,
  STORAGE_LIMIT_MB: HTML_CACHE_LIMIT_MB,
});

const { resolveEurlexUrl, resolveReference, resolveReferenceViaCellar, runSparqlQuery } = createReferenceResolver({
  EURLEX_BASE,
  RESOLUTION_CACHE_MS,
  RESOLUTION_NEGATIVE_CACHE_MS,
  TIMEOUT_MS,
  cacheGet,
  cacheSet,
  legalCacheStore,
  resolutionCache,
  toSearchLang,
});

// CELEX to friendly name mapping
const CELEX_NAMES = {
  '32016R0679': 'GDPR',
  '32024R1689': 'AIA',
  '32022R1925': 'DMA',
  '32022R2065': 'DSA',
  '32022R0868': 'DGA',
  '32023R2854': 'DA'
};

// fetchEurlexHtmlLaw always fetches the English EUR-Lex HTML page regardless of the
// requested language (see shared/eurlex-html-parser.js). Cache lookups/writes must key
// on the language actually served, not the requested one, so we don't store identical
// English HTML redundantly under every language code or mislabel it as translated.
const HTML_FALLBACK_SERVED_LANG = 'ENG';

/**
 * A fetch that ends in a WAF challenge launches a fresh Chromium (see
 * `closeBrowserAfterFetch` below), which is by far the most expensive thing a
 * single request can make this process do. Cap how many can be in flight at
 * once and reject the overflow, so a burst degrades the HTML fallback instead
 * of OOM-ing the container and taking law serving, search and MCP with it.
 */
const HTML_FETCH_CONCURRENCY = parseInt(process.env.HTML_FETCH_CONCURRENCY) || 2;
const HTML_FETCH_QUEUE_LIMIT = parseInt(process.env.HTML_FETCH_QUEUE_LIMIT) || 20;
// Parsed-empty results are deliberately not written to the HTML disk cache
// (the raw HTML is worthless), which without a negative cache means every
// repeat request re-fetches — and, during a challenge period, re-launches.
const HTML_EMPTY_PARSE_TTL_MS = parseInt(process.env.HTML_EMPTY_PARSE_TTL_MS) || 10 * 60 * 1000;
const HTML_EMPTY_PARSE_MAX_ENTRIES = 500;

const htmlFetchSemaphore = createSemaphore({
  limit: HTML_FETCH_CONCURRENCY,
  maxQueue: HTML_FETCH_QUEUE_LIMIT,
  name: 'EUR-Lex HTML fetch',
});
// Both are keyed on CELEX alone, not `celex:lang`: the fetch always serves
// English (see HTML_FALLBACK_SERVED_LANG), so requests differing only in the
// requested language would otherwise each launch their own browser for the
// very same page.
const inFlightHtmlLoads = new Map(); // celex -> Promise<{ servedLang, parsed }>
const emptyHtmlParseCache = new Map(); // celex -> { servedLang, parsed }

/**
 * On-demand HTML law fetcher with disk caching.
 *
 * Caches raw HTML so parser improvements apply without re-fetching.
 * Parses on each request (JSDOM is fast; the network/Playwright fetch is the bottleneck).
 *
 * 1. Check disk cache for raw HTML (keyed by the language actually served, always English)
 * 2. If miss, fetch from EUR-Lex (plain fetch first, Playwright on WAF challenge)
 * 3. Store raw HTML to disk cache (same served-language key)
 * 4. Parse and return, including the requested `lang` and the honest `servedLang`
 */
async function loadHtmlLaw(celex, lang) {
  let servedLang = HTML_FALLBACK_SERVED_LANG;
  let rawHtml = await htmlCache.get(celex, servedLang);
  let fromCache = Boolean(rawHtml);

  async function fetchFreshHtml() {
    let fetched;
    try {
      fetched = await htmlFetchSemaphore.run(() => fetchEurlexHtmlLaw({
        celex,
        lang,
        eurlexBase: EURLEX_BASE,
        timeoutMs: TIMEOUT_MS,
        usePlaywrightOnChallenge: true,
        closeBrowserAfterFetch: true,
      }));
    } catch (err) {
      if (err instanceof CapacityError) {
        throw new ClientError(
          'EUR-Lex HTML fetching is busy; please retry shortly',
          503,
          'html_fetch_busy',
        );
      }
      throw err;
    }
    servedLang = fetched.servedLang || HTML_FALLBACK_SERVED_LANG;
    return fetched.rawHtml;
  }

  if (!rawHtml) {
    rawHtml = await fetchFreshHtml();
    fromCache = false;
  }

  let parsed;
  try {
    parsed = await parseEurlexHtmlToCombined(rawHtml, servedLang);
  } catch (err) {
    if (fromCache && err?.code === 'law_not_found') {
      htmlCache.remove(celex, servedLang);
      rawHtml = await fetchFreshHtml();
      fromCache = false;
      parsed = await parseEurlexHtmlToCombined(rawHtml, servedLang);
    } else {
      throw err;
    }
  }

  const hasContent = hasParsedLawContent(parsed);
  if (!fromCache && hasContent) {
    htmlCache.put(celex, servedLang, rawHtml).catch((err) => {
      console.error(`[HtmlCache] Failed to cache ${celex}_${servedLang}:`, err.message);
    });
  } else if (!fromCache) {
    console.warn(`[HtmlCache] Skipping cache for ${celex}_${servedLang}: parsed HTML did not yield law content`);
  }

  return { servedLang, parsed, empty: !hasContent };
}

async function fetchAndParseHtmlLawCached(celex, lang) {
  function withRequestedLang({ servedLang, parsed }) {
    return {
      celex,
      lang,
      servedLang,
      source: 'eurlex-html',
      format: 'combined-v1',
      ...parsed,
    };
  }

  const negative = cacheGet(emptyHtmlParseCache, celex);
  if (negative) return withRequestedLang(negative);

  // Single-flight, mirroring `inFlightDownloads` on the FMX path: N concurrent
  // requests for the same CELEX must not launch N browsers.
  const inFlight = inFlightHtmlLoads.get(celex);
  if (inFlight) return withRequestedLang(await inFlight);

  const promise = loadHtmlLaw(celex, lang).finally(() => {
    inFlightHtmlLoads.delete(celex);
  });
  inFlightHtmlLoads.set(celex, promise);

  const result = await promise;
  if (result.empty) {
    cacheSet(
      emptyHtmlParseCache,
      celex,
      { servedLang: result.servedLang, parsed: result.parsed },
      HTML_EMPTY_PARSE_TTL_MS,
      HTML_EMPTY_PARSE_MAX_ENTRIES,
    );
  }
  return withRequestedLang(result);
}

const resolveParsedLaw = createParsedLawResolver({
  prepareLawPayload,
  fetchAndParseHtmlLaw: fetchAndParseHtmlLawCached,
  CELEX_NAMES,
  fetchConsolidatedVersions,
  runSparqlQuery,
});

registerApiRoutes(app, {
  analytics,
  CELEX_NAMES,
  EURLEX_BASE,
  FMX_DIR: CACHE_DIR,
  RATE_LIMIT_MAX,
  RESOLUTION_CACHE_MS,
  RESOLUTION_NEGATIVE_CACHE_MS,
  cacheGet,
  cacheSet,
  findDownloadUrls,
  findFmx4Uri,
  citationGraphStore,
  legalCacheStore,
  parseReferenceText,
  parseStructuredReference,
  prepareLawPayload,
  rateLimitMiddleware,
  generationLimitMiddleware,
  generationOriginMiddleware,
  resolutionCache,
  resolveEurlexUrl,
  resolveParsedLaw,
  resolveReference,
  resolveReferenceViaCellar,
  runSparqlQuery,
  safeErrorResponse,
  sendLawResponse,
  validateCelex,
  validateLang
});

registerMcpEndpoint(app, {
  analytics,
  citationGraphStore,
  legalCacheStore,
  resolveEurlexUrl,
  resolveParsedLaw,
  resolveReference,
  runSparqlQuery,
  rateLimitMiddleware,
  FMX_DIR: CACHE_DIR,
});

// Express error-handling middleware — must be registered after all routes,
// and must take four arguments to be recognized as an error handler.
// Without this, a malformed request body thrown by express.json() (or any
// other synchronous middleware/route error) falls through to Express's
// default handler, which returns an HTML page (with a stack trace outside
// production). For /mcp specifically, callers are JSON-RPC clients and
// expect a JSON-RPC error envelope, not HTML.
app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  const isJsonParseError = err instanceof SyntaxError && 'body' in err;
  const status = isJsonParseError ? 400 : (err.statusCode || 500);

  if (req.path === '/mcp') {
    return res.status(status).json({
      jsonrpc: '2.0',
      error: {
        code: isJsonParseError ? -32700 : -32603,
        message: isJsonParseError ? 'Parse error' : 'Internal server error',
      },
      id: null,
    });
  }

  if (isJsonParseError) {
    return res.status(400).json({ error: 'Invalid JSON in request body' });
  }

  console.error('[API] Unhandled error:', err.message);
  return res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, () => {
  console.log(`EUR-Lex FMX API running on port ${PORT}`);
  console.log(`MCP endpoint: POST /mcp (Streamable HTTP)`);
  console.log(`Cache directory: ${CACHE_DIR} (FMX: ${STORAGE_LIMIT_MB} MB, HTML: ${HTML_CACHE_LIMIT_MB} MB)`);
  console.log(`Rate limit: ${RATE_LIMIT_MAX} req/15min per IP`);
  console.log(`Search cache: ${legalCacheStore.getStatus().ready ? 'loaded' : 'not loaded'} (${legalCacheStore.activePath})`);
  console.log(`Citation graph: ${citationGraphStore.getStatus().ready ? 'loaded' : 'not loaded'} (${citationGraphStore.graphPath})`);
  {
    const fulltextStatus = legalCacheStore.getStatus().fulltext;
    console.log(fulltextStatus.available
      ? `Full-text index: loaded (v${fulltextStatus.version}, ${fulltextStatus.unitCount} units, ${fulltextStatus.actCount} acts)`
      : `Full-text index: not loaded (${fulltextStatus.reason})`);
  }
});

let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] Received ${signal}, closing gracefully...`);

  const forceExit = setTimeout(() => {
    console.error('[shutdown] Grace period exceeded, forcing exit');
    process.exit(1);
  }, 10_000).unref();

  try {
    await new Promise((resolve) => server.close(resolve));
    analytics.shutdown();
    resolutionCache.persistentStore?.close();
    legalCacheStore.close();
    await closeSharedPlaywrightBrowser();
    console.log('[shutdown] Clean exit');
    clearTimeout(forceExit);
    process.exit(0);
  } catch (err) {
    console.error('[shutdown] Error during shutdown:', err);
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
