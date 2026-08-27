/**
 * Where "read this law as amended" should land, and with what query string.
 *
 * The overview's version toggle promises reading. Flipping `?version=current`
 * on its own kept the reader on the overview, whose AI summary still opens
 * with "this overview describes the law as adopted" — the consolidated text
 * was loaded but nothing on screen showed it, so the click read as a no-op
 * (reported by a reader on Regulation (EC) No 1367/2006). The toggle
 * therefore switches the version *and* enters the text in one navigation.
 *
 * Returns `null` when there is nothing to enter — no version requested (the
 * "back to as adopted" direction is not a request to start reading), or a
 * document with no readable entry at all — and the caller should fall back to
 * setting the search params alone.
 */
export function buildVersionReadTarget(data, searchParams, version) {
  if (!version) return null;

  // Same order as the overview's "start reading" button: an act with no
  // articles (rare, but recital- or annex-only documents exist) still has
  // something to open.
  const entry = data?.articles?.[0]
    ? { kind: "article", id: data.articles[0].article_number }
    : data?.recitals?.[0]
      ? { kind: "recital", id: data.recitals[0].recital_number }
      : data?.annexes?.[0]
        ? { kind: "annex", id: data.annexes[0].annex_id }
        : null;
  if (!entry) return null;

  const nextParams = new URLSearchParams(searchParams);
  nextParams.set("version", version);
  const query = nextParams.toString();

  return { ...entry, search: query ? `?${query}` : "" };
}
