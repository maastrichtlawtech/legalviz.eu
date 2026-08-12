const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { ClientError, requireCitationGraph } = require("../shared/api-utils");
const { parseFmxXml } = require("../shared/fmx-parser-node");
const { createSearchHandler } = require("../search/search-route");
const { createTopicsHandler } = require("../search/topics-route");
const { createDefinitionCompareHandler, createDefinitionSearchHandler } = require("../search/definitions-route");
const { fetchMetadata, fetchAmendments, fetchConsolidatedVersions, fetchImplementing, fetchCaseLaw } = require("../shared/law-queries");
const { ChatProviderError } = require("../shared/openrouter-chat");
const { ensureRecitalTitles } = require("../shared/recital-title-service");
const {
  CACHE_VERSION: LAW_SUMMARY_CACHE_VERSION,
  PROMPT_VERSION: LAW_SUMMARY_PROMPT_VERSION,
  SCHEMA_VERSION: LAW_SUMMARY_SCHEMA_VERSION,
  ensureLawSummary,
} = require("../shared/law-summary-service");
const { ensureArticleDigest } = require("../shared/article-digest-service");
const { ensureCaseLawDigest } = require("../shared/case-law-digest-service");

const DEFAULT_STATIC_SUMMARY_MODEL = process.env.LAW_SUMMARY_MODEL || process.env.ARTICLE_QA_ANSWER_MODEL || process.env.ARTICLE_QA_MODEL || 'google/gemini-3.5-flash-lite';
const DEFAULT_ARTICLE_DIGEST_MODEL = process.env.ARTICLE_DIGEST_MODEL || process.env.LAW_SUMMARY_MODEL || process.env.ARTICLE_QA_ANSWER_MODEL || process.env.ARTICLE_QA_MODEL || 'google/gemini-3.5-flash-lite';
const DEFAULT_CASE_LAW_DIGEST_MODEL = process.env.CASE_LAW_DIGEST_MODEL || process.env.ARTICLE_DIGEST_MODEL || process.env.LAW_SUMMARY_MODEL || process.env.ARTICLE_QA_ANSWER_MODEL || process.env.ARTICLE_QA_MODEL || 'google/gemini-3.5-flash-lite';
const DEFAULT_RECITAL_TITLE_MODEL = process.env.RECITAL_TITLE_MODEL || process.env.ARTICLE_QA_PLANNER_MODEL || process.env.ARTICLE_QA_MODEL || 'google/gemini-3.5-flash-lite';

function getStaticSummaryApiKey() {
  return process.env.LAW_SUMMARY_OPENROUTER_API_KEY
    || process.env.ARTICLE_QA_OPENROUTER_API_KEY
    || process.env.OPENROUTER_API_KEY;
}

function getRecitalTitleApiKey() {
  return process.env.RECITAL_TITLE_OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY;
}

/**
 * Normalise an upstream chat error into a user-facing message + stable code.
 * Maps OpenRouter's 402/429/401 into friendlier text; anything else collapses
 * to a generic 502 so provider internals (raw upstream messages, upstream
 * status codes) stay server-side. The raw detail is returned for logging only
 * — see sendChatError, which is the only intended caller.
 */
function mapChatError(err) {
  const status = err?.status || 502;
  const detail = err?.message || 'Upstream chat request failed';
  if (status === 402) {
    return {
      status: 503,
      code: 'ai_service_unavailable',
      message: 'The AI service is temporarily unavailable (out of credits). Please try again later or contact the administrator.',
      detail,
    };
  }
  if (status === 429) {
    return {
      status: 429,
      code: 'ai_rate_limited',
      message: 'The AI service is rate-limiting requests — please wait a moment and try again.',
      detail,
    };
  }
  if (status === 401 || status === 403) {
    return {
      status: 503,
      code: 'ai_auth_failed',
      message: 'The AI service rejected our credentials — please contact the administrator.',
      detail,
    };
  }
  return {
    status: 502,
    code: 'chat_upstream_failed',
    message: 'The AI service could not be reached. Please try again later.',
    detail,
  };
}

/** Log the upstream detail, respond with the sanitised mapping. */
function sendChatError(res, err, context) {
  const mapped = mapChatError(err);
  console.error(`[API] ${context} (${mapped.code}):`, mapped.detail);
  return res.status(mapped.status).json({ code: mapped.code, message: mapped.message });
}

