# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Backend-only notes. The root [CLAUDE.md](../CLAUDE.md) has the monorepo picture and the cross-cutting **cache-version table** (bump these when you change cached output). [backend/README.md](README.md) documents every CLI command, API endpoint, MCP tool, and environment variable in full — read it before adding or changing routes/commands.

## Commands (run from `backend/`)

```bash
npm start                     # API server on :3000 (or $PORT)
npm run dev                   # API with --watch (auto-restart)
npm test                      # node --test search/*.test.js shared/*.test.js routes/*.test.js bin/*.test.js
npm run test:search           # search tests only
npm run build:search-cache    # build the MiniSearch metadata cache into search/data/
npx eurlex <command>          # CLI (or `npm link` once, then `eurlex …`)
```

Single test file: `node --test search/search-ranking.test.js`.

The search cache is loaded **once at server startup**, so restart the API after `build:search-cache`. Until it exists, `/api/search` returns `503 search_cache_unavailable`.

## What lives where

- **`shared/`** is imported by both the frontend and the CLI. The Formex parser (`shared/formex-parser/fmxParser.mjs`) runs in the browser, so keep it dependency-light and free of Node-only APIs; `shared/fmx-parser-node.js` is the Node wrapper. Fix parsing bugs here once — never fork them into `src/`.
- **AI services** — `recital-title-service.js`, `law-summary-service.js`, `article-digest-service.js`, `case-law-digest-service.js` — all follow one shape: clip source → hash → single-flight → **validate model output → then write cache** (never cache raw output). Zero-result digests are cached without an LLM call. The summary and two digest services share plumbing in `shared/ai-digest-utils.js` (text clipping, hashing, single-flight, cache read/write, citation grounding); `recital-title-service.js` predates it and keeps its own copy.
- **API-key resolution** is layered: feature-specific key → `OPENROUTER_API_KEY`. The `ARTICLE_QA_*` env vars are legacy fallbacks still wired into summaries/digests even though the Q&A prototype itself was removed (see [../docs/article-qa-plan.md](../docs/article-qa-plan.md)).
- **CJEU case-law parsing** (`shared/case-law-parser.js`, `shared/law-queries.js`) handles three historical shapes (post-2004 EUR-Lex Formex, pre-2004 OJ HTML, older Curia HTML) into structured `articleRefs`. This is the most format-fragile code in the repo; changing its output shape means bumping `CASE_LAW_CACHE_FILE` (see the root cache table).

## Search-cache build & the raw-law corpus

`search/search-build.js` builds `data/search-cache.json` (the MiniSearch metadata index): harvest primary `reg|dir|dec` acts via SPARQL, then enrich each with an official title and an **excerpt** (recitals + Article 1/2 + definitions vocabulary, `buildExcerptFromCombined`, indexed with `EXCERPT_BOOST` in `legal-cache-store.js`). `findFmx4Uri` accepts every CELLAR FMX URL shape — post-2016 `/oj/L_<9digits>`, pre-2016 `/oj/JOL_<year>_…_<NN>`, and the `/celex/<CELEX>` form; narrowing it silently drops pre-2016 coverage.

- **Raw-law corpus** (`search/law-corpus-store.js`): every fetched source is gzipped to `data/laws/<year>/<CELEX>.xml.gz` (FMX) or `data/laws-html/<year>/<CELEX>.html.gz` (EUR-Lex HTML). Enrichment is **corpus-first** — read the local copy, only hit the network on a miss — so re-runs, wider year ranges, and future parser fixes are **offline with no re-scraping**. The corpus is build-time only and **gitignored**. The derived search cache is **not committed either** — as **`search-cache.json.gz`** (~48 MB) it would bloat git history, so it ships as a **GitHub Release asset** fetched at Docker build time into `data/` (see `backend/Dockerfile`, `DATA_RELEASE_TAG`); the store gunzips it at startup when the raw file is absent, and a local rebuild still wins. The case-law cache (`case-law-cache-v5.json.gz`) and the reverse-citation graph (`citation-graph.json.gz`, built by `search/citation-graph-build.js` over the same corpus) ride the same Release-asset flow — add any new derived cache to the `DATA_RELEASE_TAG` release and the Dockerfile fetch loop rather than committing it.
- **FMX-less acts** (mostly pre-2000 — no Formex exists) are downloaded as raw HTML by `search/html-harvest.js`. It does **not** open pages in Chromium: `shared/eurlex-cookies.js` warms the WAF/Cloudflare cookies **once** with a headless browser, then all downloads go over plain `fetch` with those cookies (re-warm only on a 202 challenge) — the same pattern as `law-queries.js`. The parser for that HTML is `shared/eurlex-html-parser.js` (`parseStructuredHtmlToCombined`), which emits the same combined shape `buildExcerptFromCombined` consumes.
- Long unattended harvests: requests go through `requestWithRetry` (WAF 202 + 429/5xx + network backoff); the enrich process has a slow memory growth, so bulk runs recycle the node process every N records (`--maxRecords`) rather than run one long process.

## Gotchas

- SPARQL queries (`shared/law-queries.js`) take user-supplied CELEX ids and language codes — these are validated/escaped to prevent injection. Keep new queries parameterized; don't string-concat untrusted input.
- Rate limiting, cache eviction (`STORAGE_LIMIT_MB` / `HTML_CACHE_LIMIT_MB`), and timeouts are all env-configurable — see the Environment Variables table in the README before hard-coding limits.
