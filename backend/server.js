const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { JsonLegalCacheStore, DEFAULT_SEARCH_CACHE_PATH } = require('./search/search-index');
const { CitationGraphStore, DEFAULT_CITATION_GRAPH_PATH } = require('./search/citation-graph-store');
const { registerApiRoutes } = require('./routes/api-routes');
const { registerMcpEndpoint } = require('./mcp/mcp-http');
const { createParsedLawResolver } = require('./shared/parsed-law-service');
const { createFmxService } = require('./shared/fmx-service');
const { fetchEurlexHtmlLaw, parseEurlexHtmlToCombined, closeSharedPlaywrightBrowser } = require('./shared/eurlex-html-parser');
const { createHtmlCacheService } = require('./shared/html-cache-service');
const { createRateLimitMiddleware } = require('./shared/rate-limit');
const {
  createReferenceResolver,
  parseReferenceText,
  parseStructuredReference,
  validateCelex,
} = require('./shared/reference-utils');
const {
  cacheGet,
  cacheSet,
  safeErrorResponse,
  toSearchLang,
  validateLang
} = require('./shared/api-utils');
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

// === Storage limits (each type evicts independently within the shared dir) ===
const STORAGE_LIMIT_MB = parseInt(process.env.STORAGE_LIMIT_MB) || 500; // FMX files
const HTML_CACHE_LIMIT_MB = parseInt(process.env.HTML_CACHE_LIMIT_MB) || 200; // parsed HTML

const resolutionCache = new Map(); // key -> { expiresAt, value }
const RESOLUTION_CACHE_MS = 24 * 60 * 60 * 1000;
const legalCacheStore = new JsonLegalCacheStore(process.env.SEARCH_CACHE_PATH || DEFAULT_SEARCH_CACHE_PATH);
const citationGraphStore = new CitationGraphStore(process.env.CITATION_GRAPH_PATH || DEFAULT_CITATION_GRAPH_PATH);
const rateLimitMiddleware = createRateLimitMiddleware({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX
});

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

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

function hasParsedLawContent(parsed) {
  return Boolean(
    parsed
    && (
      parsed.articles?.length
      || parsed.recitals?.length
      || parsed.annexes?.length
      || parsed.definitions?.length
    )
  );
}

// fetchEurlexHtmlLaw always fetches the English EUR-Lex HTML page regardless of the
// requested language (see shared/eurlex-html-parser.js). Cache lookups/writes must key
// on the language actually served, not the requested one, so we don't store identical
// English HTML redundantly under every language code or mislabel it as translated.
const HTML_FALLBACK_SERVED_LANG = 'ENG';

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
async function fetchAndParseHtmlLawCached(celex, lang) {
  let servedLang = HTML_FALLBACK_SERVED_LANG;
  let rawHtml = await htmlCache.get(celex, servedLang);
  let fromCache = Boolean(rawHtml);

  async function fetchFreshHtml() {
    const fetched = await fetchEurlexHtmlLaw({
      celex,
      lang,
      eurlexBase: EURLEX_BASE,
      timeoutMs: TIMEOUT_MS,
      usePlaywrightOnChallenge: true,
      closeBrowserAfterFetch: true,
    });
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

  if (!fromCache && hasParsedLawContent(parsed)) {
    htmlCache.put(celex, servedLang, rawHtml).catch((err) => {
      console.error(`[HtmlCache] Failed to cache ${celex}_${servedLang}:`, err.message);
    });
  } else if (!fromCache) {
    console.warn(`[HtmlCache] Skipping cache for ${celex}_${servedLang}: parsed HTML did not yield law content`);
  }

  return {
    celex,
    lang,
    servedLang,
    source: 'eurlex-html',
    format: 'combined-v1',
    ...parsed,
  };
}

const resolveParsedLaw = createParsedLawResolver({
  prepareLawPayload,
  fetchAndParseHtmlLaw: fetchAndParseHtmlLawCached,
  CELEX_NAMES,
});

registerApiRoutes(app, {
  analytics,
  CELEX_NAMES,
  EURLEX_BASE,
  FMX_DIR: CACHE_DIR,
  RATE_LIMIT_MAX,
  RESOLUTION_CACHE_MS,
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

const server = app.listen(PORT, () => {
  console.log(`EUR-Lex FMX API running on port ${PORT}`);
  console.log(`MCP endpoint: POST /mcp (Streamable HTTP)`);
  console.log(`Cache directory: ${CACHE_DIR} (FMX: ${STORAGE_LIMIT_MB} MB, HTML: ${HTML_CACHE_LIMIT_MB} MB)`);
  console.log(`Rate limit: ${RATE_LIMIT_MAX} req/15min per IP`);
  console.log(`Search cache: ${legalCacheStore.getStatus().ready ? 'loaded' : 'not loaded'} (${legalCacheStore.activePath})`);
  console.log(`Citation graph: ${citationGraphStore.getStatus().ready ? 'loaded' : 'not loaded'} (${citationGraphStore.graphPath})`);
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
