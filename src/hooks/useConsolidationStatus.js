import { useEffect, useMemo, useState } from "react";

import { fetchAmendments, fetchConsolidatedVersions } from "../utils/formexApi.js";
import { selectConsolidatedVersions, summarizeAmendments } from "../utils/consolidatedVersions.js";

/**
 * Whether the act being read is still the current text, and where to find the
 * current one if it isn't.
 *
 * Both requests are best-effort: a Cellar outage must not put a "this may be
 * outdated" warning on a law we know nothing about, so `isOutdated` stays
 * false until the amendment history says otherwise. But a failed
 * `/consolidated` fetch is kept distinct from a genuine empty result — the
 * consolidated-version query is the slower of the two, so it is the one most
 * likely to time out, and reporting "no consolidated version exists" when we
 * simply don't know would be a falsehood. `consolidatedStatusUnknown` carries
 * that distinction to the caller instead of silently collapsing to `[]`.
 * Both endpoints are already IndexedDB-cached and de-duplicated in flight, so
 * sharing them with the metadata panel costs nothing.
 */
export function useConsolidationStatus(celex) {
  const [amendments, setAmendments] = useState(null);
  const [amendmentsTruncated, setAmendmentsTruncated] = useState(false);
  const [versions, setVersions] = useState(null);
  const [consolidatedStatusUnknown, setConsolidatedStatusUnknown] = useState(false);

  useEffect(() => {
    setAmendments(null);
    setAmendmentsTruncated(false);
    setVersions(null);
    setConsolidatedStatusUnknown(false);
    if (!celex) return undefined;

    let cancelled = false;

    fetchAmendments(celex)
      .then((result) => {
        if (cancelled) return;
        setAmendments(result.amendments || []);
        setAmendmentsTruncated(Boolean(result.truncated));
      })
      .catch(() => { if (!cancelled) setAmendments([]); });

    fetchConsolidatedVersions(celex)
      .then((result) => { if (!cancelled) setVersions(result.versions || []); })
      .catch(() => {
        if (cancelled) return;
        // Unlike the amendments failure above, this must not be treated as
        // "no consolidated version" — render `[]` for `selectConsolidatedVersions`
        // to work with, but flag it so the caller can tell the two apart.
        setVersions([]);
        setConsolidatedStatusUnknown(true);
      });

    return () => { cancelled = true; };
  }, [celex]);

  return useMemo(() => {
    const { count, latestDate } = summarizeAmendments(amendments);
    const { current, upcoming } = selectConsolidatedVersions(versions);

    return {
      isOutdated: count > 0,
      amendmentCount: count,
      amendmentCountExact: !amendmentsTruncated,
      latestAmendmentDate: latestDate,
      consolidated: current,
      hasUpcomingConsolidation: upcoming.length > 0,
      consolidatedStatusUnknown,
    };
  }, [amendments, amendmentsTruncated, versions, consolidatedStatusUnknown]);
}