const CASE_LAW_ROUTE_CACHE_MS = 5 * 60 * 1000;

function parsePaginationValue(value, name, { defaultValue, min, max = Infinity }) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const raw = String(value);
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    const requirement = Number.isFinite(max) ? `between ${min} and ${max}` : `${min} or greater`;
    throw new ClientError(`Query parameter "${name}" must be an integer ${requirement}`, 400, 'invalid_pagination');
  }
  return parsed;
}

function registerApiRoutes(app, deps) {
  const {
    analytics,
    CELEX_NAMES,
    FMX_DIR,
    RESOLUTION_CACHE_MS,
    cacheGet,
    cacheSet,
    citationGraphStore,
    findDownloadUrls,
    findFmx4Uri,
    parseReferenceText,
    parseStructuredReference,
    prepareLawPayload,
    rateLimitMiddleware,
    // Guards applied *only* to the four routes that can trigger a billed model
    // call, on top of the generic limiter: a tight per-IP generation budget
    // (charged below on cache misses) and an origin allowlist that keeps the
    // permissive CORS of the rest of the API from funding third-party pages.
    generationLimitMiddleware = (req, res, next) => next(),
    generationOriginMiddleware = (req, res, next) => next(),
    resolutionCache,
    legalCacheStore,
    resolveEurlexUrl,
    resolveParsedLaw,
    ensureLawSummary: ensureLawSummaryImpl = ensureLawSummary,
    resolveReference,
    runSparqlQuery,
    safeErrorResponse,
    sendLawResponse,
    validateCelex,
    validateLang
  } = deps;

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/api/_stats', rateLimitMiddleware, (req, res) => {
    const token = process.env.ANALYTICS_TOKEN;
    if (!token) return res.status(404).json({ error: 'Not found' });
    const provided = String(req.headers['x-analytics-token'] || '');
    const tokenBuf = Buffer.from(token);
    const providedBuf = Buffer.from(provided);
    if (providedBuf.length !== tokenBuf.length || !crypto.timingSafeEqual(providedBuf, tokenBuf)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    res.json(analytics.getStats());
  });

  app.get('/api/laws', rateLimitMiddleware, (req, res) => {
    try {
      const files = fs.readdirSync(FMX_DIR);
      const laws = files.filter((filename) => filename.endsWith('.xml') || filename.endsWith('.zip'));
      res.json({ laws });
    } catch (err) {
      safeErrorResponse(res, err, 'Failed to list cached laws');
    }
  });

  app.get('/api/laws/:celex/articles/:n/cited-by', rateLimitMiddleware, (req, res) => {
    try {
      const { celex, n } = req.params;
      if (!validateCelex(celex)) {
        return res.status(400).json({ error: 'Invalid CELEX format', code: 'invalid_celex' });
      }
      const article = String(n || '').trim();
      if (!article) {
        return res.status(400).json({ error: 'Article number is required', code: 'invalid_article' });
      }
      const limit = parsePaginationValue(req.query.limit, 'limit', { defaultValue: 50, min: 1, max: 200 });
      const offset = parsePaginationValue(req.query.offset, 'offset', { defaultValue: 0, min: 0 });
      res.json(requireCitationGraph(citationGraphStore).getArticleCitations(celex, article, { limit, offset }));
    } catch (err) {
      safeErrorResponse(res, err, 'Failed to fetch citing provisions');
    }
  });

  app.get('/api/laws/:celex/cited-by', rateLimitMiddleware, (req, res) => {
    try {
      const { celex } = req.params;
      if (!validateCelex(celex)) {
        return res.status(400).json({ error: 'Invalid CELEX format', code: 'invalid_celex' });
      }
      const citingLawsLimit = parsePaginationValue(req.query.citingLaws, 'citingLaws', { defaultValue: 10, min: 1, max: 50 });
      res.json(requireCitationGraph(citationGraphStore).getActCitations(celex, { citingLawsLimit }));
    } catch (err) {
      safeErrorResponse(res, err, 'Failed to fetch citation counts');
    }
  });

  app.get('/api/laws/by-reference', rateLimitMiddleware, async (req, res) => {
    try {
      const rawLang = req.query.lang || 'ENG';
      const lang = validateLang(rawLang);
      if (!lang) {
        return res.status(400).json({ error: `Invalid language code: ${rawLang}` });
      }

      const reference = parseStructuredReference(req.query);
      if (!reference.actType || !reference.year || !reference.number) {
        return res.status(400).json({
          error: 'Provide official reference parameters: actType, year, number',
          code: 'invalid_reference',
        });
      }

      const resolution = await resolveReference(reference, lang);
      if (!resolution.resolved?.celex) {
        return res.status(404).json({
          error: 'Could not resolve the official reference to a CELEX identifier',
          code: 'resolution_failed',
          details: {
            parsed: reference,
            tried: resolution.tried,
            fallback: resolution.fallback,
          },
        });
      }

      try {
        const { servePath } = await prepareLawPayload(resolution.resolved.celex, lang);
        res.setHeader('X-Resolved-CELEX', resolution.resolved.celex);
        res.setHeader('X-Resolved-ELI', resolution.resolved.eli);
        sendLawResponse(res, servePath);
      } catch (err) {
        if (err instanceof ClientError && err.statusCode === 404) {
          throw new ClientError(
            `Resolved CELEX ${resolution.resolved.celex}, but no FMX files are available`,
            404,
            'fmx_not_found',
            {
              resolved: resolution.resolved,
              parsed: reference,
              fallback: resolution.fallback,
            }
          );
        }
        throw err;
      }
    } catch (err) {
      if (!res.headersSent) {
        safeErrorResponse(res, err, 'Failed to fetch law by reference');
      }
    }
  });

  app.get('/api/laws/:celex', rateLimitMiddleware, async (req, res) => {
    try {
      const { celex } = req.params;
      const rawLang = req.query.lang || 'ENG';

      if (!validateCelex(celex)) {
        return res.status(400).json({ error: 'Invalid CELEX format. Expected: 32016R0679' });
      }

      const lang = validateLang(rawLang);
      if (!lang) {
        return res.status(400).json({ error: `Invalid language code: ${rawLang}` });
      }

      const { servePath } = await prepareLawPayload(celex, lang);
      sendLawResponse(res, servePath);
    } catch (err) {
      if (!res.headersSent) {
        safeErrorResponse(res, err, 'Failed to fetch law');
      }
    }
  });

  app.get('/api/laws/:celex/parsed', rateLimitMiddleware, async (req, res) => {
    try {
      const { celex } = req.params;
      const rawLang = req.query.lang || 'ENG';
      const skipFmxProbe = req.query.skipFmxProbe === '1';

      if (!validateCelex(celex)) {
        return res.status(400).json({ error: 'Invalid CELEX format. Expected: 32016R0679' });
      }

      const lang = validateLang(rawLang);
      if (!lang) {
        return res.status(400).json({ error: `Invalid language code: ${rawLang}` });
      }

      const parsed = await resolveParsedLaw(celex, lang, { skipFmxProbe });
      res.json(parsed);
    } catch (err) {
      if (!res.headersSent) {
        safeErrorResponse(res, err, 'Failed to fetch and parse law');
      }
    }
  });

  app.get('/api/laws/:celex/info', rateLimitMiddleware, async (req, res) => {
    try {
      const { celex } = req.params;
      const rawLang = req.query.lang || 'ENG';

      if (!validateCelex(celex)) {
        return res.status(400).json({ error: 'Invalid CELEX format' });
      }

      const lang = validateLang(rawLang);
      if (!lang) {
        return res.status(400).json({ error: `Invalid language code: ${rawLang}` });
      }

      const fmx4Uri = await findFmx4Uri(celex, lang);
      const { type } = await findDownloadUrls(fmx4Uri);

      res.json({
        celex,
        lang,
        name: CELEX_NAMES[celex] || null,
        type
      });
    } catch (err) {
      safeErrorResponse(res, err, 'Failed to fetch law metadata');
    }
  });

  app.get('/api/laws/:celex/metadata', rateLimitMiddleware, async (req, res) => {
    try {
      const { celex } = req.params;

      if (!validateCelex(celex)) {
        return res.status(400).json({ error: 'Invalid CELEX format' });
      }

      const cacheKey = `metadata:${celex}`;
      const cached = cacheGet(resolutionCache, cacheKey);
      if (cached) {
        return res.json(cached);
      }

      const payload = await fetchMetadata(celex, runSparqlQuery);
      cacheSet(resolutionCache, cacheKey, payload, RESOLUTION_CACHE_MS);
      res.json(payload);
    } catch (err) {
      safeErrorResponse(res, err, 'Failed to fetch law metadata');
    }
  });

  app.get('/api/laws/:celex/amendments', rateLimitMiddleware, async (req, res) => {
    try {
      const { celex } = req.params;

      if (!validateCelex(celex)) {
        return res.status(400).json({ error: 'Invalid CELEX format' });
      }

      const cacheKey = `amendments:${celex}`;
      const cached = cacheGet(resolutionCache, cacheKey);
      if (cached) {
        return res.json(cached);
      }

      const payload = await fetchAmendments(celex, runSparqlQuery);
      cacheSet(resolutionCache, cacheKey, payload, RESOLUTION_CACHE_MS);
      res.json(payload);
    } catch (err) {
      safeErrorResponse(res, err, 'Failed to fetch amendment history');
    }
  });

  app.get('/api/laws/:celex/consolidated', rateLimitMiddleware, async (req, res) => {
    try {
      const { celex } = req.params;

      if (!validateCelex(celex)) {
        return res.status(400).json({ error: 'Invalid CELEX format' });
      }

      const cacheKey = `consolidated:${celex}`;
      const cached = cacheGet(resolutionCache, cacheKey);
      if (cached) {
        return res.json(cached);
      }

      const payload = await fetchConsolidatedVersions(celex, runSparqlQuery);
      cacheSet(resolutionCache, cacheKey, payload, RESOLUTION_CACHE_MS);
      res.json(payload);
    } catch (err) {
      safeErrorResponse(res, err, 'Failed to fetch consolidated versions');
    }
  });

  app.get('/api/laws/:celex/implementing', rateLimitMiddleware, async (req, res) => {
    try {
      const { celex } = req.params;

      if (!validateCelex(celex)) {
        return res.status(400).json({ error: 'Invalid CELEX format' });
      }

      const cacheKey = `implementing:${celex}`;
      const cached = cacheGet(resolutionCache, cacheKey);
      if (cached) {
        return res.json(cached);
      }

      const payload = await fetchImplementing(celex, runSparqlQuery);
      cacheSet(resolutionCache, cacheKey, payload, RESOLUTION_CACHE_MS);
      res.json(payload);
    } catch (err) {
      safeErrorResponse(res, err, 'Failed to fetch implementing acts');
    }
  });

  // Short-TTL memo shared by /case-law and the two digest routes. The digest
  // routes need the case-law payload on every request (its hash is part of
  // the digest cache key), which used to mean a live SPARQL round trip even
  // for fully cached digests — so a Cellar hiccup 503'd cached content, and a
  // partial case list silently regenerated the digest at LLM cost. Within the
  // TTL, repeat requests are served from this memo instead.
  async function fetchCaseLawMemo(celex) {
    const cacheKey = `case-law:${celex}`;
    const cached = cacheGet(resolutionCache, cacheKey);
    if (cached) return cached;
    const payload = await fetchCaseLaw(celex, runSparqlQuery, { cacheDir: FMX_DIR, dataStore: legalCacheStore });
    cacheSet(resolutionCache, cacheKey, payload, Math.min(RESOLUTION_CACHE_MS, CASE_LAW_ROUTE_CACHE_MS));
    return payload;
  }

  app.get('/api/laws/:celex/case-law', rateLimitMiddleware, async (req, res) => {
    try {
      const { celex } = req.params;

      if (!validateCelex(celex)) {
        return res.status(400).json({ error: 'Invalid CELEX format' });
      }

      res.json(await fetchCaseLawMemo(celex));
    } catch (err) {
      safeErrorResponse(res, err, 'Failed to fetch case law');
    }
  });

  app.get('/api/laws/:celex/recital-titles', rateLimitMiddleware, generationOriginMiddleware, generationLimitMiddleware, async (req, res) => {
    try {
      const { celex } = req.params;
      const rawLang = req.query.lang || 'ENG';

      if (!validateCelex(celex)) {
        return res.status(400).json({ error: 'Invalid CELEX format' });
      }
      const lang = validateLang(rawLang);
      if (!lang) {
        return res.status(400).json({ error: `Invalid language code: ${rawLang}` });
      }

      const apiKey = getRecitalTitleApiKey();
      if (!apiKey) {
        return res.status(503).json({ error: 'OpenRouter API key is not configured for recital titles', code: 'openrouter_unconfigured' });
      }

      const parsed = await resolveParsedLaw(celex, lang, { skipFmxProbe: req.query.skipFmxProbe === '1' });
      const result = await ensureRecitalTitles({
        celex,
        lang,
        recitals: parsed.recitals || [],
        cacheDir: FMX_DIR,
        apiKey,
        model: DEFAULT_RECITAL_TITLE_MODEL,
      });

      // Only a real generation costs money; a cache hit must not consume
      // the caller's generation budget.
      if (!result.cached) req.chargeGeneration?.();

      res.json({
        celex,
        lang,
        model: result.model,
        cached: result.cached,
        titles: result.titles,
      });
    } catch (err) {
      if (err instanceof ChatProviderError) {
        return sendChatError(res, err, 'Failed to generate recital titles');
      }
      safeErrorResponse(res, err, 'Failed to generate recital titles');
    }
  });

  app.get('/api/laws/:celex/summary', rateLimitMiddleware, generationOriginMiddleware, generationLimitMiddleware, async (req, res) => {
    try {
      const { celex } = req.params;

      if (!validateCelex(celex)) {
        return res.status(400).json({ error: 'Invalid CELEX format' });
      }
      // Summaries are generated in English only for now; the lang query
      // parameter is ignored so other languages cannot trigger generation.
      const lang = 'ENG';

      const apiKey = getStaticSummaryApiKey();
      if (!apiKey) {
        return res.status(503).json({ error: 'OpenRouter API key is not configured', code: 'openrouter_unconfigured' });
      }

      const skipFmxProbe = req.query.skipFmxProbe === '1';
      const result = await ensureLawSummaryImpl({
        celex,
        lang,
        cacheDir: FMX_DIR,
        apiKey,
        model: DEFAULT_STATIC_SUMMARY_MODEL,
        // Resolve the raw FMX source without parsing it, so the summary
        // service can validate its cache against the raw bytes and skip the
        // (expensive) Formex parse on a hit.
        getSource: skipFmxProbe ? null : async () => {
          try {
            const { servePath } = await prepareLawPayload(celex, lang);
            return {
              rawText: fs.readFileSync(servePath, 'utf8'),
              sourceFile: path.relative(FMX_DIR, servePath),
            };
          } catch (err) {
            if (err instanceof ClientError && err.statusCode === 404) {
              // No FMX for this law: defer to the HTML fallback in
              // getParsedLaw, which calls resolveParsedLaw(..., {
              // skipFmxProbe: true }) and handles the EUR-Lex HTML path.
              return null;
            }
            throw err;
          }
        },
        getParsedLaw: async (rawText) => {
          if (rawText != null) {
            return {
              celex,
              lang,
              name: CELEX_NAMES[celex] || null,
              format: 'combined-v1',
              source: 'fmx',
              ...(await parseFmxXml(rawText)),
            };
          }
          return resolveParsedLaw(celex, lang, { skipFmxProbe: true });
        },
      });

      // Only a real generation costs money; a cache hit must not consume
      // the caller's generation budget.
      if (!result.cached) req.chargeGeneration?.();

      res.json({
        celex,
        lang,
        cacheVersion: LAW_SUMMARY_CACHE_VERSION,
        schemaVersion: LAW_SUMMARY_SCHEMA_VERSION,
        promptVersion: LAW_SUMMARY_PROMPT_VERSION,
        model: result.model,
        cached: result.cached,
        generatedAt: result.generatedAt,
        summary: result.summary,
      });
    } catch (err) {
      if (err instanceof ChatProviderError) {
        return sendChatError(res, err, 'Failed to generate law summary');
      }
      safeErrorResponse(res, err, 'Failed to generate law summary');
    }
  });

  app.get('/api/laws/:celex/articles/:n/case-law-digest', rateLimitMiddleware, generationOriginMiddleware, generationLimitMiddleware, async (req, res) => {
    try {
      const { celex } = req.params;
      const articleNumber = String(req.params.n || '').trim();
      const rawLang = req.query.lang || 'ENG';

      if (!validateCelex(celex)) {
        return res.status(400).json({ error: 'Invalid CELEX format' });
      }
      if (!articleNumber) {
        return res.status(400).json({ error: 'Article number is required' });
      }
      const lang = validateLang(rawLang);
      if (!lang) {
        return res.status(400).json({ error: `Invalid language code: ${rawLang}` });
      }

      const apiKey = getStaticSummaryApiKey();
      if (!apiKey) {
        return res.status(503).json({ error: 'OpenRouter API key is not configured', code: 'openrouter_unconfigured' });
      }

      const parsed = await resolveParsedLaw(celex, lang, { skipFmxProbe: req.query.skipFmxProbe === '1' });
      const caseLawPayload = await fetchCaseLawMemo(celex);
      const result = await ensureArticleDigest({
        celex,
        articleNumber,
        lang,
        parsedLaw: parsed,
        caseLawPayload,
        cacheDir: FMX_DIR,
        apiKey,
        model: DEFAULT_ARTICLE_DIGEST_MODEL,
      });

      // Only a real generation costs money; a cache hit must not consume
      // the caller's generation budget.
      if (!result.cached) req.chargeGeneration?.();

      res.json({
        celex,
        articleNumber,
        lang,
        model: result.model,
        cached: result.cached,
        generatedAt: result.generatedAt,
        caseLawCacheVersion: result.caseLawCacheVersion,
        digest: result.digest,
      });
    } catch (err) {
      if (err instanceof ChatProviderError) {
        return sendChatError(res, err, 'Failed to generate article case-law digest');
      }
      if (/Article .+ not found/.test(err?.message || '')) {
        return res.status(404).json({ error: err.message, code: 'article_not_found' });
      }
      safeErrorResponse(res, err, 'Failed to generate article case-law digest');
    }
  });

  app.get('/api/laws/:celex/case-law-digest', rateLimitMiddleware, generationOriginMiddleware, generationLimitMiddleware, async (req, res) => {
    try {
      const { celex } = req.params;
      const rawLang = req.query.lang || 'ENG';

      if (!validateCelex(celex)) {
        return res.status(400).json({ error: 'Invalid CELEX format' });
      }
      const lang = validateLang(rawLang);
      if (!lang) {
        return res.status(400).json({ error: `Invalid language code: ${rawLang}` });
      }

      const apiKey = getStaticSummaryApiKey();
      if (!apiKey) {
        return res.status(503).json({ error: 'OpenRouter API key is not configured', code: 'openrouter_unconfigured' });
      }

      const parsed = await resolveParsedLaw(celex, lang, { skipFmxProbe: req.query.skipFmxProbe === '1' });
      const caseLawPayload = await fetchCaseLawMemo(celex);
      const result = await ensureCaseLawDigest({
        celex,
        lang,
        parsedLaw: parsed,
        caseLawPayload,
        cacheDir: FMX_DIR,
        apiKey,
        model: DEFAULT_CASE_LAW_DIGEST_MODEL,
      });

      // Only a real generation costs money; a cache hit must not consume
      // the caller's generation budget.
      if (!result.cached) req.chargeGeneration?.();

      res.json({
        celex,
        lang,
        model: result.model,
        cached: result.cached,
        generatedAt: result.generatedAt,
        caseLawCacheVersion: result.caseLawCacheVersion,
        digest: result.digest,
      });
    } catch (err) {
      if (err instanceof ChatProviderError) {
        return sendChatError(res, err, 'Failed to generate case-law digest');
      }
      safeErrorResponse(res, err, 'Failed to generate case-law digest');
    }
  });

  app.get('/api/search', rateLimitMiddleware, createSearchHandler(legalCacheStore));

  app.get('/api/definitions/search', rateLimitMiddleware, createDefinitionSearchHandler(legalCacheStore));

  app.get('/api/definitions/compare', rateLimitMiddleware, createDefinitionCompareHandler(legalCacheStore));

  app.get('/api/topics', rateLimitMiddleware, createTopicsHandler(legalCacheStore));

  app.get('/api/resolve-reference', rateLimitMiddleware, async (req, res) => {
    try {
      const rawLang = req.query.lang || 'ENG';
      const lang = validateLang(rawLang);
      if (!lang) {
        return res.status(400).json({ error: `Invalid language code: ${rawLang}` });
      }

      let reference = null;
      if (req.query.actType || req.query.year || req.query.number || req.query.ojColl || req.query.ojNo || req.query.ojYear || req.query.raw) {
        reference = parseStructuredReference(req.query);
      } else if (req.query.text) {
        reference = parseReferenceText(String(req.query.text).trim());
      } else {
        return res.status(400).json({
          error: 'Provide FMX-style structured parameters like actType/year/number, optionally with ojColl/ojNo/ojYear',
        });
      }

      if (!reference.year || !reference.number) {
        return res.status(400).json({
          error: 'Could not parse a structured FMX legal reference',
          code: 'invalid_reference',
          parsed: reference,
        });
      }

      const resolution = await resolveReference(reference, lang);
      const payload = {
        query: reference.raw || null,
        parsed: reference,
        resolved: resolution.resolved,
        tried: resolution.tried,
        fallback: resolution.fallback,
      };
      res.status(resolution.resolved ? 200 : 404).json(payload);
    } catch (err) {
      safeErrorResponse(res, err, 'Failed to resolve legal reference');
    }
  });

  app.get('/api/resolve-url', rateLimitMiddleware, async (req, res) => {
    try {
      const rawLang = req.query.lang || 'ENG';
      const lang = validateLang(rawLang);
      if (!lang) {
        return res.status(400).json({ error: `Invalid language code: ${rawLang}` });
      }

      const sourceUrl = String(req.query.url || '').trim();
      if (!sourceUrl) {
        return res.status(400).json({ error: 'Query parameter "url" required' });
      }

      const payload = await resolveEurlexUrl(sourceUrl, lang);
      res.status(payload.resolved ? 200 : 404).json(payload);
    } catch (err) {
      safeErrorResponse(res, err, 'Failed to resolve EUR-Lex URL');
    }
  });

  app.get('/', (req, res) => {
    res.json({
      name: 'EUR-Lex FMX API',
      version: '2.0.0',
      endpoints: {
        'GET /': 'This documentation',
        'GET /health': 'Health check',
        'GET /api/laws': 'List cached FMX files',
        'GET /api/laws/:celex?lang=ENG': 'Get raw FMX XML by CELEX (fetches & caches)',
        'GET /api/laws/:celex/parsed?lang=ENG': 'Get parsed law as structured JSON (articles, recitals, definitions, annexes, cross-references)',
        'GET /api/laws/:celex/info': 'Get metadata only',
        'GET /api/laws/by-reference?actType=directive&year=2018&number=1972&lang=ENG': 'Resolve an official reference and fetch the matching FMX',
        'GET /api/laws/:celex/case-law': 'List CJEU judgments that interpret this law',
        'GET /api/laws/:celex/cited-by?citingLaws=10': 'Get reverse-citation counts and top citing laws for an act',
        'GET /api/laws/:celex/articles/:n/cited-by?limit=50&offset=0': 'List provisions and judgments citing an article',
        'GET /api/laws/:celex/recital-titles?lang=ENG': 'Get cached AI-generated short titles for recitals',
        'GET /api/laws/:celex/summary': 'Get cached static summary of what this law does (English only)',
        'GET /api/laws/:celex/case-law-digest?lang=ENG': 'Get cached static digest of CJEU case law interpreting this law as a whole',
        'GET /api/laws/:celex/articles/:n/case-law-digest?lang=ENG': 'Get cached static digest of CJEU case law interpreting one article',
        'GET /api/search?q=keyword&limit=10': 'Search cached primary-law metadata',
        'GET /api/definitions/search?q=term&limit=10': 'Search definitions extracted from EU laws',
        'GET /api/definitions/compare?term=energy%20poverty': 'Compare how EU laws define a term',
        'GET /api/resolve-reference?actType=directive&year=2018&number=1972&lang=ENG': 'Resolve an FMX-derived legal reference to CELEX via cache-first lookup with Cellar fallback',
        'GET /api/resolve-url?url=https://eur-lex.europa.eu/...&lang=ENG': 'Resolve a full EUR-Lex URL to a canonical CELEX',
        'POST /mcp': 'Model Context Protocol endpoint (stateless Streamable HTTP). Tools include search_eu_law, resolve, get_law_part, get_citing_provisions, get_case_law, and get_law_relations. Add to an AI client, e.g. `claude mcp add --transport http eurlex <base-url>/mcp`'
      },
      celexExamples: {
        '32016R0679': 'GDPR',
        '32024R1689': 'AI Act',
        '32022R1925': 'DMA',
        '32022R2065': 'DSA',
        '32022R0868': 'DGA',
        '32023R2854': 'Data Act'
      }
    });
  });
}

module.exports = {
  registerApiRoutes
};
