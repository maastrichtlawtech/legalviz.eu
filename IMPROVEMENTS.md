# LegalViz.EU — Code Review & Improvement Roadmap

Full-codebase review (backend API & AI services, parsers & search, React frontend, tests/build/CI/extension), July 2026. Every finding below was verified against source; file:line references are as of this commit.

**Status of the previous roadmap in this file:** largely done and therefore removed — the repo now has 730+ passing tests across vitest and node:test, `LawViewer.jsx` is decomposed (582 lines + 16 hooks), CI runs lint + tests + build on every PR, and lint is clean. What follows replaces it.

---

## Critical

### C1. Stored XSS: legacy EUR-Lex HTML is rendered unsanitized
`backend/shared/eurlex-html-parser.js:162-168` builds `article_html`/`annex_html` from raw `node.outerHTML` of the fetched EUR-Lex page, and the frontend injects it via `dangerouslySetInnerHTML` in `LawDocumentContent.jsx:16`, `LawContentPane.jsx:128`, `PrintView.jsx:69,82,122,157`, and `LawViewerSideBySide.jsx:149-153`. There is no sanitizer anywhere in the pipeline, and the payload is persisted in IndexedDB — so a hostile fragment (inline event handler, `javascript:` href) becomes *stored* XSS replayed on every revisit. The Formex path escapes text; the HTML-fallback path does not.
**Fix:** run the HTML through DOMPurify (or an allowlist serializer at parse time) at the single injection choke point; bump `PARSER_VERSION`.

### C2. LLM endpoints have no in-app spend protection

> **Deployed mitigation:** the production OpenRouter account carries a dashboard-level spend limit, so the worst case is capped — abuse exhausts the budget and degrades the AI features (cache misses start failing) rather than producing an unbounded bill. The findings below still matter because they let a single actor burn the whole budget and take the AI features down for everyone; severity is downgraded from "unbounded spend" to "cheap denial of AI features + cache pollution". Documented in `backend/README.md` (env-var section) and `backend/CLAUDE.md`.
The four AI endpoints (recital titles, law summary, article digest, whole-law digest; `backend/routes/api-routes.js:388-610`) share only the generic 500 req/15 min/IP limiter with every other route — no per-endpoint budget, no global concurrency cap, no law allowlist. Cache keys span every valid CELEX × 24 languages, and recital titles cost `ceil(recitals/35)` model calls per request. Compounding it:
- the limiter keys on `req.ip` behind `trust proxy` (`server.js:33`), so if the origin port is reachable directly, a spoofed `X-Forwarded-For` per request yields a fresh bucket every time (`shared/rate-limit.js:1-3`);
- `app.use(cors())` (`server.js:72`) reflects any origin, so a third-party page can distribute the spend across its visitors' real IPs.

**Fix:** dedicated, much tighter limiter + global concurrency/budget cap on the LLM routes; origin allowlist for them; consider restricting generation to a curated law list.

### C3. Data-refresh automation publishes releases the Dockerfile cannot consume
`backend/Dockerfile:49` mandatorily fetches `case-law-cache.json.gz` and `citation-graph.json.gz` from the `data-vN` release, but `.github/workflows/refresh-case-law-data.yml` publishes `case-law-cache-v5.json.gz` (different name) and carries neither the citation graph nor `definitions.json.gz` forward. Merging the workflow's auto-opened "Deploy data-vN" PR would 404 every backend Docker build (and silently drop the cross-law definitions feature). The workflow predates the citation-graph and definitions assets and has drifted from the Dockerfile's own "a new release must carry the full set" invariant.
**Fix:** make the workflow download and re-upload the full current asset set under the exact names the Dockerfile expects, and add a CI assertion that release assets ⊇ Dockerfile fetch list.

---

## High

### H1. `escapeHtml` in the Formex parser doesn't escape quotes, but feeds double-quoted attributes
`fmxParser.mjs:352-354` escapes only `& < >`, yet its output lands inside `data-marker="…"` (:108, :255) and `data-oj-*="…"` (:160). A `"` in document content breaks out of the attribute — attribute injection into HTML that is then `dangerouslySetInnerHTML`'d. The HTML parser's own `escapeHtml` (`eurlex-html-parser.js:50-57`) does it right; align them. Bump `PARSER_VERSION`.

