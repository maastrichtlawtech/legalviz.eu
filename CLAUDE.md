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

## Architecture

**Monorepo split**: `src/` (React frontend) and `backend/` (Express API + `eurlex` CLI) share one parser: `backend/shared/formex-parser/fmxParser.mjs`. The frontend imports it directly to parse Formex XML client-side when running against static/offline data; the backend uses the same module to serve parsed JSON over HTTP. Don't fork parsing logic between the two — fix it once in `backend/shared/formex-parser/`.

**Data flow**: given a CELEX id, the app fetches Formex XML from EUR-Lex (falling back to EUR-Lex HTML for laws without FMX), parses it into articles, chapters, recitals, definitions, annexes, and cross-references, then renders it. `src/utils/formexApi.js` is the frontend's client for the backend API (or direct EUR-Lex fetch, depending on mode). `src/utils/fmxParser.js` / `src/utils/parsers.js` wrap the shared parser for browser use.

**Search** is two distinct systems:
- Frontend: client-side inverted index / TF-IDF (`src/utils/nlp.js`) built from the currently loaded law, used to link recitals to relevant articles and power in-document search.
- Backend: a separate MiniSearch-based law lookup (`backend/search/`) over a locally cached metadata index of primary EU acts (regulations/directives/decisions only). Must be built manually before `/api/search` works: `npm --prefix backend run build:search-cache` (writes to `backend/search/data/`). Without a built cache, `/api/search` returns `503 search_cache_unavailable`. Ranking logic lives in `backend/search/search-ranking.js`, EUROVOC topic enrichment in `backend/search/fetch-eurovoc.js`.

**CJEU case law**: judgments are fetched via SPARQL and parsed from three distinct historical HTML/XML shapes (post-2004 EUR-Lex Formex, pre-2004 OJ HTML, older Curia HTML) into structured `articleRefs` so the viewer can show cases citing a given article. This parsing lives in `backend/` and is one of the more fragile/format-sensitive parts of the codebase.

**Optional AI features** (recital titles, static law overviews, per-article case-law digests, and a whole-law case-law digest) call OpenRouter only on cache misses — generated content is validated then cached to disk (`recital-title-cache-v1.json`, `law-summary-cache-v1.json`, `article-digest-cache-v1.json`, `case-law-digest-cache-v1.json`), each versioned with a source-content hash, model, and timestamp so cache invalidation is explicit. The case-law digests additionally fold the enrichment cache version (`case-law-cache-v4`) into their source hash so they regenerate when judgment parsing improves. The web app additionally mirrors recital titles into IndexedDB so a warm cache never triggers a network call to the endpoint. Key resolution order: feature-specific key (`RECITAL_TITLE_OPENROUTER_API_KEY`, `LAW_SUMMARY_OPENROUTER_API_KEY`, `ARTICLE_QA_OPENROUTER_API_KEY`) → `OPENROUTER_API_KEY` fallback. When touching these code paths, preserve the cache-validate-before-write pattern rather than writing raw model output.

**Routing/state**: the current reader position (law, article, recital, language) is synced to the URL (`src/utils/lawRouting.js`, `src/utils/url.js`) so every view is bookmarkable/shareable — treat URL state as the source of truth for navigation, not component state.

**`extension/`** is a separate Chrome/Firefox browser extension package, not built by the root `npm run build`.

**`scripts/`** contains build-time Node scripts (prerendering law pages, sitemap generation, 404 copy, `dev.js` which runs frontend + backend concurrently) — not application code.
