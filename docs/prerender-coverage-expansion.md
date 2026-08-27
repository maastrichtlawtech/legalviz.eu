# Prerender coverage beyond FEATURED_LAWS — plan

> Not started. Response to a feature request: extend
> `scripts/generate-prerendered-law-pages.js` past the 8 `FEATURED_LAWS` to a
> curated list of acts, so the `actType-year-number` route the router already
> supports becomes crawlable.
>
> This is the *static, interim* answer to the same problem
> [docs/dynamic-ssr-hosting-plan.md](dynamic-ssr-hosting-plan.md) solves with
> request-time SSR. It does not replace that plan; it buys most of the SEO
> value without the Railway/DNS migration, and every builder function it
> touches is the same set that plan wants extracted, so the two compose.

## 1. What is broken today

- `FEATURED_LAWS` (`src/utils/lawRouting.js`) has 8 entries; the prerender
  script iterates exactly that list, and production ships 1,533 sitemap URLs.
- `parseOfficialReferenceSlug` + `useLawViewerSource` fully support
  `/regulation-2016-679`, `/directive-2019-790/article/17`, etc., resolving the
  slug to a CELEX through `/api/resolve-reference`. That route is how the rest
  of the corpus is reachable at all.
- No page is prerendered for it, so it falls through to the GitHub Pages
  `404.html` SPA shell. Verified against production:
  `curl -o /dev/null -w '%{http_code}' https://legalviz.eu/regulation-2016-679/`
  → **404**, while `/gdpr/` → 200. A crawler sees a 404 status and a homepage.

The build already refuses to silently drop indexed pages (`ALLOW_PARTIAL`), so
the coverage gap is a scope decision, not an oversight — the ask is to widen
the scope.

## 2. Goal / non-goals

**Goal.** Prerender a curated second tier of acts (target: the 171-act digital
acquis list offered with the request) at their official-reference slugs, with
the same overview / article / recital / annex page shapes and the same
"never silently shrink" build discipline.

**Non-goals.** Whole-corpus coverage (that is the SSR plan), multi-locale
prerendering, changing the page templates, and retiring `copy-404.js`.

## 3. Measured budget — this is the part that decides the design

Sampled `/api/laws/:celex/parsed` on five non-featured acts (32019L0790,
32015L2366, 31993L0013, 32018R1725, 32022R0612): 11–117 articles, 0–113
recitals, 0–2 annexes — **~130 pages per act on average**, one act ranging to
232. Measured page weight in production: ~9 KB per article/recital page.

| | today | +171 acts |
|---|---|---|
| pages in `dist/` | ~1,500 | **~22,000** |
| `dist/` size | ~15 MB | **~200 MB** (GitHub Pages soft limit is 1 GB) |
| sitemap URLs | 1,533 | ~22,000 (limit 50,000 / 50 MB — fits, no index needed yet) |
| API requests per build | ~16 | **~350–500** |

Two hard edges fall out of that last row:

- `RATE_LIMIT_MAX` is **500 requests / 15 min per IP**, shared across all
  `/api` endpoints (`backend/server.js`). A 171-act build sits right on it. The
  build must pace itself (bounded concurrency + a token bucket), and/or CI must
  be allowlisted.
- `/api/laws/:celex/summary` is behind `generationLimitMiddleware`:
  **10 generations / hour / IP**, charged only on an actual model call. Cached
  summaries are free; 171 cold ones are not, and the 11th would 429. So the
  curated tier ships **without** the summary section until summaries are
  pre-warmed server-side (see §7).

Also: parse cost. The script currently fetches raw FMX and re-parses it in
jsdom. `/api/laws/:celex/parsed` already returns exactly the fields the
builders read (`title`, `articles[].article_number|article_title|article_html`,
`recitals[].*`, `annexes[].annex_id|annex_title|annex_html`) from a
server-side cache. Switching the curated tier to `/parsed` removes 171 jsdom
parses from the build.

## 4. Design

**4.1 Curated list as data.** New `src/data/curated-laws.json`: an array of
`{ celex, label, source }`. Nothing derived is stored — the slug comes from the
CELEX so it can never drift from the router.

