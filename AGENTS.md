# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                 # frontend deps (also run `cd backend && npm install`)
npm run dev                  # frontend (Vite, :5173) + API concurrently via scripts/dev.js
npm run dev:web              # frontend only
npm run dev:api              # backend API only (node backend/server.js)
npm run dev:api:watch        # backend API with --watch

npm run lint                  # eslint .
npm run build                 # vite build + copy-404 + prerender law pages + sitemap

npm test                      # test:web (vitest) + test:api (node --test)
npm run test:web              # frontend unit tests (vitest run)
npm run test:watch            # vitest watch mode
npm run test:api              # backend tests: node --test search/*.test.js shared/*.test.js routes/*.test.js bin/*.test.js mcp/*.test.js (run from backend/)
```

Single test file (frontend, vitest): `npx vitest run src/utils/nlp.test.js`
Single test file (backend, node:test): `cd backend && node --test search/search-ranking.test.js`

The fmxParser.test.js is a vitest test (not part of the backend node:test glob).

Backend CLI (`eurlex`) commands are documented in [backend/README.md](backend/README.md); run via `npx eurlex <command>` from `backend/` after `npm install`.

The production API is live at `https://api.legalviz.eu` — useful for checking what the deployed parser/search actually returns without building the local data caches, e.g. `curl -s https://api.legalviz.eu/api/laws/32016R0679/parsed`. Routes are defined in [backend/routes/api-routes.js](backend/routes/api-routes.js). It is read-only from your side: never treat it as a place to write or mutate state, and remember it serves *deployed* code and *published* caches, so it can lag local changes (see [Cache & version invalidation](#cache--version-invalidation)).

Requires Node.js v22.12+ (`engines` in root and backend `package.json`; the backend needs require(esm), unflagged since 22.12).

Subtree-specific guidance lives in nested agent files: [backend/AGENTS.md](backend/AGENTS.md) (API, CLI, MCP, AI services) and [src/AGENTS.md](src/AGENTS.md) (React frontend). Keep this root file for cross-cutting concerns; push backend-only or frontend-only detail down into those.

## Architecture

**Monorepo split**: `src/` (React frontend) and `backend/` (Express API + `eurlex` CLI) share one parser: `backend/shared/formex-parser/fmxParser.mjs`. The frontend imports it directly to parse Formex XML client-side when running against static/offline data; the backend uses the same module to serve parsed JSON over HTTP. Don't fork parsing logic between the two — fix it once in `backend/shared/formex-parser/`.

**Data flow**: given a CELEX id, the app fetches Formex XML from EUR-Lex (falling back to EUR-Lex HTML for laws without FMX), parses it into articles, chapters, recitals, definitions, annexes, and cross-references, then renders it. `src/utils/formexApi.js` is the frontend's client for the backend API (or direct EUR-Lex fetch, depending on mode). `src/utils/fmxParser.js` / `src/utils/parsers.js` wrap the shared parser for browser use.

**Search** is two distinct systems that share nothing — don't conflate them: the frontend's client-side inverted index / TF-IDF (`src/utils/nlp.js`), built from the currently loaded law to link recitals to articles and power in-document search; and a separate backend title/alias MiniSearch plus SQLite FTS5 excerpt lookup (`backend/search/`) over primary acts, exposed at `/api/search`. The backend data must be built manually (steps and behavior in [backend/AGENTS.md](backend/AGENTS.md)).

**CJEU case law**: judgments are discovered live via SPARQL, while names, rulings, and structured `articleRefs` come from the read-only precomputed data store. The offline pipeline parses three historical HTML/XML shapes (post-2004 EUR-Lex Formex, pre-2004 OJ HTML, older Curia HTML). This parsing lives in `backend/` and is one of the more fragile/format-sensitive parts of the codebase.

