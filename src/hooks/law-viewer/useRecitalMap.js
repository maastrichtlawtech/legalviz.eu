import { useEffect, useState } from "react";
import { mapRecitalsToArticles, NLP_VERSION } from "../../utils/nlp.js";

function withOrphanRecitals(map) {
  map.orphanRecitalNumbers = map.get(null) || [];
  return map;
}

export function useRecitalMap({ data, currentLaw }) {
  const [recitalMap, setRecitalMap] = useState(() => withOrphanRecitals(new Map()));

  useEffect(() => {
    if (data.articles?.length > 0 && data.recitals?.length > 0) {
      try {
        const keysToRemove = [];
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index);
          if (key && (key.startsWith("nlp_map_") || key.startsWith("nlp_v"))) {
            if (key.startsWith("nlp_map_") || !key.startsWith(`nlp_v${NLP_VERSION}_`)) {
              keysToRemove.push(key);
            }
          }
        }
        keysToRemove.forEach((key) => localStorage.removeItem(key));
      } catch (error) {
        console.warn("Error cleaning up old NLP cache", error);
      }

      // The map is keyed on article/recital numbers, which are identical across
      // every language version of a law, so the relationship is language-invariant.
      // Cache it once per law (no language in the key) and reuse it for every
      // language instead of recomputing the same mapping per translation.
      let cacheKey = null;
      if (currentLaw?.slug) {
        cacheKey = `nlp_v${NLP_VERSION}_${currentLaw.slug}`;
      }

      if (cacheKey) {
        try {
          const cached = localStorage.getItem(cacheKey);
          if (cached) {
            setRecitalMap(withOrphanRecitals(new Map(JSON.parse(cached))));
            return;
          }
        } catch (error) {
          console.warn("Error reading NLP cache", error);
        }
      }

      const timer = setTimeout(() => {
        const map = mapRecitalsToArticles(data.recitals, data.articles, data.langCode);
        setRecitalMap(withOrphanRecitals(map));

        if (!cacheKey) return;

        // Because the cache key is language-invariant, a degenerate map (e.g.
        // computed from a language the tokenizer failed on) would be served for
        // EVERY language of this law. If a law with a meaningful number of
        // recitals and articles produced a map where (almost) everything is
        // orphaned, skip the cache write so a later visit can recompute.
        const orphanCount = (map.get(null) || []).length;
        const looksDegenerate =
          data.recitals.length >= 5 &&
          data.articles.length >= 3 &&
          orphanCount >= data.recitals.length * 0.95;
        if (looksDegenerate) return;

        try {
          localStorage.setItem(cacheKey, JSON.stringify(Array.from(map.entries())));
        } catch (error) {
          console.warn("Error writing NLP cache", error);
        }
      }, 100);

      return () => clearTimeout(timer);
    }

    setRecitalMap(withOrphanRecitals(new Map()));
    return undefined;
  }, [currentLaw, data.articles, data.recitals, data.langCode]);

  return recitalMap;
}
