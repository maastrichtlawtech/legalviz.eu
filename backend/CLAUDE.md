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
npm run build:sqlite-data     # convert search + case-law JSON into the runtime SQLite store
npx eurlex <command>          # CLI (or `npm link` once, then `eurlex …`)
```

Single test file: `node --test search/search-ranking.test.js`.

The data store is loaded **once at server startup**, so restart the API after rebuilding it. Production prefers read-only `search/data/data.sqlite`; an explicit `DATA_SQLITE_PATH` is strict. JSON remains the local/fixture fallback. Until either source exists, `/api/search` returns `503 search_cache_unavailable`.

## What lives where

- **`shared/`** is imported by both the frontend and the CLI. The Formex parser (`shared/formex-parser/fmxParser.mjs`) runs in the browser, so keep it dependency-light and free of Node-only APIs; `shared/fmx-parser-node.js` is the Node wrapper. Fix parsing bugs here once — never fork them into `src/`.
  - Anything the parser imports must be **ESM with named exports**, since it reaches the browser (`src/utils/fmxParser.js` re-exports it). Vite's dev server serves these source files untransformed, so a CommonJS `module.exports` dependency is unresolvable in the browser — and `npm run build` will **not** catch it, because Rollup's commonjs plugin converts CJS at build time. That failure only appears in `npm run dev`, so exercise a law page there after touching the parser's imports. `shared/legal-reference-core.mjs` is the shared-with-CommonJS case: backend callers `require()` it through Node's require(esm) (hence `engines: >=22.12`), which is also why its exports stay named — a default export would reach them as `.default`.
- **AI services** — `recital-title-service.js`, `law-summary-service.js`, `article-digest-service.js`, `case-law-digest-service.js` — all follow one shape: clip source → hash → single-flight → **validate model output → then write cache** (never cache raw output). Zero-result digests are cached without an LLM call. The summary and two digest services share plumbing in `shared/ai-digest-utils.js` (text clipping, hashing, single-flight, cache read/write, citation grounding); `recital-title-service.js` predates it and keeps its own copy.
- **API-key resolution** is layered: feature-specific key → `OPENROUTER_API_KEY`. The `ARTICLE_QA_*` env vars are legacy fallbacks still wired into summaries/digests even though the Q&A prototype itself was removed (see [../docs/article-qa-plan.md](../docs/article-qa-plan.md)).
- **CJEU case-law parsing** (`shared/case-law-parser.js`, `shared/law-queries.js`) handles three historical shapes (post-2004 EUR-Lex Formex, pre-2004 OJ HTML, older Curia HTML) into structured `articleRefs`. Parsing and cache writes happen only offline; runtime is live SPARQL discovery plus read-only precomputed details. This is the most format-fragile code in the repo; changing its output shape means bumping `CASE_LAW_CACHE_FILE` (see the root cache table).

## Search-cache build & the raw-law corpus

`search/search-build.js` builds `data/search-cache.json`: harvest primary `reg|dir|dec` acts via SPARQL, then enrich each with an official title and an **excerpt** (recitals + Article 1/2 + definitions vocabulary, `buildExcerptFromCombined`). `build-sqlite-data.js` splits that asset into in-memory title/alias records plus a disk-backed FTS5 excerpt index and folds in precomputed case-law details. `findFmx4Uri` accepts every CELLAR FMX URL shape — post-2016 `/oj/L_<9digits>`, pre-2016 `/oj/JOL_<year>_…_<NN>`, and the `/celex/<CELEX>` form; narrowing it silently drops pre-2016 coverage.

- **Raw-law corpus** (`search/law-corpus-store.js`): every fetched source is gzipped to `data/laws/<year>/<CELEX>.xml.gz` (FMX) or `data/laws-html/<year>/<CELEX>.html.gz` (EUR-Lex HTML). Enrichment is **corpus-first** — read the local copy, only hit the network on a miss — so re-runs, wider year ranges, and future parser fixes are **offline with no re-scraping**. The corpus is build-time only and **gitignored**. Derived JSON caches ship as release assets; Docker converts them into one `data.sqlite`, and production never parses the large JSON blobs at startup.
- **Metadata not in the corpus**: `date` and `eurovoc` are SPARQL metadata the on-disk source doesn't carry, so the offline rebuild can't reconstruct them. `date` is persisted at harvest time to `data/law-dates.json` (`law-corpus-dates.js`) and overlaid by `build-cache-from-corpus.js`; `eurovoc` comes from `search/eurovoc-enrich.js`, which runs as the **last step of both builders** and journals to `data/eurovoc.json`. Both files are gitignored build-time artifacts; from **`data-v6`** on their contents ship **inside** the release asset and `legal-cache-store.js` reads both straight off the record, merging nothing at startup. **Keep enrichment part of the build.** Topics are CELEX-keyed, so a pass bolted on afterwards gets generated against one cache and served alongside another — every record it never saw silently serves empty topics, and nothing errors. That is exactly how the `data-v5` corpus expansion left ~83% of records topic-less. It's best-effort (a Cellar outage ships the cache without topics rather than discarding a multi-hour harvest) and opt-out via `--no-eurovoc`, which also restores a network-free corpus build — enrichment runs in the driver, and the parse workers keep their hard `fetch` block regardless. `search/fetch-eurovoc.js` backfills an existing cache without a rebuild; it is not the primary path.
- **FMX-less acts** (mostly pre-2000 — no Formex exists) are downloaded as raw HTML by `search/html-harvest.js`. It does **not** open pages in Chromium: `shared/eurlex-cookies.js` warms the WAF/Cloudflare cookies **once** with a headless browser, then all downloads go over plain `fetch` with those cookies (re-warm only on a 202 challenge). The parser for that HTML is `shared/eurlex-html-parser.js` (`parseStructuredHtmlToCombined`), which emits the same combined shape `buildExcerptFromCombined` consumes.
- Long unattended harvests: requests go through `requestWithRetry` (WAF 202 + 429/5xx + network backoff); the enrich process has a slow memory growth, so bulk runs recycle the node process every N records (`--maxRecords`) rather than run one long process.

## Gotchas

- SPARQL queries (`shared/law-queries.js`) take user-supplied CELEX ids and language codes — these are validated/escaped to prevent injection. Keep new queries parameterized; don't string-concat untrusted input.
- Rate limiting, cache eviction (`STORAGE_LIMIT_MB` / `HTML_CACHE_LIMIT_MB`), and timeouts are all env-configurable — see the Environment Variables table in the README before hard-coding limits.
