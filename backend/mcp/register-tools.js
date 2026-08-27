const { z } = require('zod');
const { JSDOM } = require('jsdom');

const { ClientError, requireCitationGraph, validateLang } = require('../shared/api-utils');
const { validateCelex, parseReferenceText } = require('../shared/reference-utils');
const { fetchCaseLaw, fetchAmendments, fetchImplementing } = require('../shared/law-queries');
const { getCachedRecitalTitles } = require('../shared/recital-title-service');
const { validateFulltextQuery } = require('../search/legal-cache-store');
const {
  FULLTEXT_INDEX_UNAVAILABLE,
  FULLTEXT_INDEX_UNAVAILABLE_MESSAGE,
  isFulltextIndexUnavailable,
} = require('../search/fulltext-errors');

const BLOCK_TAGS = new Set([
  'P', 'DIV', 'LI', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'SECTION', 'ARTICLE', 'UL', 'OL', 'TABLE', 'THEAD', 'TBODY',
]);

/**
 * Convert the parser's rendered HTML (article_html / annex_html / recital_html)
 * into readable plain text with block-level line breaks. Models consume text,
 * not markup, and the raw HTML carries footnote/cross-ref anchors that only
 * add noise.
 */
function htmlToText(html) {
  if (!html || typeof html !== 'string') return '';
  const dom = new JSDOM(`<!DOCTYPE html><body>${html}</body>`);
  const { document, Node } = dom.window;
  let out = '';

  function walk(node) {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.textContent;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName;
        if (tag === 'BR') {
          out += '\n';
          continue;
        }
        const isBlock = BLOCK_TAGS.has(tag);
        if (isBlock) out += '\n';
        walk(child);
        if (isBlock) out += '\n';
      }
    }
  }

  walk(document.body);
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function normalizeNum(value) {
  return String(value ?? '')
    .trim()
    .replace(/^(article|recital|annex)\s+/i, '')
    .replace(/^0+(?=\d)/, '');
}

function requireCelex(celex) {
  if (!validateCelex(celex)) {
    throw new ClientError(
      'Invalid CELEX format. Expected something like 32016R0679 (GDPR). Use search_eu_law or resolve to find a CELEX.',
      400,
      'invalid_celex'
    );
  }
  return celex;
}

function requireLang(lang) {
  const valid = validateLang(lang);
  if (!valid) {
    throw new ClientError(
      `Invalid language code: ${lang}. Use a 3-letter EU code such as ENG, FRA, or DEU.`,
      400,
      'invalid_lang'
    );
  }
  return valid;
}

function jsonResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

/**
 * Wrap a tool handler so any error becomes a model-readable isError result.
 * Mirrors safeErrorResponse (shared/api-utils.js): ClientError messages are
 * safe to surface verbatim, but any other error's message can leak
 * filesystem paths or upstream URLs, so it's logged server-side and replaced
 * with a generic message instead.
 */
function makeHandler(fn) {
  return async (args) => {
    try {
      return await fn(args || {});
    } catch (err) {
      if (err instanceof ClientError) {
        return { isError: true, content: [{ type: 'text', text: err.message }] };
      }
      console.error('[MCP] Unexpected error handling the request:', err.message);
      return { isError: true, content: [{ type: 'text', text: 'Internal server error' }] };
    }
  };
}

function buildStructure(law, recitalTitles) {
  const chapters = [];
  const chapterIndex = new Map();

  for (const art of law.articles || []) {
    const ch = art.division?.chapter || {};
    const key = `${ch.number || ''}|${ch.title || ''}`;
    if (!chapterIndex.has(key)) {
      const entry = {
        chapter_number: ch.number || null,
        chapter_title: ch.title || null,
        articles: [],
      };
      chapterIndex.set(key, entry);
      chapters.push(entry);
    }
    const section = art.division?.section;
    chapterIndex.get(key).articles.push({
      number: art.article_number,
      title: art.article_title || null,
      ...(section ? { section: { number: section.number, title: section.title } } : {}),
      // Only present when reading a version (see `version` on get_law_part):
      // this article has no counterpart in the act as adopted, so case-law
      // and citation lookups keyed to the original text will find nothing
      // for it.
      ...(art.insertedInVersion ? { insertedInVersion: true } : {}),
    });
  }

  const recitals = (law.recitals || []).map((r) => ({
    number: r.recital_number,
    title: recitalTitles[String(r.recital_number)] || null,
  }));

  return {
    counts: {
      articles: (law.articles || []).length,
      recitals: (law.recitals || []).length,
      annexes: (law.annexes || []).length,
      definitions: (law.definitions || []).length,
    },
    chapters,
    recitals,
    annexes: (law.annexes || []).map((a) => ({ id: a.annex_id, title: a.annex_title })),
    definitions: (law.definitions || []).map((d) => d.term),
  };
}

