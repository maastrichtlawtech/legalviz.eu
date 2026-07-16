function unavailable(res, store) {
  return res.status(503).json({
    error: "Definition index is not available",
    code: "definition_index_unavailable",
    details: store.getDefinitionsStatus(),
  });
}

function createDefinitionSearchHandler(store) {
  return function definitionSearchHandler(req, res) {
    try {
      const query = String(req.query.q || "").trim();
      if (!query) return res.status(400).json({ error: 'Query parameter "q" required' });
      const results = store.searchDefinitions(query, { limit: req.query.limit });
      return res.json({ query, count: results.length, results });
    } catch (error) {
      if (error.code === "definition_index_unavailable") return unavailable(res, store);
      console.error("[Definitions] Failed to search definitions:", error.message);
      return res.status(500).json({ error: "Definition search failed" });
    }
  };
}

function createDefinitionCompareHandler(store) {
  return function definitionCompareHandler(req, res) {
    try {
      const term = String(req.query.term || "").trim();
      if (!term) return res.status(400).json({ error: 'Query parameter "term" required' });
      return res.json(store.compareDefinitions(term));
    } catch (error) {
      if (error.code === "definition_index_unavailable") return unavailable(res, store);
      console.error("[Definitions] Failed to compare definitions:", error.message);
      return res.status(500).json({ error: "Definition comparison failed" });
    }
  };
}

module.exports = { createDefinitionCompareHandler, createDefinitionSearchHandler };
