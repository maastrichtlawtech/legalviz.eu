/**
 * Pure helpers behind the "you are reading the text as adopted" notice.
 *
 * Two independent facts drive it. *Was the text changed?* comes from the
 * amendment history — corrigenda are excluded, since they correct the published
 * text rather than amend the law, and a corrigendum-only act (the GDPR, for
 * one) is still readable as adopted. *Can the reader see the current text?*
 * comes from the consolidated-version list.
 *
 * `todayIso` and `selectConsolidatedVersions` live in
 * `backend/shared/consolidated-versions.mjs` (shared with the backend
 * consolidated-fallback path in `parsed-law-service.js`) and are re-exported
 * here, mirroring `src/utils/url.js` re-exporting `formex-parser/url.mjs`.
 */

export * from "../../backend/shared/consolidated-versions.mjs";

/**
 * Count the entries that actually changed the law's text, and date the newest.
 *
 * Amendment dates are the amending act's own document date, which is why they
 * are only ever shown as "most recently amended in <month year>" rather than
 * used to reason about what the current text says.
 */
export function summarizeAmendments(amendments) {
  const changes = (Array.isArray(amendments) ? amendments : [])
    .filter((entry) => entry && entry.type === "amendment");
  const dates = changes.map((entry) => entry.date).filter(Boolean).sort();

  return {
    count: changes.length,
    latestDate: dates.length ? dates[dates.length - 1] : null,
  };
}
