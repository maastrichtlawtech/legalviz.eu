import { useEffect, useMemo, useState } from "react";

import { fetchAmendments, fetchConsolidatedVersions } from "../utils/formexApi.js";
import { selectConsolidatedVersions, summarizeAmendments } from "../utils/consolidatedVersions.js";

/**
 * Whether the act being read is still the current text, and where to find the
 * current one if it isn't.
 *
 * Both requests are best-effort and resolve to an absent value on failure: a
 * Cellar outage must not put a "this may be outdated" warning on a law we know
 * nothing about, so `isOutdated` stays false until the amendment history says
 * otherwise. Both endpoints are already IndexedDB-cached and de-duplicated in
 * flight, so sharing them with the metadata panel costs nothing.
 */
export function useConsolidationStatus(celex) {
  const [amendments, setAmendments] = useState(null);
  const [versions, setVersions] = useState(null);

  useEffect(() => {
    setAmendments(null);
    setVersions(null);
    if (!celex) return undefined;

    let cancelled = false;

    fetchAmendments(celex)
      .then((result) => { if (!cancelled) setAmendments(result.amendments || []); })
      .catch(() => { if (!cancelled) setAmendments([]); });

    fetchConsolidatedVersions(celex)
      .then((result) => { if (!cancelled) setVersions(result.versions || []); })
      .catch(() => { if (!cancelled) setVersions([]); });

    return () => { cancelled = true; };
  }, [celex]);

  return useMemo(() => {
    const { count, latestDate } = summarizeAmendments(amendments);
    const { current, upcoming } = selectConsolidatedVersions(versions);

    return {
      isOutdated: count > 0,
      amendmentCount: count,
      latestAmendmentDate: latestDate,
      consolidated: current,
      hasUpcomingConsolidation: upcoming.length > 0,
    };
  }, [amendments, versions]);
}
