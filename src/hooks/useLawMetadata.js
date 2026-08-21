import { useState, useEffect } from "react";
import { fetchLawMetadata, fetchAmendments, fetchImplementingActs, fetchLawCitedBy } from "../utils/formexApi.js";
import { earliestEntryIntoForce, todayIso } from "../utils/lawStatus.js";

// Cellar's sentinel for "open-ended" (still in force).
const IN_FORCE_SENTINEL = "9999-12-31";

/**
 * Single, error-tolerant fetch of a law's EU metadata, amendment history,
 * implementing/delegated acts and reverse citations, keyed by CELEX. Shared by
 * the overview header (status pill + dates) and the metadata cards so a law is
 * only fetched once.
 *
 * All requests are best-effort: a failure resolves to an empty/absent value
 * rather than throwing, so the caller can simply omit whatever is missing.
 */
export function useLawMetadata(celex) {
  const [metadata, setMetadata] = useState(null);
  const [metaLoaded, setMetaLoaded] = useState(false);
  const [amendments, setAmendments] = useState(null);
  const [amendmentsLoaded, setAmendmentsLoaded] = useState(false);
  const [implementing, setImplementing] = useState(null);
  const [implementingLoaded, setImplementingLoaded] = useState(false);
  const [citedBy, setCitedBy] = useState(null);
  const [citedByLoaded, setCitedByLoaded] = useState(false);

  useEffect(() => {
    setMetadata(null);
    setMetaLoaded(false);
    setAmendments(null);
    setAmendmentsLoaded(false);
    setImplementing(null);
    setImplementingLoaded(false);
    setCitedBy(null);
    setCitedByLoaded(false);
    if (!celex) return;

    let cancelled = false;

    fetchLawMetadata(celex)
      .then((result) => { if (!cancelled) setMetadata(result); })
      .catch(() => { if (!cancelled) setMetadata(null); })
      .finally(() => { if (!cancelled) setMetaLoaded(true); });

    fetchAmendments(celex)
      .then((result) => { if (!cancelled) setAmendments(result.amendments || []); })
      .catch(() => { if (!cancelled) setAmendments([]); })
      .finally(() => { if (!cancelled) setAmendmentsLoaded(true); });

    fetchImplementingActs(celex)
      .then((result) => { if (!cancelled) setImplementing(result.acts || []); })
      .catch(() => { if (!cancelled) setImplementing([]); })
      .finally(() => { if (!cancelled) setImplementingLoaded(true); });

    // Reverse citations stay null (not empty) on failure so the overview can
    // hide the card entirely when the citation graph is unavailable.
    fetchLawCitedBy(celex)
      .then((result) => { if (!cancelled) setCitedBy(result); })
      .catch(() => { if (!cancelled) setCitedBy(null); })
      .finally(() => { if (!cancelled) setCitedByLoaded(true); });

    return () => { cancelled = true; };
  }, [celex]);

  // Status is still derived from endOfValidity rather than the CDM boolean: the
  // boolean was parsed wrong here for a long time (Cellar answers "1"/"0", the
  // code compared to "true"), so every act read false and this derivation grew
  // up around it. That parse is fixed in shared/law-queries.js, but switching
  // the derivation over would restate 80k acts' status in one go and belongs in
  // its own change.
  //
  // What is corrected here is the case the date test gets flatly backwards: an
  // act published but not yet in force has no end of validity, so it was shown
  // "In force" while the search results — reading the same Cellar flag — said
  // the opposite. The entry dates were already fetched; they just weren't used.
  let status = null;
  if (metadata) {
    const eov = metadata.endOfValidity;
    const noLongerInForce = Boolean(eov && eov !== IN_FORCE_SENTINEL && new Date(eov) < new Date());
    const startsOn = earliestEntryIntoForce(metadata.entryIntoForce);
    const notYetInForce = Boolean(!noLongerInForce && startsOn && startsOn > todayIso());
    status = {
      inForce: !noLongerInForce && !notYetInForce,
      notYetInForce,
      // Each date is only meaningful in the state it explains.
      startsOn: notYetInForce ? startsOn : null,
      endedOn: noLongerInForce ? eov : null,
    };
  }

  return {
    metadata,
    metaLoaded,
    amendments,
    amendmentsLoaded,
    implementing,
    implementingLoaded,
    citedBy,
    citedByLoaded,
    status,
  };
}
