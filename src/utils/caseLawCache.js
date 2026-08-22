import { fetchCaseLaw } from "./formexApi.js";

// Shared module-level cache so the sidebar button and the per-article
// panel trigger a single network request per celex.
const cache = new Map(); // celex -> Promise<{cases: [...]}>

export function loadCaseLaw(celex) {
  if (!celex) return Promise.resolve({ cases: [] });
  if (!cache.has(celex)) {
    cache.set(
      celex,
      fetchCaseLaw(celex)
        .then((r) => ({ cases: r?.cases || [] }))
        .catch((err) => {
          cache.delete(celex); // let future calls retry
          throw err;
        })
    );
  }
  return cache.get(celex);
}