**4.2 `officialReferenceFromCelex(celex)`** — new export in
`src/utils/lawRouting.js`, the inverse of the existing `SECTOR3_CELEX` /
`ELI_TYPE_TO_CELEX_LETTER` mapping (`R`→regulation, `L`→directive,
`D`→decision, number un-padded). Feeding its output through the existing
`enrichLaw` gives the same law object shape the script already consumes, and
guarantees the emitted path is byte-identical to what
`parseOfficialReferenceSlug` accepts. Unit-tested in `lawRouting.test.js`,
including round-trip `celex → slug → reference → celex` over the whole curated
list.

**4.3 Two tiers in the script.**

| | featured (8) | curated (~171) |
|---|---|---|
| source | `/api/laws/:celex` + jsdom parse (unchanged) | `/api/laws/:celex/parsed` |
| pages | overview + articles + recitals + annexes | same |
| AI summary section | yes | no (§3) |
| failure policy | build fails on any error (unchanged) | budgeted, §4.5 |

Entries whose CELEX is already featured are dropped from the curated tier, so
GDPR never gets both `/gdpr/` and `/regulation-2016-679/` — one URL per law, no
canonical fight. (The app itself already `replace`-navigates the reference slug
to the featured slug.)

**4.4 Pacing.** `PRERENDER_CONCURRENCY` (default 4) over the act list, plus a
request-rate cap tuned under `RATE_LIMIT_MAX`. `fetchWithRetry` already handles
429/5xx with backoff; it stays, with 429 handling made explicit rather than
incidental.

**4.5 Failure budget — keep the anti-silent-shrink guarantee.** All 8 featured
acts must still succeed or the build fails. For the curated tier, fail the
build if more than `PRERENDER_MAX_FAILED_LAWS` (default 5) acts fail, *or* if
the total generated page count drops more than 10% below the previous
production build (read from `https://legalviz.eu/sitemap.xml`, skipped when
unreachable). This preserves the property the script already protects — a flaky
API must not quietly de-index hundreds of pages — without letting one dead
CELEX out of 171 redden main.

**4.6 Sitemap.** No change needed at 22k URLs; add an assertion that fails the
build past 45,000 URLs or 45 MB, with splitting into a sitemap index as the
follow-up when that trips. Note the existing `public/` copy grows to ~1.5 MB.

## 5. Build order

1. `officialReferenceFromCelex` + tests. No behavior change.
2. Curated-tier plumbing in the script, driven by
   `PRERENDER_CURATED_LIMIT` (default 0 = off). Land it dark.
3. Pilot with 20 acts in CI; record wall-clock, `dist/` size, request count,
   429s. Re-tune §4.4 against real numbers before scaling.
4. Raise to the full list; enable the failure budget and the sitemap guard.
5. Follow-up (separate PR): pre-warm summaries server-side so the curated tier
   can carry the overview section too.

## 6. Tests

- `lawRouting.test.js`: CELEX↔slug round-trip, rejection of non-sector-3 ids.
- New `scripts/generate-prerendered-law-pages.test.js` (vitest): curated-list
  schema validation, featured/curated de-duplication, the failure-budget logic,
  and one end-to-end page render against a stubbed `fetch` — the script has no
  test coverage today.
- CI check that every curated CELEX resolves (`/api/resolve-reference`), run on
  a schedule rather than per-PR so EUR-Lex flakiness can't block merges.

## 7. Risks

- **Thin-content / crawl-budget dilution.** 22k pages of mostly legal text with
  a shared boilerplate header. Recital pages are the thinnest. Mitigation if
  Search Console shows "crawled – currently not indexed" at scale: drop recital
  pages from the curated tier and keep them featured-only.
- **Staleness.** Pages are only as fresh as the last deploy; a `PARSER_VERSION`
  bump or a consolidated-text update does not re-emit them until main builds.
- **CI time and artifact size.** ~200 MB / 22k files through
  `upload-pages-artifact`; watch the deploy step, not just the build.
- **API load.** The build becomes the single heaviest client of the production
  API. §4.4 is what keeps that polite.

## 8. Open questions

1. Curated list provenance: take the offered 171-act digital acquis list as
   `src/data/curated-laws.json` (with attribution in `source`), or maintain our
   own? Taking it is the fast path — it is already verified to resolve — but we
   need to agree who re-verifies it when EUR-Lex changes.
2. Recital pages for the curated tier: in from day one, or hold until the
   featured-tier indexing rate says they earn their place?
3. Do we allowlist the CI runner on the backend rate limiter, or keep the build
   strictly inside the public budget?
4. Does this defer the SSR plan indefinitely, or is it explicitly the bridge
   until Railway hosting lands?
