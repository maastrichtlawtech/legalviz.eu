# CLAUDE.md

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
npm run test:api              # backend tests: node --test search/*.test.js shared/*.test.js routes/*.test.js bin/*.test.js (run from backend/)
```

Single test file (frontend, vitest): `npx vitest run src/utils/nlp.test.js`
Single test file (backend, node:test): `cd backend && node --test search/search-ranking.test.js`

Backend CLI (`eurlex`) commands are documented in [backend/README.md](backend/README.md); run via `npx eurlex <command>` from `backend/` after `npm install`.

Requires Node.js v24+.

Subtree-specific guidance lives in nested memory files that Claude Code loads on demand when you work in them: [backend/CLAUDE.md](backend/CLAUDE.md) (API, CLI, MCP, AI services) and [src/CLAUDE.md](src/CLAUDE.md) (React frontend). Keep this root file for cross-cutting concerns; push backend-only or frontend-only detail down into those.

## Architecture

**Monorepo split**: `src/` (React frontend) and `backend/` (Express API + `eurlex` CLI) share one parser: `backend/shared/formex-parser/fmxParser.mjs`. The frontend imports it directly to parse Formex XML client-side when running against static/offline data; the backend uses the same module to serve parsed JSON over HTTP. Don't fork parsing logic between the two — fix it once in `backend/shared/formex-parser/`.

**Data flow**: given a CELEX id, the app fetches Formex XML from EUR-Lex (falling back to EUR-Lex HTML for laws without FMX), parses it into articles, chapters, recitals, definitions, annexes, and cross-references, then renders it. `src/utils/formexApi.js` is the frontend's client for the backend API (or direct EUR-Lex fetch, depending on mode). `src/utils/fmxParser.js` / `src/utils/parsers.js` wrap the shared parser for browser use.

**Search** is two distinct systems that share nothing — don't conflate them: the frontend's client-side inverted index / TF-IDF (`src/utils/nlp.js`), built from the currently loaded law to link recitals to articles and power in-document search; and a separate backend MiniSearch lookup (`backend/search/`) over a cached metadata index of primary acts, exposed at `/api/search`. The backend cache must be built manually (steps and behavior in [backend/CLAUDE.md](backend/CLAUDE.md)).

**CJEU case law**: judgments are fetched via SPARQL and parsed from three distinct historical HTML/XML shapes (post-2004 EUR-Lex Formex, pre-2004 OJ HTML, older Curia HTML) into structured `articleRefs` so the viewer can show cases citing a given article. This parsing lives in `backend/` and is one of the more fragile/format-sensitive parts of the codebase.

**Optional AI features** (recital titles, static law overviews, per-article and whole-law case-law digests) call OpenRouter only on cache misses, and every result is versioned (see [Cache & version invalidation](#cache--version-invalidation)). The web app mirrors recital titles into IndexedDB so a warm cache never hits the endpoint. Cache-write discipline, prompts, and API-key resolution live in [backend/CLAUDE.md](backend/CLAUDE.md).

**Routing/state**: the current reader position (law, article, recital, language) is synced to the URL (`src/utils/lawRouting.js`, `src/utils/url.js`) so every view is bookmarkable/shareable — treat URL state as the source of truth for navigation, not component state.

**`extension/`** is a separate Chrome/Firefox browser extension package, not built by the root `npm run build`.

**`scripts/`** contains build-time Node scripts (prerendering law pages, sitemap generation, 404 copy, `dev.js` which runs frontend + backend concurrently) — not application code.

## Cache & version invalidation

Nearly every expensive operation — Formex parsing, TF‑IDF recital mapping, CJEU enrichment, and the LLM features — is cached, and each cache is guarded by a **hand-maintained version constant**. The model id and source content are folded into a hash so those self-invalidate, but a *code* change (parser output, prompt wording, JSON schema, algorithm) does **not** — you must bump the constant yourself or the stale result is served indefinitely. Forgetting this is the most common way a change silently "doesn't take". When you touch any of the code below, bump the paired constant in the same commit.

**Backend, on-disk** (written under `CACHE_DIR`, default `backend/law-cache`):

| When you change… | Bump | In |
|---|---|---|
| Parser output (fields, shape, bug fix) | `PARSER_VERSION` | `backend/shared/formex-parser/fmxParser.mjs` |
| Citation graph edge/artifact shape | `GRAPH_VERSION` | `backend/search/citation-graph-build.js` |
| CJEU enrichment shape (declarations, `articleRefs`) | `CASE_LAW_CACHE_FILE` → `case-law-cache-vN.json` (keep the legacy-migration path) | `backend/shared/law-queries.js` |
| Recital-title prompt/output format | `CACHE_VERSION` | `backend/shared/recital-title-service.js` |
| Law-summary JSON schema / prompt | `SCHEMA_VERSION` / `PROMPT_VERSION` | `backend/shared/law-summary-service.js` |
| Article-digest JSON schema / prompt | `SCHEMA_VERSION` / `PROMPT_VERSION` | `backend/shared/article-digest-service.js` |
| Whole-law digest JSON schema / prompt | `SCHEMA_VERSION` / `PROMPT_VERSION` | `backend/shared/case-law-digest-service.js` |

`PARSER_VERSION` is **shared with the frontend** (imported into `src/utils/formexApi.js`), so bumping it re-parses the browser IndexedDB cache too. When you bump `CASE_LAW_CACHE_FILE`, also update `CASE_LAW_CACHE_VERSION` in `article-digest-service.js` **and** `case-law-digest-service.js` — they are kept in lock-step so digests regenerate when enrichment shape changes.

**Frontend, browser** (`src/`):

| When you change… | Bump | In |
|---|---|---|
| Recital→article NLP algorithm | `NLP_VERSION` | `src/utils/nlp.js` (localStorage keys are `nlp_v<N>_…`) |
| IndexedDB store shape (DB `formex-cache`) | `CACHE_VERSION` | `src/utils/formexApi.js` |
| Cached recital-title envelope shape | `RECITAL_TITLE_CACHE_VERSION` | `src/utils/formexApi.js` |
| Cached API-JSON payload shape | `API_JSON_CACHE_VERSION` | `src/utils/formexApi.js` |
| Force every client to wipe local data once | `CURRENT_MIGRATION_VERSION` | `src/utils/resetApp.js` |
