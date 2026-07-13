# TODO — extend law search to the full EU corpus + redeploy

Branch: `claude/law-search-improvements-b12ri4` (PR #61). Goal: go from "primary
acts since 2010" to **the full historical EU primary-law corpus**, rebuild the
search index with excerpts, ship a better search, update the UI, and redeploy to
Railway.

> Note: the "new MiniSearch approach that indexes recitals + Article 1/2" is
> **already on this branch** (PR #61), not on `main`. `EXCERPT_BOOST` /
> `buildExcerptFromCombined` live here; `main` has none of it.

## Where things stand now
- **FMX corpus complete**: 27,916 acts at `backend/search/data/laws/<year>/<CELEX>.xml.gz` (mostly ≥2000; near-100% of 2010–2026, ~48% of 2000–2009, very little pre-2000 — those have no FMX).
- **Live search cache rebuilt** for 2010–2026: `backend/search/data/search-cache.json`, 13,493 records, ~99.5% excerpts. ⚠️ **modified but uncommitted.**
- **HTML corpus downloading now** (raw only, no parsing): the ~137k FMX-less acts → `backend/search/data/laws-html/<year>/<CELEX>.html.gz` via `backend/search/html-harvest.js` (warm-cookie plain fetch). ~62% save, ~38% are 404 (no HTML rendition). Sidecars: `html-shards/state-*.json.misses.txt` / `.fails.txt`.

---

## 1. Fix / extend the HTML parser for old laws
The download gives us raw HTML; parsing older shapes is the deferred work.
- [ ] Point `backend/shared/eurlex-html-parser.js` (`parseStructuredHtmlToCombined`) at the `laws-html/` corpus and see where it breaks. It targets the modern `.oj-*` OJ HTML; expect degradation on pre-~2004 OJ HTML and very old layouts.
- [ ] Add fixtures from a spread of eras (2000s, 1990s, 1970s, 1960s) and extend the parser to handle the older `class="oj-font*"` / legacy OJ shapes (same era-split already handled for case law in `backend/shared/law-queries.js`).
- [ ] Iterate **offline against the corpus** — no re-scraping. Success = it yields `{ articles, recitals, definitions, title }` for old acts so `buildExcerptFromCombined` can run.

## 2. Rebuild the search cache from the FULL corpus (offline)
- [ ] Add an offline "excerpt from corpus" path so `search-build.js` can enrich a record from the local FMX **or** HTML corpus (no network). FMX is already corpus-first; add an HTML fallback that runs `parseStructuredHtmlToCombined` → `buildExcerptFromCombined`.
- [ ] Extend the harvested/enriched set to the full year range (1952–2026), folding in 2000–2009 FMX + the HTML-parsed FMX-less acts.
- [ ] Merge into `backend/search/data/search-cache.json` (reuse the shard-merge approach). Decide inclusion policy: which historical acts are worth indexing vs. noise.
- [ ] Review cache invalidation against `main`'s new versioning: check `PARSER_VERSION` (FMX parser) and the cross-cutting **cache-version table** in the root `CLAUDE.md` — bump any constants whose cached output our excerpt/corpus changes affect, so stale caches are detected.
- [ ] Commit the rebuilt `search-cache.json` (it's the artifact the deployed backend loads at startup — the raw corpus is build-time only and stays gitignored).

## 3. More downloads — EUROVOC topic enrichment
- [ ] Re-run `backend/search/fetch-eurovoc.js` (`npm --prefix backend run build:search-eurovoc`) for the newly-added CELEX so `data/eurovoc.json` has topics for pre-2016 acts too (`legal-cache-store.js` attaches `record.eurovoc`, surfaced as result `topics`).
- [ ] Consider other enrichments while we're here (e.g. act status/consolidation, in-force flag) if useful for ranking.

## 4. Better search functionality
- [ ] Tune the excerpt/MiniSearch ranking now that the excerpt field is populated corpus-wide: revisit `EXCERPT_BOOST` (`legal-cache-store.js`), field weights, and `search-ranking.js`.
- [ ] Add/refresh regression fixtures in `backend/search/search-regression.test.js` for topic-only queries that should now hit older laws.
- [ ] Evaluate result quality across eras; decide whether pre-2000 acts need down-weighting vs. modern ones.

## 5. UI — remove the "only since 2010" messaging
- [ ] Update the `searchingLaws` string in **all 24 locale files** `src/i18n/locales/*.json` (currently: *"Searching primary EU acts from the LegalViz index since 2010. Secondary acts are not included yet."*). Reword to the new coverage (e.g. "…primary EU acts across the full corpus").
- [ ] Grep for any other hardcoded coverage/date copy in `src/` and adjust.

## 6. Deploy to Railway
- [ ] **Decide how to ship the cache — this is now blocking.** `search-cache.json` is already **51 MB** at just 2010–2026 (excerpts ~doubled it) and triggers GitHub's >50 MB warning; the full 1952–2026 rebuild will exceed GitHub's **100 MB hard limit** and bloat the repo/deploy. Options:
  - commit a **gzipped** cache and gunzip at load (smallest change; ~5–10 MB in git),
  - move it to **Git LFS**,
  - or **build the cache at deploy time** on Railway instead of committing it (needs the corpus available there — probably not viable) / fetch it from object storage.
  Recommend gzip-at-rest.
- [ ] Ensure the chosen cache artifact (+ `eurovoc.json`) is present in the deployed image; the backend loads the cache at startup (restart required — see README "Search Cache Build").
- [ ] The raw corpus (`laws/`, `laws-html/`) is **not** shipped (gitignored, build-time only); only the derived cache is.
- [ ] Deploy, restart the API, smoke-test `/api/search` on the server for a pre-2010 / topic-only query.

## 7. Verify end-to-end
- [ ] `npm test` (web + api) green; `npm run lint`.
- [ ] Local: rebuild cache → restart API → search returns pre-2010 laws with excerpts + EUROVOC topics.
- [ ] Prod: same check against the Railway deployment; confirm the UI no longer says "since 2010".

---

## Loose ends from the download phase
- [ ] Commit the already-rebuilt 2010–2026 `search-cache.json` (or wait and commit the full-corpus rebuild in step 2).
- [ ] Retry the HTML `.fails.txt` sidecars (transient failures) once the main pass finishes.
- [ ] Decide whether to keep the operational scripts (`harvest-parallel.sh`, `html-harvest-launcher.sh`, `merge-shards.js`) in the repo (currently scratchpad-only) or as documented `eurlex` CLI commands.
