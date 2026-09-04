const { validateFulltextQuery } = require("./legal-cache-store");
const {
  FULLTEXT_INDEX_UNAVAILABLE,
  FULLTEXT_INDEX_UNAVAILABLE_MESSAGE,
  isFulltextIndexUnavailable,
  isFulltextQueryError,
} = require("./fulltext-errors");

const FULLTEXT_COLLECTION_MAX_CELEXES = 200;

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
        return res.json({
          query,
          celexes: normalized.celexes,
          count: results.length,
          results,
        });
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
      return res.json({ query, celex, count: results.length, results });
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
