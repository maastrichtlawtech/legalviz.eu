import { useCallback, useEffect, useState } from "react";
import { fetchDefinitionComparison } from "../../utils/formexApi.js";

export function useDefinitionComparison(term, t) {
  const [comparison, setComparison] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reloadVersion, setReloadVersion] = useState(0);

  useEffect(() => {
    const normalizedTerm = String(term || "").trim();
    if (!normalizedTerm) {
      setComparison(null);
      setLoading(false);
      setError("");
      return undefined;
    }

    const controller = new AbortController();
    setLoading(true);
    setError("");

    fetchDefinitionComparison(normalizedTerm, { signal: controller.signal })
      .then((payload) => setComparison(payload))
      .catch((requestError) => {
        if (requestError?.name === "AbortError") return;
        setComparison(null);
        setError(requestError?.message || t("definitionComparison.loadError"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [reloadVersion, t, term]);

  const retry = useCallback(() => setReloadVersion((version) => version + 1), []);

  return { comparison, loading, error, retry };
}

