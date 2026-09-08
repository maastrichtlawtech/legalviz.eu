const { validateFulltextQuery } = require("./legal-cache-store");
const {
  FULLTEXT_INDEX_UNAVAILABLE,
  FULLTEXT_INDEX_UNAVAILABLE_MESSAGE,
  isFulltextIndexUnavailable,
  isFulltextQueryError,
} = require("./fulltext-errors");

const FULLTEXT_COLLECTION_MAX_CELEXES = 200;

function includesCounts(value) {
  return value === true || value === 1 || value === "true" || value === "1";
}

function addCountMetadata(payload, results, metadata, { includeMatchCountsByCelex }) {
  const matchCountsByCelex = metadata.matchCountsByCelex || {};
  const countedResults = results.map((result) => ({
    ...result,
    matchCount: matchCountsByCelex[result.celex] || 0,
  }));
  return {
    ...payload,
    totalMatchingPassages: metadata.totalMatchingPassages || 0,
    totalMatchingActs: metadata.totalMatchingActs || 0,
    ...(includeMatchCountsByCelex ? { matchCountsByCelex } : {}),
    results: countedResults,
  };
}

function fulltextCelexesRequiredError() {
  return {
    error: 'Request body property "celexes" must be a non-empty array',
    code: "fulltext_celexes_required",
  };
}

function normalizeCollectionCelexes(value, validateCelex) {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: fulltextCelexesRequiredError() };
  }
  if (value.length > FULLTEXT_COLLECTION_MAX_CELEXES) {
    return {
      error: {
        error: `Request body property "celexes" may contain at most ${FULLTEXT_COLLECTION_MAX_CELEXES} CELEX values`,
        code: "fulltext_celexes_too_many",
      },
    };
  }

  const normalized = [];
  const seen = new Set();
  for (const valueItem of value) {
    if (typeof valueItem !== "string") {
      return { error: { error: "Invalid CELEX format", code: "invalid_celex" } };
    }
    const celex = valueItem.trim().toUpperCase();
    if (!celex || (typeof validateCelex === "function" && !validateCelex(celex))) {
      return { error: { error: "Invalid CELEX format", code: "invalid_celex" } };
    }
    if (!seen.has(celex)) {
      seen.add(celex);
      normalized.push(celex);
    }
  }
  return { celexes: normalized };
}

function createFulltextSearchHandler(store, { validateCelex, collection = false } = {}) {
  return function fulltextSearchHandler(req, res) {
    try {
      const isCollectionSearch = collection || req.method === "POST";
      const input = isCollectionSearch ? (req.body || {}) : (req.query || {});
      const query = String(input.q || "").trim();
      if (!query) {
        return res.status(400).json({
          error: 'Query parameter "q" required',
          code: "fulltext_query_required",
        });
      }
      const queryError = validateFulltextQuery(query);
      if (queryError) {
        return res.status(400).json({ error: queryError.message, code: queryError.code });
      }

      if (isCollectionSearch) {
        const normalized = normalizeCollectionCelexes(input.celexes, validateCelex);
        if (normalized.error) return res.status(400).json(normalized.error);

        const results = store.searchFulltextUnits(query, {
          limit: input.limit,
          celexes: normalized.celexes,
        });
        const payload = {
          query,
          celexes: normalized.celexes,
          count: results.length,
          results,
        };
        if (!includesCounts(input.includeCounts)) return res.json(payload);
        const metadata = store.getFulltextMatchCounts(query, { celexes: normalized.celexes });
        return res.json(addCountMetadata(payload, results, metadata, { includeMatchCountsByCelex: true }));
      }

      let celex = null;
      if (input.celex !== undefined && input.celex !== null && String(input.celex).trim()) {
        celex = String(input.celex).trim().toUpperCase();
        if (typeof validateCelex === "function" && !validateCelex(celex)) {
          return res.status(400).json({ error: "Invalid CELEX format", code: "invalid_celex" });
        }
      }

      const results = store.searchFulltextUnits(query, {
        limit: input.limit,
        celex,
      });
      const payload = { query, celex, count: results.length, results };
      if (!includesCounts(input.includeCounts)) return res.json(payload);
      const metadata = store.getFulltextMatchCounts(query, { celex });
      return res.json(addCountMetadata(payload, results, metadata, {
        includeMatchCountsByCelex: Boolean(celex),
      }));
    } catch (error) {
      if (isFulltextIndexUnavailable(error)) {
        return res.status(503).json({
          error: FULLTEXT_INDEX_UNAVAILABLE_MESSAGE,
          code: FULLTEXT_INDEX_UNAVAILABLE,
          details: typeof store.getFulltextStatus === "function"
            ? store.getFulltextStatus()
            : undefined,
        });
      }
      if (isFulltextQueryError(error)) {
        return res.status(400).json({ error: error.message, code: error.code });
      }
      console.error("[FulltextSearch] Failed to search law text:", error.message);
      return res.status(500).json({ error: "Full-text search failed" });
    }
  };
}

module.exports = { createFulltextSearchHandler };
