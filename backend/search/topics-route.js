// Bulk CELEX → EuroVoc topics lookup. The search endpoint already surfaces
// topics on live results, but the landing library needs to backfill topics for
// laws a client opened before that shipped, keyed by the CELEX ids it already
// holds. This reuses the same eurovoc data attached to each search record.
const MAX_CELEX_PER_REQUEST = 200;
const MAX_TOPICS_PER_LAW = 5;

function parseCelexList(raw) {
  const seen = new Set();
  const celexes = [];
  for (const value of String(raw || "").split(",")) {
    const celex = value.trim().toUpperCase();
    if (!celex || seen.has(celex)) continue;
    seen.add(celex);
    celexes.push(celex);
  }
  return celexes;
}

function createTopicsHandler(legalCacheStore) {
  return function topicsHandler(req, res) {
    try {
      const celexes = parseCelexList(req.query.celex);
      if (celexes.length === 0) {
        return res.status(400).json({
          error: 'Query parameter "celex" required (comma-separated CELEX ids)',
        });
      }
      if (celexes.length > MAX_CELEX_PER_REQUEST) {
        return res.status(400).json({
          error: `Too many CELEX ids requested (max ${MAX_CELEX_PER_REQUEST})`,
        });
      }

      if (!legalCacheStore.isReady()) {
        return res.status(503).json({
          error: "Law search cache is not available",
          code: "search_cache_unavailable",
          details: legalCacheStore.getStatus(),
        });
      }

      const topics = {};
      for (const celex of celexes) {
        const record = legalCacheStore.getByCelex(celex);
        const labels = record && Array.isArray(record.eurovoc) ? record.eurovoc : [];
        if (labels.length > 0) {
          topics[celex] = labels.slice(0, MAX_TOPICS_PER_LAW);
        }
      }

      res.json({ topics });
    } catch (error) {
      console.error("[Topics] Failed to look up topics:", error.message);
      res.status(500).json({ error: "Topic lookup failed" });
    }
  };
}

module.exports = {
  createTopicsHandler,
};
