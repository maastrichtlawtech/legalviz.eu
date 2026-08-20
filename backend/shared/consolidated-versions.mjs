/**
 * Pure helpers for picking a consolidated ("as amended") EUR-Lex version.
 *
 * The API returns every consolidated version, including ones dated in the
 * future — EUR-Lex prepares a consolidation as soon as an amending act is
 * published, sometimes months before it applies. Choosing between them needs
 * today's date, which deliberately stays out of the cached payload.
 *
 * Shared by the frontend (`src/utils/consolidatedVersions.js` re-exports this)
 * and the backend consolidated-fallback path in `parsed-law-service.js`.
 *
 * ESM with named exports only. The browser needs real `export` statements —
 * Vite's dev server serves source files untransformed, so a CommonJS
 * `module.exports` here is unresolvable in the browser even though `vite
 * build` would paper over it. CommonJS callers reach it through Node's
 * require(esm) (Node >=22.12); a default export would surface there as
 * `.default`, so keep the exports named. `shared/legal-reference-core.mjs` is
 * the precedent for this shared-with-CommonJS shape.
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
