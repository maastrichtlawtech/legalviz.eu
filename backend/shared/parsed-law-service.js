const fs = require('fs');

const { ClientError, cacheGet, cacheSet } = require('./api-utils');
const { parseFmxXml } = require('./fmx-parser-node');
const { selectConsolidatedVersions } = require('./consolidated-versions.mjs');

const PARSED_LAW_CACHE_MS = 10 * 60 * 1000; // 10 minutes

// Each entry holds a full parsed law (including rendered article/annex HTML),
// so cap the in-memory cache well below the generic DEFAULT_CACHE_MAX_ENTRIES
// (10,000) to keep the memory ceiling reasonable.
const MAX_PARSED_CACHE_ENTRIES = 200;

/**
 * Builds a resolver that turns a CELEX + language into the parsed "combined"
 * law structure ({ title, articles, recitals, annexes, definitions,
 * langCode, crossReferences }), trying the cached FMX file first and falling
 * back to on-demand EUR-Lex HTML parsing.
 *
 * Extracted from routes/api-routes.js so both the REST routes and the MCP
 * server can share one implementation (and one in-memory parse cache). An MCP
 * session that fetches a law's structure and then several of its articles only
 * parses the document once.
 */
function createParsedLawResolver({
  prepareLawPayload,
  fetchAndParseHtmlLaw,
  CELEX_NAMES = {},
  fetchConsolidatedVersions,
  runSparqlQuery,
}) {
  const parsedCache = new Map(); // `${celex}:${lang}:${skipFmxProbe}` -> parsed law

  async function resolveParsedLaw(celex, lang, { skipFmxProbe = false } = {}) {
    const cacheKey = `${celex}:${lang}:${skipFmxProbe ? 1 : 0}`;
    const cached = cacheGet(parsedCache, cacheKey);
    if (cached) return cached;

    let parsed = null;
    let source = 'fmx';

    if (!skipFmxProbe) {
      try {
        const { servePath } = await prepareLawPayload(celex, lang);
        const xmlText = fs.readFileSync(servePath, 'utf8');
        parsed = await parseFmxXml(xmlText);
      } catch (err) {
        if (!(err instanceof ClientError) || err.statusCode !== 404 || typeof fetchAndParseHtmlLaw !== 'function') {
          throw err;
        }
        parsed = await fetchAndParseHtmlLaw(celex, lang);
        source = parsed.source || 'eurlex-html';
      }
    } else if (typeof fetchAndParseHtmlLaw === 'function') {
      parsed = await fetchAndParseHtmlLaw(celex, lang);
      source = parsed.source || 'eurlex-html';
    } else {
      const { servePath } = await prepareLawPayload(celex, lang);
      const xmlText = fs.readFileSync(servePath, 'utf8');
      parsed = await parseFmxXml(xmlText);
    }

    let consolidatedVersion = null;
    if (!hasParsedLawContent(parsed)) {
      // The act as adopted parsed to nothing renderable (e.g. REACH, whose
      // original-act Formex carries no article bodies). EUR-Lex may still
      // publish a consolidated ("as amended") version with real content —
      // try that before giving up and serving the empty result. This runs
      // regardless of skipFmxProbe: that flag means "don't probe this act's
      // own FMX again", which says nothing about a different, consolidated
      // document. Any failure here (Cellar outage, SPARQL outage, no
      // consolidated versions at all) is swallowed back to the empty
      // as-adopted result — a fallback must never turn a rendering law into
      // an error.
      try {
        if (typeof fetchConsolidatedVersions === 'function' && typeof runSparqlQuery === 'function') {
          const { versions } = await fetchConsolidatedVersions(celex, runSparqlQuery);
          const { current } = selectConsolidatedVersions(versions);
          if (current) {
            const { servePath } = await prepareLawPayload(current.celex, lang);
            const xmlText = fs.readFileSync(servePath, 'utf8');
            const consolidatedParsed = await parseFmxXml(xmlText);
            if (hasParsedLawContent(consolidatedParsed)) {
              parsed = consolidatedParsed;
              source = 'fmx-consolidated';
              consolidatedVersion = { celex: current.celex, date: current.date };
            }
          }
        }
      } catch {
        // Swallow: keep the empty as-adopted result rather than error out.
      }
    }

    const result = {
      celex,
      lang,
      name: CELEX_NAMES[celex] || null,
      format: 'combined-v1',
      source,
      ...parsed,
    };
    result.hasContent = hasParsedLawContent(parsed);
    if (consolidatedVersion) result.consolidatedVersion = consolidatedVersion;

    cacheSet(parsedCache, cacheKey, result, PARSED_LAW_CACHE_MS, MAX_PARSED_CACHE_ENTRIES);
    return result;
  }

  return resolveParsedLaw;
}

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

module.exports = {
  createParsedLawResolver,
  hasParsedLawContent,
  PARSED_LAW_CACHE_MS,
};
