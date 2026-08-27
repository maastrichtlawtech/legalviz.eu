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
  fetchConsolidatedVersionsMemo,
  runSparqlQuery,
  parseFmxXml: parseFmxXmlImpl = parseFmxXml,
}) {
  const parsedCache = new Map(); // `${celex}:${lang}:${skipFmxProbe}:${version}` -> parsed law

  // Prefer the memo the server shares with the /consolidated route: both paths
  // want the same SPARQL answer for the same CELEX, and without it a cold law
  // view ran the query twice. Falling back to the raw query keeps the resolver
  // usable on its own (the CLI and unit tests inject it without a memo), and
  // leaving both out disables consolidation rather than erroring.
  const loadConsolidatedVersions = fetchConsolidatedVersionsMemo
    || (typeof fetchConsolidatedVersions === 'function' && typeof runSparqlQuery === 'function'
      ? (celex) => fetchConsolidatedVersions(celex, runSparqlQuery)
      : null);

  /**
   * Fetches and parses the current consolidated ("as amended") EUR-Lex
   * version of `celex`, or returns `null` when there isn't one worth
   * serving: no consolidation mechanism wired up, no versions at all, only
   * future-dated ones (`selectConsolidatedVersions` already excludes those —
   * presenting an upcoming text as the one in force would be worse than
   * saying nothing), or a consolidated Formex that itself parses to nothing
   * (Cellar's `manifestation_type` occasionally points at a version whose
   * article bodies are empty). Throws on network/SPARQL/Cellar failure —
   * every call site is responsible for swallowing that back to its own
   * fallback; this helper only decides *whether* a usable consolidated
   * document exists, not what to do when it can't tell.
   */
  async function loadConsolidatedLaw(celex, lang) {
    if (!loadConsolidatedVersions) return null;
    const { versions } = await loadConsolidatedVersions(celex);
    const { current } = selectConsolidatedVersions(versions);
    if (!current) return null;

    const { servePath } = await prepareLawPayload(current.celex, lang);
    const xmlText = await fs.promises.readFile(servePath, 'utf8');
    const consolidatedParsed = await parseFmxXmlImpl(xmlText);
    if (!hasParsedLawContent(consolidatedParsed)) return null;

    return { parsed: consolidatedParsed, version: { celex: current.celex, date: current.date } };
  }

  async function resolveParsedLaw(celex, lang, { skipFmxProbe = false, version = null } = {}) {
    const cacheKey = `${celex}:${lang}:${skipFmxProbe ? 1 : 0}:${version || 'none'}`;
    const cached = cacheGet(parsedCache, cacheKey);
    if (cached) return cached;

    let parsed = null;
    let source = 'fmx';

    if (!skipFmxProbe) {
      try {
        const { servePath } = await prepareLawPayload(celex, lang);
        const xmlText = await fs.promises.readFile(servePath, 'utf8');
        parsed = await parseFmxXmlImpl(xmlText);
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
      const xmlText = await fs.promises.readFile(servePath, 'utf8');
      parsed = await parseFmxXmlImpl(xmlText);
    }

    // Keep a handle on the as-adopted parse before anything below may
    // replace `parsed` — the requested-version path composes against this,
    // and it must be the act's own recitals, never a consolidated one's
    // (EUR-Lex consolidations carry zero recitals to begin with).
    const asAdoptedParsed = parsed;

    // Both the empty-parse fallback and the requested-version path may need
    // the same consolidated document; fetch it at most once per call and
    // remember the outcome (including "nothing usable") for the second
    // consumer.
    let consolidatedAttempted = false;
    let consolidatedResult = null;
    async function getConsolidated() {
      if (consolidatedAttempted) return consolidatedResult;
      consolidatedAttempted = true;
      try {
        consolidatedResult = await loadConsolidatedLaw(celex, lang);
      } catch {
        consolidatedResult = null;
      }
      return consolidatedResult;
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
      const loaded = await getConsolidated();
      if (loaded) {
        parsed = loaded.parsed;
        source = 'fmx-consolidated';
        consolidatedVersion = loaded.version;
      }
    }

    // The requested-version path: unlike the fallback above (which replaces
    // an unrenderable as-adopted act wholesale), this always COMPOSES —
    // consolidated articles/annexes/definitions/crossReferences paired with
    // the as-adopted recitals, because consolidation never amends recitals,
    // and EUR-Lex's consolidated Formex omits the <PREAMBLE.RECITALS> block
    // entirely. Losing recitals would silently break the recital grid, the
    // TF-IDF recital→article map, AI recital titles and the related-recitals
    // rail — the whole reason this feature composes instead of just linking
    // out to the consolidated text (see #144/#170).
    let versionUnavailable = false;
    if (version === 'current') {
      let loaded = null;
      try {
        loaded = await getConsolidated();
      } catch {
        loaded = null;
      }

      if (loaded) {
        const asAdoptedArticles = asAdoptedParsed?.articles || [];
        const hasUsableAsAdoptedArticleBaseline = asAdoptedArticles.length > 0;
        const asAdoptedArticleNumbers = new Set(
          asAdoptedArticles.map((article) => article.article_number),
        );
        const composedArticles = (loaded.parsed.articles || []).map((article) => (
          !hasUsableAsAdoptedArticleBaseline || asAdoptedArticleNumbers.has(article.article_number)
            ? article
            : { ...article, insertedInVersion: true }
        ));
        const composedParsed = {
          ...loaded.parsed,
          articles: composedArticles,
          recitals: asAdoptedParsed?.recitals || [],
        };

        const result = {
          celex,
          lang,
          name: CELEX_NAMES[celex] || null,
          format: 'combined-v1',
          ...composedParsed,
          source: 'fmx-consolidated',
          version: 'current',
          versionCelex: loaded.version.celex,
          versionDate: loaded.version.date,
          recitalsSource: 'as-adopted',
          consolidatedVersion: loaded.version,
        };
        result.hasContent = hasParsedLawContent(composedParsed);

        cacheSet(parsedCache, cacheKey, result, PARSED_LAW_CACHE_MS, MAX_PARSED_CACHE_ENTRIES);
        return result;
      }

      // No consolidated version at all, only future-dated ones, an
      // unresolvable version (Cellar 406s roughly 1 in 15 listed versions),
      // or a Cellar/SPARQL outage — a requested version must never turn a
      // rendering law into an error. Fall through and serve the normal
      // as-adopted payload, flagged so the frontend can say so honestly
      // instead of a toggle that silently did nothing.
      versionUnavailable = true;
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
    if (versionUnavailable) result.versionUnavailable = true;

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