/**
 * Register the EUR-Lex tools on an McpServer instance.
 *
 * deps: { legalCacheStore, resolveReference, resolveEurlexUrl, runSparqlQuery,
 *         resolveParsedLaw, FMX_DIR, analytics }
 */
function registerTools(server, deps) {
  const {
    legalCacheStore,
    resolveReference,
    resolveEurlexUrl,
    runSparqlQuery,
    resolveParsedLaw,
    FMX_DIR,
    analytics,
    citationGraphStore,
  } = deps;

  const record = (tool, meta) => {
    if (analytics && typeof analytics.recordMcpTool === 'function') {
      analytics.recordMcpTool(tool, meta || {});
    }
  };

  server.registerTool(
    'search_eu_law',
    {
      title: 'Search EU law',
      description:
        'Search cached EU primary legislation by keyword, title, CELEX id, or citation. Use this FIRST to find the CELEX identifier of a law before reading it with get_law_part. Returns a ranked list of matches, each with its CELEX id and title. For provision/body-text searches, use search_law_text instead.',
      inputSchema: {
        query: z.string().min(1).describe('Keywords, a law title, a CELEX id, or a citation'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum number of results (default 10)'),
      },
    },
    makeHandler(async ({ query, limit }) => {
      record('search_eu_law', { query });
      let results;
      try {
        results = legalCacheStore.searchLaws(query, { limit });
      } catch (err) {
        if (err?.code === 'search_cache_unavailable') {
          throw new ClientError(
            'The search index is not loaded on the server yet. Please try again shortly.',
            503,
            'search_cache_unavailable'
          );
        }
        throw err;
      }
      return jsonResult({ query, count: results.length, results });
    })
  );

  server.registerTool(
    'search_law_text',
    {
      title: 'Search EU law body text',
      description:
        'Search the body text of EU legislation (articles and recitals) for a term or phrase. Use this when the user’s words come from a provision rather than a law title, for example to find which laws mention a term. Returns matching units with snippets; follow up with get_law_part to read the full provision. Pass celex to search within a single act.',
      inputSchema: {
        query: z.string().trim().min(2).max(200).describe('A term or phrase from the body text of EU legislation'),
        celex: z.string().optional().describe('Optional CELEX id to restrict the search, e.g. 32016R0679'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum number of matching units (default 10)'),
      },
    },
    makeHandler(async ({ query, celex, limit }) => {
      record('search_law_text', { query });

      const queryError = validateFulltextQuery(query);
      if (queryError) {
        throw new ClientError(queryError.message, 400, queryError.code);
      }

      const normalizedCelex = celex === undefined || !String(celex).trim()
        ? undefined
        : String(celex).trim().toUpperCase();
      if (normalizedCelex !== undefined) requireCelex(normalizedCelex);

      let results;
      try {
        results = legalCacheStore.searchFulltextUnits(query, {
          celex: normalizedCelex,
          limit,
        });
      } catch (err) {
        if (isFulltextIndexUnavailable(err)) {
          throw new ClientError(
            FULLTEXT_INDEX_UNAVAILABLE_MESSAGE,
            503,
            FULLTEXT_INDEX_UNAVAILABLE
          );
        }
        throw err;
      }
      return jsonResult({ query, celex: normalizedCelex || null, count: results.length, results });
    })
  );

  server.registerTool(
    'resolve',
    {
      title: 'Resolve a reference to a CELEX id',
      description:
        'Turn a legal citation ("Directive 2018/1972", "Regulation (EU) 2016/679"), a CELEX id, or an EUR-Lex URL into a canonical CELEX identifier you can pass to the other tools. Use when a user gives you a citation or a eur-lex.europa.eu link rather than a keyword.',
      inputSchema: {
        reference: z.string().min(1).describe('A citation, a CELEX id, or an EUR-Lex URL'),
        lang: z.string().optional().describe('3-letter language code (default ENG)'),
      },
    },
    makeHandler(async ({ reference, lang }) => {
      const language = requireLang(lang);
      const ref = String(reference).trim();
      record('resolve', {});

      if (/^https?:\/\//i.test(ref)) {
        return jsonResult(await resolveEurlexUrl(ref, language));
      }

      if (validateCelex(ref)) {
        const meta = typeof legalCacheStore.getByCelex === 'function'
          ? legalCacheStore.getByCelex(ref)
          : null;
        return jsonResult({
          input: ref,
          resolved: { celex: ref, eli: meta?.eli || null, source: meta ? 'search-cache' : 'input' },
          title: meta?.title || null,
        });
      }

      const parsed = parseReferenceText(ref);
      if (!parsed.year || !parsed.number) {
        throw new ClientError(
          `Could not parse "${reference}" as a legal reference. Provide a citation like "Regulation (EU) 2016/679", a CELEX id, or an EUR-Lex URL.`,
          400,
          'invalid_reference'
        );
      }
      const resolution = await resolveReference(parsed, language);
      return jsonResult({ parsed, ...resolution });
    })
  );

  server.registerTool(
    'get_law_part',
    {
      title: 'Read part of an EU law',
      description:
        'Read a slice of a law by CELEX id. Call with part="structure" FIRST to get the table of contents (chapters, article numbers + titles, recital list, annex ids, definition terms), then request individual pieces. Never returns the whole law at once. By default this is the act AS ADOPTED; pass version="current" to read it as amended. Parts: "structure" (the map), "article" (one article, requires number), "recital" (one recital, requires number), "annex" (one annex, requires the annex id in number), "definitions" (all defined terms, optional number filters by substring). NOTE: the first fetch of a law that is not yet cached can take up to ~30 seconds while it is downloaded from EUR-Lex; subsequent calls are fast.',
      inputSchema: {
        celex: z.string().describe('CELEX id, e.g. 32016R0679'),
        part: z.enum(['structure', 'article', 'recital', 'annex', 'definitions'])
          .describe('Which slice to return'),
        number: z.string().optional()
          .describe('Article/recital number or annex id (required for article/recital/annex); optional substring filter for definitions'),
        lang: z.string().optional().describe('3-letter language code (default ENG)'),
        version: z.literal('current').optional()
          .describe('Pass "current" to read the act as amended (the latest consolidated version) instead of as adopted. The CELEX stays the same — a consolidated text is another version of the act, not a different act. Articles, annexes and definitions then come from the consolidated text while recitals stay as adopted (consolidation does not amend recitals), and articles added by a later amendment are marked insertedInVersion. If no consolidated version can be served, the act as adopted is returned with versionUnavailable: true rather than an error.'),
      },
    },
    makeHandler(async ({ celex, part, number, lang, version }) => {
      requireCelex(celex);
      const language = requireLang(lang);
      record('get_law_part', { celex });

      const law = await resolveParsedLaw(celex, language, version ? { version } : {});
      const base = { celex, lang: language, title: law.title, langCode: law.langCode, source: law.source };
      // Only surface the version fields when a version was asked for, so the
      // as-adopted response shape is byte-for-byte what it was before.
      if (version) {
        base.version = law.version || null;
        base.versionCelex = law.versionCelex || null;
        base.versionDate = law.versionDate || null;
        if (law.versionUnavailable) base.versionUnavailable = true;
        if (law.recitalsSource) base.recitalsSource = law.recitalsSource;
      }

      if (part === 'structure') {
        const cached = getCachedRecitalTitles({
          celex, lang: language, recitals: law.recitals || [], cacheDir: FMX_DIR,
        });
        return jsonResult({ ...base, ...buildStructure(law, cached.titles) });
      }

      if (part === 'definitions') {
        let defs = law.definitions || [];
        if (number) {
          const needle = String(number).toLowerCase();
          defs = defs.filter((d) => String(d.term || '').toLowerCase().includes(needle));
        }
        return jsonResult({ ...base, count: defs.length, definitions: defs });
      }

      if (!number) {
        throw new ClientError(`The "number" argument is required when part is "${part}".`, 400, 'number_required');
      }

      if (part === 'article') {
        const art = (law.articles || []).find((a) => normalizeNum(a.article_number) === normalizeNum(number));
        if (!art) {
          const available = (law.articles || []).map((a) => a.article_number).join(', ');
          throw new ClientError(`Article ${number} not found in ${celex}. Available article numbers: ${available}`, 404, 'article_not_found');
        }
        const section = art.division?.section;
        return jsonResult({
          ...base,
          article_number: art.article_number,
          article_title: art.article_title || null,
          chapter: art.division?.chapter
            ? { number: art.division.chapter.number || null, title: art.division.chapter.title || null }
            : null,
          section: section ? { number: section.number, title: section.title } : null,
          text: htmlToText(art.article_html),
          crossReferences: law.crossReferences?.[String(art.article_number)] || [],
        });
      }

      if (part === 'recital') {
        const rec = (law.recitals || []).find((r) => normalizeNum(r.recital_number) === normalizeNum(number));
        if (!rec) {
          const available = (law.recitals || []).map((r) => r.recital_number).join(', ');
          throw new ClientError(`Recital ${number} not found in ${celex}. Available recital numbers: ${available}`, 404, 'recital_not_found');
        }
        // Cached-only: unlike the REST recital-title route, /mcp carries no
        // generation budget (req.chargeGeneration()) or origin allowlist, so
        // it must never trigger a billed OpenRouter call on a cache miss.
        // A miss here just returns title: null.
        const cached = getCachedRecitalTitles({
          celex, lang: language, recitals: law.recitals || [], cacheDir: FMX_DIR,
        });
        const title = cached.titles[String(rec.recital_number)] || null;

        return jsonResult({
          ...base,
          recital_number: rec.recital_number,
          title,
          text: rec.recital_text || htmlToText(rec.recital_html),
          crossReferences: law.crossReferences?.[`recital_${rec.recital_number}`] || [],
        });
      }

      // part === 'annex'
      const annex = (law.annexes || []).find((a) => normalizeNum(a.annex_id) === normalizeNum(number)
        || String(a.annex_id || '').toLowerCase() === String(number).toLowerCase());
      if (!annex) {
        const available = (law.annexes || []).map((a) => a.annex_id).join(', ');
        throw new ClientError(`Annex ${number} not found in ${celex}. Available annex ids: ${available || '(none)'}`, 404, 'annex_not_found');
      }
      return jsonResult({
        ...base,
        annex_id: annex.annex_id,
        annex_title: annex.annex_title || null,
        text: htmlToText(annex.annex_html),
        crossReferences: law.crossReferences?.[`annex_${annex.annex_id}`] || [],
      });
    })
  );

  server.registerTool(
    'get_citing_provisions',
    {
      title: 'Get provisions citing an EU law article',
      description:
        'Find legislation provisions and CJEU judgments that cite a law or one of its articles. Pass an article number for paginated citation details; omit it for act-level citation counts.',
      inputSchema: {
        celex: z.string().describe('CELEX id of the cited law, e.g. 32016R0679'),
        article: z.string().min(1).optional().describe('Cited article number; omit for act-level counts'),
        limit: z.number().int().min(1).max(200).optional().describe('Maximum detailed results (default 50)'),
        offset: z.number().int().min(0).optional().describe('Number of detailed results to skip (default 0)'),
      },
    },
    makeHandler(async ({ celex, article, limit = 50, offset = 0 }) => {
      requireCelex(celex);
      record('get_citing_provisions', { celex, ...(article ? { article } : {}) });
      const store = requireCitationGraph(citationGraphStore);
      return jsonResult(article
        ? store.getArticleCitations(celex, article, { limit, offset })
        : store.getActCitations(celex));
    })
  );

  server.registerTool(
    'get_case_law',
    {
      title: 'Get CJEU case law for a law',
      description:
        'List Court of Justice of the EU (CJEU) judgments that interpret a given law, by CELEX id. Returns factual case metadata (case number, ECLI, date, name, articles cited) — not an AI summary. Use to answer "which cases interpret this regulation" or to find leading judgments on a law.',
      inputSchema: {
        celex: z.string().describe('CELEX id of the law, e.g. 32016R0679'),
      },
    },
    makeHandler(async ({ celex }) => {
      requireCelex(celex);
      record('get_case_law', { celex });
      const payload = await fetchCaseLaw(celex, runSparqlQuery, { cacheDir: FMX_DIR, dataStore: legalCacheStore });
      return jsonResult(payload);
    })
  );

  server.registerTool(
    'get_law_relations',
    {
      title: 'Get amendments and implementing acts',
      description:
        'Get the legislative graph around a law by CELEX id: its amendments/corrigenda and the acts that implement it. Use to check whether a law is still current or what implements it — questions a model cannot answer from training data.',
      inputSchema: {
        celex: z.string().describe('CELEX id of the law, e.g. 32016R0679'),
      },
    },
    makeHandler(async ({ celex }) => {
      requireCelex(celex);
      record('get_law_relations', { celex });
      const [amendments, implementing] = await Promise.all([
        fetchAmendments(celex, runSparqlQuery),
        fetchImplementing(celex, runSparqlQuery),
      ]);
      return jsonResult({
        celex,
        amendments: amendments.amendments || [],
        implementingActs: implementing.acts || [],
      });
    })
  );
}

module.exports = { registerTools, htmlToText };
