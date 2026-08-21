// One place to turn Cellar's in-force flag into something a UI may say out loud.
//
// The flag is a tri-state — true / false / null ("Cellar has no status", ~13%
// of the corpus) — and the trap is `false`. It means "not in force on the day
// Cellar was asked" and nothing more. In particular it does NOT mean "no longer
// in force": acts are harvested when they are published, which is normally
// *before* they enter into force, so a brand-new regulation reads `false` for
// its first weeks and then flips to `true`.
//
// Only an entry-into-force date in the future separates the two, which is why
// `entryIntoForce` is fetched at all. Without it the search results labelled
// Regulation 2026/1818 — in force from 2026-08-30 — "No longer in force", and
// greyed it out, during exactly the weeks people were looking for it.
//
// Mirrors isNotYetInForce() in backend/search/legal-cache-store.js, which
// applies the same rule to the ranking prior. Keep the two in step.

export function todayIso(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

// Dates arrive from two places with different discipline: the search API, which
// validated them, and the live SPARQL metadata query, which does not — Cellar
// answers 32026D1296 with `1001-01-01`, and some values carry a time part. Take
// the ISO date prefix or nothing.
function isoDate(value) {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value ?? "").trim());
  return match ? match[1] : null;
}

// Several entry dates means staged application — Regulation 2026/1818 carries
// ten, out to 2036. The earliest is when the act itself enters into force; the
// rest bring individual provisions into effect.
export function earliestEntryIntoForce(value) {
  const list = Array.isArray(value) ? value : [value];
  const dates = list.map(isoDate).filter(Boolean).sort();
  return dates[0] || null;
}

// "inForce" | "notYetInForce" | "notInForce" | null (unknown — draw no badge).
export function lawStatus(law, today = todayIso()) {
  if (!law) return null;
  if (law.inForce === true) return "inForce";
  // null, undefined, or anything else: Cellar has no answer, so neither do we.
  if (law.inForce !== false) return null;
  const entry = earliestEntryIntoForce(law.entryIntoForce);
  return entry && entry > today ? "notYetInForce" : "notInForce";
}
