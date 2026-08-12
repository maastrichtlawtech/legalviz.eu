/**
 * Pure helpers behind the "you are reading the text as adopted" notice.
 *
 * Two independent facts drive it. *Was the text changed?* comes from the
 * amendment history — corrigenda are excluded, since they correct the published
 * text rather than amend the law, and a corrigendum-only act (the GDPR, for
 * one) is still readable as adopted. *Can the reader see the current text?*
 * comes from the consolidated-version list.
 *
 * The API returns every consolidated version, including ones dated in the
 * future — EUR-Lex prepares a consolidation as soon as an amending act is
 * published, sometimes months before it applies. Choosing between them needs
 * today's date, which deliberately stays out of the cached payload.
 */

/** ISO `YYYY-MM-DD` for the local calendar day, so comparisons are string-safe. */
export function todayIso(now = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Split a version list into the one in force today and the ones not yet applied.
 *
 * `current` is the newest version dated on or before today. A law whose only
 * consolidations are future-dated has no current version — presenting an
 * upcoming one as the text in force would be worse than saying nothing.
 */
export function selectConsolidatedVersions(versions, today = todayIso()) {
  const sorted = (Array.isArray(versions) ? versions : [])
    .filter((version) => version && version.celex && version.date)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));

  const applied = sorted.filter((version) => version.date <= today);
  const upcoming = sorted.filter((version) => version.date > today);

  return {
    current: applied.length ? applied[applied.length - 1] : null,
    upcoming,
    all: sorted,
  };
}

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