**Optional AI features** (recital titles, static law overviews, per-article and whole-law case-law digests) call OpenRouter only on cache misses, and every result is versioned (see [Cache & version invalidation](#cache--version-invalidation)). The web app mirrors recital titles into IndexedDB so a warm cache never hits the endpoint. Cache-write discipline, prompts, and API-key resolution live in [backend/AGENTS.md](backend/AGENTS.md).

**Routing/state**: the current reader position (law, article, recital, language) is synced to the URL (`src/utils/lawRouting.js`, `src/utils/url.js`) so every view is bookmarkable/shareable — treat URL state as the source of truth for navigation, not component state.

**`extension/`** is a small Chrome/Firefox launcher package, not built by the root `npm run build`. It sends the current EUR-Lex URL through the app's general `/import` flow when the user clicks its icon.

**`scripts/`** contains build-time Node scripts (prerendering law pages, sitemap generation, 404 copy, `dev.js` which runs frontend + backend concurrently) — not application code.

## Cache & version invalidation

Nearly every expensive operation — Formex parsing, TF‑IDF recital mapping, CJEU enrichment, and the LLM features — is cached, and each cache is guarded by a **hand-maintained version constant**. The model id and source content are folded into a hash so those self-invalidate, but a *code* change (parser output, prompt wording, JSON schema, algorithm) does **not** — you must bump the constant yourself or the stale result is served indefinitely. Forgetting this is the most common way a change silently "doesn't take". When you touch any of the code below, bump the paired constant in the same commit.

**Backend, on-disk** (written under `CACHE_DIR`, default `backend/law-cache`):

| When you change… | Bump | In |
|---|---|---|
| Parser output (fields, shape, bug fix) — **either** parser, see below | `PARSER_VERSION` | `backend/shared/formex-parser/fmxParser.mjs` |
| Citation graph edge/artifact shape | `GRAPH_VERSION` | `backend/search/citation-graph-store.js` (shared by builder and store) |
| Offline CJEU detail shape (declarations, `articleRefs`) | `CASE_LAW_CACHE_FILE` → `case-law-cache-vN.json` (keep the offline legacy-migration path) | `backend/shared/law-queries.js` |
| Recital-title prompt/output format | `CACHE_VERSION` | `backend/shared/recital-title-service.js` |
| Law-summary cache / JSON schema / prompt | `cacheVersion` / `schemaVersion` / `promptVersion` | `backend/shared/law-summary-cache-version.json` (shared by backend and frontend) |
| Article-digest JSON schema / prompt | `articleDigest.schemaVersion` / `promptVersion` | `backend/shared/digest-cache-version.json` (shared by backend and frontend) |
| Whole-law digest JSON schema / prompt | `caseLawDigest.schemaVersion` / `promptVersion` | `backend/shared/digest-cache-version.json` (shared by backend and frontend) |
| Persisted analytics shape (`analytics.json` fields) | `ANALYTICS_SCHEMA_VERSION` | `backend/shared/analytics.js` |
| Runtime SQLite tables/indexes | `SQLITE_SCHEMA_VERSION` | `backend/search/legal-cache-store.js`, `backend/search/build-sqlite-data.js`, and `backend/search/citation-graph-store.js` (three copies, kept in lock-step) |
| Full-text `units` schema / builder output shape | `FULLTEXT_SCHEMA_VERSION` | `backend/search/fulltext-index-build.js`, with a lock-step copy in `backend/search/legal-cache-store.js` |
| Precomputed data republished as a new GitHub Release | `DATA_RELEASE_TAG` → `data-YYYY-MM-DD.NN` | `backend/Dockerfile` |
| Full-text index republished as a new GitHub Release | `FULLTEXT_RELEASE_TAG` → `fulltext-YYYY-MM-DD.NN` | `backend/Dockerfile` |

The data caches are the one entry above that isn't a code constant: they ship as **GitHub Release assets** (they're far too large to commit), so republishing them means creating a new data release **and** bumping `DATA_RELEASE_TAG` in `backend/Dockerfile` in the same commit. Skip the bump and every deploy keeps fetching the old data no matter what you rebuilt. The Dockerfile fetches **every** asset from that one tag, so a new release must carry the full set — re-upload the unchanged ones alongside the changed one, or the Docker build 404s. Every release asset is compressed: the built `data.sqlite` ships as **`data.sqlite.gz`** (~280 MB → ~4x smaller) beside its uncompressed `data.sqlite.manifest.json`, which still describes the *unzipped* file. Docker never fetches it — it rebuilds the DB from the `*.json.gz` inputs — so it exists for recovery and inspection. The corpus `*.tar` archives stay uncompressed on purpose: their members are already gzipped.

Release tags are **dated**: `<train>-YYYY-MM-DD.NN`, where the date is the UTC day and `NN` is a zero-padded same-day sequence starting at `01` (`data-2026-08-21.02`). Two runs on the same day therefore never collide on a tag — the old `<train>-vN` counter was derived from the Dockerfile pin, so a second run starting before the tag-bump PR merged recomputed the *same* tag and refused to publish its fresher data. `.github/scripts/release-tags.sh` owns that grammar (`validate` / `latest` / `resolve`) for all three workflows and still accepts the legacy `<train>-vN` tags on the releases that already carry them; it is never minted again. Asset filenames stay stable and undated, so the Dockerfile keeps one hand-maintained constant per train.

The full-text index follows the same republish discipline as the data caches — a new fulltext release **and** bumping `FULLTEXT_RELEASE_TAG` in `backend/Dockerfile` in the same commit, or the deploy keeps fetching the old index. Unlike the data caches, it ships on its **own** tag with a single asset (`fulltext.sqlite.gz`), decoupled from the data train — republishing the fulltext index never requires re-uploading the data assets, and vice versa. It is optional at boot: an absent, unreadable, or version-mismatched file leaves `fulltextAvailable = false` and `/api/search` degrades silently, the same non-fatal pattern as `definitionsAvailable` and the citation graph.

`PARSER_VERSION` lives in the Formex parser but versions **both** parsers' output. `eurlex-html-parser.js` reads a different document format, yet imports its cross-reference grammar (`extractCrossRefsFromText` and friends) straight from `fmxParser.mjs`, and its definition grammar (`buildMeansRegex` and the other term/definition regex builders) from `formex-parser/languages.mjs` — so a change in either changes what HTML laws yield too, and both parsers stamp the same constant onto their result. Bump it for a fix in *any* of the three files; there is deliberately no second constant to keep in sync.

`PARSER_VERSION` is **shared with the frontend** (imported into `src/utils/formexApi.js`), so bumping it re-parses the browser IndexedDB cache too. When you bump `CASE_LAW_CACHE_FILE`, also update `caseLawCacheVersion` in `backend/shared/digest-cache-version.json` — both digest services import it from there, so they can never drift and digests regenerate when enrichment shape changes.

The law-summary cache versions are also shared with the frontend through `backend/shared/law-summary-cache-version.json`. `fetchLawSummary` includes all three values in its IndexedDB key, so bumping any backend summary cache/schema/prompt version makes browsers fetch the regenerated summary immediately after loading the updated frontend.

The article and whole-law digest versions are shared with the frontend the same way through `backend/shared/digest-cache-version.json`: `fetchArticleCaseLawDigest` / `fetchCaseLawDigest` fold each feature's `schemaVersion`/`promptVersion` pair into their IndexedDB keys (and validate the `caseLawCacheVersion` stamp), so a backend digest prompt/schema bump stops browsers serving the stale 7-day-cached copy.

**Frontend, browser** (`src/`):

| When you change… | Bump | In |
|---|---|---|
| Recital→article NLP algorithm | `NLP_VERSION` | `src/utils/nlp.js` (localStorage keys are `nlp_v<N>_…`) |
| IndexedDB store shape (DB `formex-cache`) | `CACHE_VERSION` | `src/utils/formexApi.js` |
| Cached recital-title envelope shape | `RECITAL_TITLE_CACHE_VERSION` | `src/utils/formexApi.js` |
| Cached API-JSON payload shape | `API_JSON_CACHE_VERSION` | `src/utils/formexApi.js` |
| Cached law-summary output | Shared law-summary versions | `backend/shared/law-summary-cache-version.json` |
| Force every client to wipe local data once | `CURRENT_MIGRATION_VERSION` | `src/utils/resetApp.js` |
