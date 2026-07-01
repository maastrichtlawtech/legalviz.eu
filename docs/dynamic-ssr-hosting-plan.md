# Dynamic per-law SSR + Railway hosting — Design Plan

> Not started. Captures a discussion about extending SEO coverage beyond the
> 8 flagship laws that are prerendered today.

## 1. Problem

The frontend is deployed to GitHub Pages (`scripts/copy-404.js` exists
specifically to work around GitHub Pages' lack of server-side routing).
GitHub Pages is pure static hosting — no server-side or edge compute at
request time. Because of that, `scripts/generate-prerendered-law-pages.js`
can only afford to prerender a small, bounded set of laws
(`FEATURED_LAWS`, currently 8) at **build time**: each page needs a fetch
to the backend plus (on cache miss) an LLM-generated summary, so
prerendering is deliberately kept small to bound build time and cost.

Every other law — the actual long tail, i.e. any EU act a user looks up by
CELEX, search, or import — has no prerendered page. A crawler hitting
`/regulation-2021-123` (or any non-featured slug) falls through to the
`404.html` SPA-fallback copy of the homepage, served with a 404 status,
with the real content only appearing after client-side JS runs. That's bad
for discoverability of anything beyond the flagship laws.

## 2. Why Railway changes the calculus

The backend API is already hosted on Railway, which runs a real
long-lived Node process (unlike GitHub Pages or typical serverless
functions with cold-start-per-request limits). That makes **on-demand,
per-request rendering** practical: instead of prerendering a fixed list
at build time, generate the same kind of static HTML snapshot the first
time a specific law/article/recital/annex is actually requested, cache
it, and serve the cached snapshot on every subsequent hit. This covers
the entire long tail without a bounded, curated list, and without paying
generation cost for pages nobody ever requests.

## 3. Proposed architecture

- **Extract the static-HTML builder functions** out of
  `scripts/generate-prerendered-law-pages.js` (`buildLawBody`,
  `buildArticleBody`, `buildRecitalBody`, `buildAnnexBody`,
  `buildLawSummarySection`, `buildSeoPayload`, `buildPageHtml`,
  `escapeHtml`, `stripHtml`, `summarize`, `getValidAnnexes`, etc.) into a
  shared module (e.g. `backend/shared/static-page-builder.js` or a
  small new `shared-html/` package) so both the existing build-time
  script and a new request-time route can call the same code — no
  duplicated HTML-building logic between "prerender N flagship laws at
  build" and "render any law on demand."
- **Serve the frontend from the same place as the API** (same Railway
  project, either the existing Express app or a sibling service) instead
  of GitHub Pages. The server:
  1. Serves the built `dist/` static assets (JS/CSS/images) unchanged.
  2. For HTML document requests matching a law route (`/:slug`,
     `/:slug/article/:n`, `/:slug/recital/:n`, `/:slug/annex/:id`),
     checks an on-disk/DB cache for a pre-generated snapshot for that
     exact route.
     - Cache hit → serve immediately.
     - Cache miss → fetch the law data + summary (reusing
       `resolveParsedLaw` / `ensureLawSummary`, both already cached
       server-side), build the snapshot with the shared builder module,
       write it to cache, and serve it.
  3. The served HTML still ships the full SPA bundle, which hydrates
     over the snapshot for full interactivity — this is standard
     SSR-with-hydration, not a crawler-only special case, so real users
     get a faster first paint too, not just bots.
  4. Falls back to the existing bare SPA shell for routes that aren't a
     recognized law/article/recital/annex path (search, library, import
     flow, etc.) — those stay client-rendered as today.
- **Retire `scripts/copy-404.js`** and the GitHub Pages 404-fallback hack
  once real server-side routing exists.
- **Featured-laws build-time prerendering can stay as-is** (or be
  retired in favor of the on-demand path relying on a warm cache after
  first deploy) — worth deciding once the on-demand path exists, not
  before.

## 4. Migration considerations

- **DNS cutover**: `legalviz.eu` currently points at GitHub Pages; needs
  to be repointed to Railway's custom domain once the new setup is
  verified.
- **Hosting cost**: GitHub Pages is free; serving the frontend from
  Railway adds bandwidth/compute cost there. Given the backend is
  already paid-for on Railway, likely a modest incremental cost, but
  worth checking against the current plan/usage before committing.
- **Cold starts / sleep-on-idle**: confirm the Railway plan in use
  doesn't sleep on idle — that would hurt both crawlers and real users
  on the first request after a quiet period. (Static GitHub Pages has no
  such issue today.)
- **Cache storage**: where do on-demand snapshots live? Simplest is the
  same `FMX_DIR`-style on-disk cache already used for Formex XML,
  summaries, and case-law digests (see `backend/shared/*-service.js`),
  keyed by celex+lang+route-kind+id. Needs a size/eviction policy since
  this is now unbounded by a curated list (unlike today's 8 featured
  laws).
- **Sitemap**: `scripts/generate-sitemap.js` currently walks `dist/` for
  prerendered `index.html` files. With on-demand generation there's no
  fixed set of files to walk at build time — sitemap generation would
  need to either enumerate known laws some other way (e.g. from the
  legal-cache / search index) or be dropped in favor of relying on
  crawl discovery via internal links, which is weaker for a large
  corpus and should be thought through before dropping it.

## 5. Open decisions

- Keep the curated `FEATURED_LAWS` build-time prerender as a fast-path
  "guaranteed warm" tier, with on-demand generation covering everything
  else? Or unify on one mechanism?
- Same Railway service as the API, or a separate service in the same
  project? (Separate keeps API and frontend deploys independent; same
  service is simpler to wire up first.)
- Snapshot cache invalidation policy — same content-hash + version
  scheme already used for AI summaries/digests, or time-based expiry?
- Whether to keep GitHub Pages as a fallback/mirror during migration, or
  cut over directly.

## 6. Suggested build order

1. Extract shared static-HTML builder module; update
   `scripts/generate-prerendered-law-pages.js` to use it (no behavior
   change, pure refactor — proves the extraction is safe).
2. Add the request-time route/middleware to the backend, reusing the
   shared module, gated behind a feature flag / separate path for
   testing without affecting the current GitHub Pages deploy.
3. Stand up frontend static-asset serving on Railway alongside it;
   verify end-to-end on a Railway preview/staging domain.
4. Decide the fate of `FEATURED_LAWS` build-time prerendering and the
   sitemap generation approach (Section 5).
5. DNS cutover, retire GitHub Pages + `copy-404.js`.
