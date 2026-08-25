# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Frontend-only notes (React + Vite). The root [AGENTS.md](../AGENTS.md) has the monorepo picture and the cross-cutting **cache-version table** (bump these when you change cached output).

## Commands (run from repo root)

```bash
npm run dev:web               # Vite only (:5173); `npm run dev` also starts the API
npm run test:web              # vitest run
npm run test:watch            # vitest watch
npm run build                 # vite build + copy-404 + prerender featured law pages + sitemap
```

Single test file: `npx vitest run src/utils/nlp.test.js`.

## Architecture notes

- **URL is the source of truth for navigation.** Reader position (law, article, recital, language) is synced to the URL via `src/utils/lawRouting.js` / `src/utils/url.js` so every view is bookmarkable/shareable. Read navigation state from the URL, don't hold it in component state.
- **Parsing is not forked here.** `src/utils/fmxParser.js` / `src/utils/parsers.js` wrap the shared backend parser (`backend/shared/formex-parser/fmxParser.mjs`) for the browser. Fix parser bugs in `backend/shared/`, not in `src/`.
- **`src/utils/formexApi.js`** is the single client for law data — it talks to the backend API or fetches EUR-Lex directly depending on mode, and owns the IndexedDB (`formex-cache`) layer plus the cache envelopes (parsed laws, recital titles, API JSON).
- **`src/utils/nlp.js`** is the client-side TF‑IDF / inverted index that maps recitals→articles and powers in-document search. It is built from the currently loaded law only; results are cached in localStorage under `nlp_v<NLP_VERSION>_…`.
- **Client-side storage** spans IndexedDB (parsed laws, recital titles) and localStorage (NLP maps, theme, migration marker). `src/utils/resetApp.js` clears it all; its `CURRENT_MIGRATION_VERSION` triggers a one-time wipe for every client on deploy.

## Bumping caches

Any change to parser output, a cached payload shape, or the NLP algorithm needs a version bump — see the frontend half of the cache table in the root [AGENTS.md](../AGENTS.md). Note that `PARSER_VERSION` is defined in the backend parser but consumed here, so a parser change re-parses the browser cache automatically.
