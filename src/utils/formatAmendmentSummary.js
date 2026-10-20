import { formatMetaDate } from "./formatMetaDate.js";

/**
 * "Amended once, on 8 Jul 2026" and its variants. The catalog carries no
 * plural machinery, so the singular is its own key. A truncated amendment
 * count is a lower bound, never an exact number (see `truncated` in
 * fetchAmendments), so it gets its own "at least N" copy rather than risk a
 * precise-looking figure that is provably wrong.
 */
export function formatAmendmentSummary(status, locale, t) {
  const amendedOn = formatMetaDate(status.latestAmendmentDate, locale);
  const once = status.amendmentCount === 1 && status.amendmentCountExact;
  const key = status.amendmentCountExact
    ? (once ? "consolidation.amendedOnce" : "consolidation.amended")
    : "consolidation.amendedAtLeast";
  return t(amendedOn ? `${key}WithDate` : key, { count: status.amendmentCount, date: amendedOn });
}
