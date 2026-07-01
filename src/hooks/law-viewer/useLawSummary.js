import { useCallback, useEffect, useState } from "react";
import { fetchLawSummary } from "../../utils/formexApi.js";

export function useLawSummary(celex, { lang = "EN", enabled = true } = {}) {
  const [summary, setSummary] = useState(null);
  const [metadata, setMetadata] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setSummary(null);
    setMetadata(null);
    setLoaded(false);
    setLoading(false);
    setError(null);
  }, [celex, lang]);

  useEffect(() => {
    if (!celex || !enabled || loaded) return;
    let cancelled = false;

    setLoading(true);
    fetchLawSummary(celex, lang)
      .then((payload) => {
        if (cancelled) return;
        setSummary(payload.summary || null);
        setMetadata({
          model: payload.model || null,
          cached: Boolean(payload.cached),
          generatedAt: payload.generatedAt || null,
        });
        setLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setSummary(null);
        setMetadata(null);
        setLoaded(true);
        setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [celex, lang, enabled, loaded]);

  const retry = useCallback(() => {
    setError(null);
    setLoaded(false);
  }, []);

  return { summary, metadata, loading, loaded, error, retry };
}
