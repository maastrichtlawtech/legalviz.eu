const { z } = require('zod');
const { JSDOM } = require('jsdom');

const { ClientError, validateLang } = require('../shared/api-utils');
const { validateCelex, parseReferenceText } = require('../shared/reference-utils');
const { fetchCaseLaw, fetchAmendments, fetchImplementing } = require('../shared/law-queries');
const { ensureRecitalTitles, getCachedRecitalTitles } = require('../shared/recital-title-service');

const DEFAULT_RECITAL_TITLE_MODEL =
  process.env.RECITAL_TITLE_MODEL
  || process.env.ARTICLE_QA_PLANNER_MODEL
  || process.env.ARTICLE_QA_MODEL
  || 'google/gemini-2.5-pro';

function getRecitalTitleApiKey() {
  return process.env.RECITAL_TITLE_OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY;
}

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

/** Wrap a tool handler so any error becomes a model-readable isError result. */
function makeHandler(fn) {
  return async (args) => {
    try {
      return await fn(args || {});
    } catch (err) {
      const message = err instanceof ClientError
        ? err.message
        : (err?.message || 'Unexpected error handling the request');
      return { isError: true, content: [{ type: 'text', text: message }] };
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
        'Search cached EU primary legislation by keyword, title, CELEX id, or citation. Use this FIRST to find the CELEX identifier of a law before reading it with get_law_part. Returns a ranked list of matches, each with its CELEX id and title.',
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
        'Read a slice of a law by CELEX id. Call with part="structure" FIRST to get the table of contents (chapters, article numbers + titles, recital list, annex ids, definition terms), then request individual pieces. Never returns the whole law at once. Parts: "structure" (the map), "article" (one article, requires number), "recital" (one recital, requires number), "annex" (one annex, requires the annex id in number), "definitions" (all defined terms, optional number filters by substring). NOTE: the first fetch of a law that is not yet cached can take up to ~30 seconds while it is downloaded from EUR-Lex; subsequent calls are fast.',
      inputSchema: {
        celex: z.string().describe('CELEX id, e.g. 32016R0679'),
        part: z.enum(['structure', 'article', 'recital', 'annex', 'definitions'])
          .describe('Which slice to return'),
        number: z.string().optional()
          .describe('Article/recital number or annex id (required for article/recital/annex); optional substring filter for definitions'),
        lang: z.string().optional().describe('3-letter language code (default ENG)'),
      },
    },
    makeHandler(async ({ celex, part, number, lang }) => {
      requireCelex(celex);
      const language = requireLang(lang);
      record('get_law_part', { celex });

      const law = await resolveParsedLaw(celex, language, {});
      const base = { celex, lang: language, title: law.title, langCode: law.langCode, source: law.source };

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
        let title = null;
        const cached = getCachedRecitalTitles({
          celex, lang: language, recitals: law.recitals || [], cacheDir: FMX_DIR,
        });
        title = cached.titles[String(rec.recital_number)] || null;

        const apiKey = getRecitalTitleApiKey();
        if (!title && apiKey) {
          try {
            const result = await ensureRecitalTitles({
              celex, lang: language, recitals: law.recitals || [],
              cacheDir: FMX_DIR, apiKey, model: DEFAULT_RECITAL_TITLE_MODEL,
            });
            title = result.titles[String(rec.recital_number)] || null;
          } catch {
            // Soft-fail: the recital text is still returned without a generated title.
          }
        }

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
      const payload = await fetchCaseLaw(celex, runSparqlQuery, { cacheDir: FMX_DIR });
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