### H2. Cross-reference grammar: comma+digit over-match creates spurious article links
`backend/shared/legal-reference-core.mjs:194` — the enumeration separator accepts a bare `,` so `"Article 4(1), 30 % of the allowances"` yields refs `4` and `30`, and `injectCrossRefLinks` renders "30" as a clickable link to `#article-30` (which usually exists in a large law, so integrity checks don't strip it). Wrong links and wrong `crossReferences` edges persist into caches. Verified by execution.
**Fix:** require an article-ish continuation (e.g. `(n)`, "and", "to") after a bare comma; bump `PARSER_VERSION` + rebuild graph data.

### H3. Coordinated act lists only capture the first identifier
`fmxParser.mjs:408-417` — `"Directives 89/665/EEC and 92/13/EEC"` extracts only the first directive because the regex requires an act word immediately before each identifier. This phrasing is ubiquitous in repeal/amendment clauses, so the citation graph is systematically missing external edges corpus-wide. Fix + `PARSER_VERSION` bump + `data-vN` republish.

### H4. NLP tokenizer destroys Greek/Cyrillic text, and the empty result poisons a language-invariant cache
`src/utils/nlp.js:26` keeps only ASCII + Latin-Extended, so EL/BG laws tokenize to nothing: every recital is orphaned and in-document search returns zero results. Worse, `useRecitalMap.js:29-35` caches the recital→article map under a key with **no language component**, so opening a law in Greek first stores the empty map and serves it for English too until an `NLP_VERSION` bump.
**Fix:** switch to a Unicode-aware tokenizer (`\p{L}\p{N}`), bump `NLP_VERSION`, and either key the cache by language or only cache maps built from a designated pivot language.

### H5. Cross-law navigation rewrites deep links from stale data
`src/hooks/law-viewer/useLawSelection.js:12-23` resolves the URL's article against `data` that may still hold the *previous* law during the same commit; not finding it, it falls back to the first article and `navigateToCanonical(..., { replace: true })` destroys the intended deep link. `useLawDocument` tags `data.celex` for exactly this guard and `LawViewer.jsx:220,288` uses it — `useLawSelection` doesn't.
**Fix:** bail out of the effect when `data.celex` doesn't match the URL's law.

---

## Medium

### M1. Frontend cache can be permanently poisoned by an unvalidated response
`src/utils/formexApi.js:659-671` writes whatever body came back (including proxy error pages) to IndexedDB *before* parse validation; subsequent loads serve the poisoned entry as a cache hit, the parse error isn't recognized by `isMissingStructuredLawText`, the `/parsed` fallback never fires, and the law stays unloadable until eviction/reset. Relatedly, `/parsed` responses are stamped with the *frontend's* `PARSER_VERSION` (`formexApi.js:995`) instead of the `parserVersion` the backend actually reports, masking version skew during staggered deploys; and unknown-vintage envelopes are stamped current rather than discarded (:713-719).
**Fix:** validate before caching; propagate the backend-reported parser version into the envelope.

### M2. All four AI JSON caches have a lost-update race; recital titles also lack single-flight and atomic writes
Pattern in `law-summary-service.js:293-354`, `article-digest-service.js:208-240`, `case-law-digest-service.js:220-252`, `recital-title-service.js:162-188`: load whole file → await LLM (seconds) → save whole file. Two concurrent misses on *different* keys silently discard one paid-for result, which is then regenerated (and paid for) later. `recital-title-service.js` additionally predates the shared plumbing: no `makeSingleFlight` (N concurrent requests each pay the full batch) and a direct `writeFileSync` with no tmp+rename — a crash mid-write corrupts the cache file, which `loadCache` silently swallows, wiping every generated title.
**Fix:** merge-on-save (re-read + merge before write) or per-key files; port recital titles onto `ai-digest-utils` (single-flight + atomic save).

### M3. Cached digests still require a live Cellar round trip
`api-routes.js:530,583` call `fetchCaseLaw` unconditionally because `sourceHash` is computed before the cache check (unlike `/case-law`'s `resolutionCache` at :380-381). A Cellar outage 503s fully-cached digests, and a hiccup returning a partial case list changes the hash and silently regenerates the digest at LLM cost — overwriting good cache with one built from incomplete data.

### M4. Outbound-call timeout coverage is inconsistent
No service passes an abort signal to `chatComplete` (`openrouter-chat.js:66-76`) — a stalled OpenRouter stream holds the request open for minutes with no cancellation on client disconnect, while the model keeps billing. Both `fetchWithTimeout` helpers (`reference-utils.js:252-268`, `fmx-service.js:72-97`) clear the timeout once *headers* arrive, leaving `.text()`/`.arrayBuffer()` reads un-aborted, and `downloadFmx` buffers whole files with no size cap. (`eurlex-html-parser.js:1444-1512` does it correctly — clear in `finally` after `text()` — copy that pattern.)

### M5. Anonymous requests can force per-request headless-Chromium launches
`server.js:142-150,174-180` — during a WAF-challenge period any FMX-less CELEX launches Playwright Chromium, and pages that parse to no content are deliberately not cached, so every repeat request re-fetches: a repeatable CPU/memory DoS within the ordinary rate limit. Add a negative-result cache and a Chromium concurrency cap.

### M6. Prerender silently ships a gutted site if the API is down at build time
`scripts/generate-prerendered-law-pages.js:401-407` warns and falls back to `law.articles || 0` — but `FEATURED_LAWS` entries carry no counts, so the fallback is always 0: the build exits 0 having generated zero article/recital pages for the affected law, and the sitemap shrinks to match. Hundreds of indexed SEO pages vanish with no CI failure. **Fix:** fail the build (or require explicit fallback counts) when the API fetch fails.

### M7. Service-worker precache is computed before prerendering rewrites index.html
`package.json:11` runs `vite build` (which records `index.html`'s revision in the Workbox manifest) *before* the prerender script rewrites `dist/index.html`. A deploy changing only prerendered homepage content keeps serving the old cached homepage to returning PWA users until some asset hash also changes. Reorder, or exclude `index.html` from precache and revision it separately.

### M8. In-document search index is wiped and rebuilt on every LawViewer render
`LawViewer.jsx:319` passes an inline `lists={{ … }}` object; `TopBar.jsx:424-428` keys `setCurrentSearchIndex(null); setResults([])` on `[lists]` identity. Any re-render while the search modal is open (e.g. recital titles resolving) clears the user's live results mid-typing and rebuilds the TF-IDF index. **Fix:** `useMemo` the lists object.

### M9. Modals are inaccessible and global shortcuts stay live behind them
`CaseLawModal.jsx:207-277` and `PrintModal.jsx:23-38`: no `role="dialog"`/`aria-modal`, no focus trap, no focus restore, unlabeled close buttons; PrintModal has no Escape handler at all. Because `LawViewerQuickNavigation.jsx:16` only suppresses shortcuts when a `[role="dialog"]` exists, the role-less modals also leave j/k/arrow navigation (`useLawViewerInteractions.js:40-68`) silently navigating the law behind the modal.

### M10. `SQLITE_SCHEMA_VERSION` has an undocumented third copy
It lives in `legal-cache-store.js:17`, `build-sqlite-data.js:20`, **and** `citation-graph-store.js:9`, but the invalidation table in CLAUDE.md names only the first two. A bump that follows the docs leaves the citation-graph store rejecting the new `data.sqlite` and silently takes down all citation endpoints. Update the CLAUDE.md table (or import the constant from one module).

---

## Low

- **README quickstart is broken**: `README.md:68-73` omits `cd backend && npm install`; `npm run dev` then crashes and `scripts/dev.js:67-75` kills the Vite child too. Also Node-version drift: README/CLAUDE.md say v24+, `backend/package.json` says `>=22.12`, root has no `engines` at all (suite passes on v22).
- **Docs test-glob drift**: CLAUDE.md's backend test command omits `mcp/*.test.js`, which `backend/package.json` runs.
- **`mapChatError` forwards raw upstream detail/status** (`api-routes.js:37-70`) — minor provider-internals leak.
- **Analytics records invalid `:celex` path garbage** for non-5xx responses (`analytics.js:286-290`) — nuisance data in `/api/_stats`.
- **Dev/no-SQLite fallback re-parses the ~50 MB case-law seed per request** (`law-queries.js:238-241` bypasses the memo).
- **O(n²) identifier-repair pass** (`fmxParser.mjs:650-748`) and **O(recitals×articles) TF-IDF on the main thread** (`nlp.js:171-230`, only a 100 ms `setTimeout` defers it) — jank on large laws; a Web Worker + chunking would fix both.
- **HTML-parser title heuristic steals colon-terminated operative sentences** as `article_title` (`eurlex-html-parser.js:71-78`).
- **In-document search queries tokenize with English stop words regardless of law language** (`nlp.js:350` omits `langCode`).
- **Latent null push in supplemental SQLite records** (`legal-cache-store.js:526` misses the null guard the main loop has).
- **Prerender assumes contiguous numeric article numbering** (`generate-prerendered-law-pages.js:159-167`) — breaks for future laws with "Article 8a".
- **`pages.yml` duplicates the full lint+test+build that `ci.yml` already ran** on the same push — doubled CI minutes.
- **TopBar.jsx (1,596 lines) is the remaining monolith** — extract SearchBox + ToolsMenu (this is where M8 hid).

---

## Test-coverage gaps (highest untested risk first)

Coverage is genuinely good — fmxParser, nlp, search ranking, routes, CJEU parsing, all four AI services, SQLite parity, citation graph, and the extension are all tested (730+ tests green). The gaps:

1. `src/utils/formexApi.js` — only the IndexedDB connection lifecycle is tested; the three cache-version envelopes and network/fallback/migration logic (see M1) have none. This is exactly the "change silently doesn't take" risk CLAUDE.md flags.
2. `backend/shared/fmx-service.js` — FMX discovery/fetch/fallback, untested.
3. `backend/search/case-law-discover.js` — the live SPARQL half of case law, untested (offline halves are covered).
4. `backend/server.js` wiring, `shared/rate-limit.js`, `shared/eurlex-cookies.js`.

---

## What's healthy (verified, keep it that way)

- Input validation on CELEX/lang is strict before anything reaches SPARQL, file paths, or Cellar URLs; FTS5 expressions are whitelisted and all SQL parameterized — no injection paths found.
- Cache-version discipline is actually followed: recent parser commits each bumped `PARSER_VERSION`; `DATA_RELEASE_TAG=data-v11` matches the latest release commit; `CASE_LAW_CACHE_FILE`/`CASE_LAW_CACHE_VERSION` are in lock-step.
- AI output is rendered as React text (not HTML) and digests validate model output before caching.
- Both document hooks guard stale async results; search requests abort on supersession; URL-as-source-of-truth is respected.
- Extension permissions are minimal (`activeTab` only) and CI-enforced; prerender/sitemap derive from the app's own law list rather than a hardcoded copy.
