# Full-text search for the API & MCP — implementation plan

**Status: decided — see the decision log below. The ⚖️ sections are kept for the rationale.**

## Decision log (2026-08-18)

- **D1 — Ship the endpoint directly.** Phases 0 and 1 merge into one build-and-ship effort. The
  builder, recall eval, and size/latency measurements are still part of the work (the size number
  still gates D4's fallback), but they are no longer a go/no-go gate before user-facing code.
- **D2 — Articles + recitals.** Annexes stay out of v1.
- **D3 — Option 1**: external-content FTS5 (`content='units'`, `detail=full`), text stored
  uncompressed, native `snippet()`/`highlight()`. Artifact size is explicitly not a concern.
- **D4 — GitHub Release asset baked into the Docker image**, provided the artifact isn't too
  large (hard cap: 2 GiB/asset; soft cap: deploy-time/image-size tolerance). If the measured size
  breaks that, fall back to option B (Railway volume + download-at-boot) — decide then.
- **D5 — Separate `/api/fulltext-search` only.** No MCP tool for now; `search_law_text` is
  deferred until the endpoint has proven itself.
- **D6 — English-only.**
- **D7 — Stay lexical.** Embedding the corpus is cheap on the API side (order of tens of dollars
  one-off at current per-token embedding prices; see note in the D7 section) — the real cost is
  serving: a vector index over 1–3M units means gigabytes of vectors plus ANN infrastructure and
  a per-query embedding call, and #126 showed no measurable win from semantic signal on this eval
  set. The `units` table is kept embedding-ready so this can be revisited with evidence.

## Why

The API and MCP server are now a product surface (#134 put MCP on the landing page), but neither
can answer "which EU law says X" when X lives in the body of an act. Issue #137 documents the gap
precisely: the existing FTS5 index (`law_excerpts`) holds **at most ~3 KB per act** — Articles 1–2,
definitions vocabulary, and recitals under hard budgets — is **contentless** (cannot return
snippets), and is **law-level** (cannot say *where* a match occurred). For the GDPR, Articles 3–99
contribute nothing to retrieval. An AI agent using `search_eu_law` today can only find laws whose
*title, alias, EuroVoc label, or first two articles* match; everything else fails silently.

Full-text search fixes the recall problem lexically, offline, deterministically, with no external
API and no per-query spend — and it gives MCP clients the retrieval primitive they most need:
*query → (CELEX, article, snippet)*, which composes directly with the existing `get_law_part` tool.

## Prior art this plan builds on

- **#137 (open issue)** — the article-level FTS5 probe proposal. This plan adopts it as Phase 0
  and extends it with the production phases.
- **#125** — ranking eval harness (`search/eval/`, 100 graded queries, nDCG@10, holdout
  discipline). Reused for the recall evaluation and for any ranking integration.
- **#126 (open PR)** — embeddings reranking over the lexical candidate pool. Inconclusive holdout;
  reranking cannot fix recall. This plan stays lexical-first (see decision D7).
- **#41 (closed PR)** — a zero-dependency S3-compatible cache provider (AWS SigV4, env-var
  activated). Relevant to decision D4 as a distribution/backup channel for large artifacts;
  revivable as a small standalone module if D4 lands on an object-storage option.
- **Citation graph** (`citation-graph-store.js`) — the precedent for an *optional, separately
  shipped* derived artifact with 503-when-absent routes. The full-text index follows the same
  pattern.

## Current architecture facts that constrain the design

- The runtime store `search/data/data.sqlite` is built in the Docker image from GitHub Release
  assets (`DATA_RELEASE_TAG`, currently `data-v11`) and loaded once at startup. In-memory
  MiniSearch records already push the RAM floor to ~1.5 GiB; FTS5 is disk-backed and does not
  compete for that budget.
- The raw corpus (`search/data/laws/`, `laws-html/`, gzipped per act) is build-time only,
  gitignored, and **corpus-first**: full-text indexing needs **no re-scraping**.
- Both parsers emit the same combined shape; article text is derivable from `article_html` via
  the existing `stripXmlTags` (`search-build.js`) or the MCP server's `htmlToText`.
- The corpus is **English-only** by construction (every harvest stage filters ENG), which settles
  the v1 language question (D6).
- GitHub Release assets are capped at **2 GiB per file** — a real constraint for a full-text
  artifact, which is one to two orders of magnitude larger than today's assets (~48 MB).

---

## Phase 0 — Offline probe (adopt #137 essentially as written)

Goal: measure index size, query latency, and recall delta before committing to anything
user-facing. Standalone gitignored artifact `search/data/fulltext.sqlite`; no changes to
`data.sqlite`, `SQLITE_SCHEMA_VERSION`, `searchLaws` ranking, the Dockerfile, or the frontend.

1. **Builder** — `search/fulltext-index-build.js` + worker, cloning the
   `definition-index-build.js` scaffold (worker-per-batch, recursive split on parse failure,
   resumable journal). Reuses `listAllCorpusFiles` / `filterCorpusFiles` / `dedupeCorpusFiles` /
   `stripCompleteUppercaseAnnexes`; exports `stripXmlTags` from `search-build.js` (one line).
   One unit row per **article** and per **recital** (annexes excluded in v1 — see D2).
2. **Schema** — a `units` table (celex, unit_type, number, heading, char_count, text) plus an FTS5
   index over it. Tokenizer `unicode61 remove_diacritics 2`, matching the existing indexes. The
   artifact carries its own `FULLTEXT_SCHEMA_VERSION` in a manifest row (mirroring
   `data.sqlite.manifest.json`), independent of `SQLITE_SCHEMA_VERSION`.
3. **Probe surfaces** — `eurlex fulltext-search` CLI command; `/api/fulltext-search` route behind
   the handler-factory pattern returning `503 fulltext_unavailable` when the artifact is absent
   (citation-graph precedent). Reuse the existing FTS5 query-string escaping used by
   `excerptSearchStatement` / `definitionSearchStatement` so user input can never be interpreted
   as FTS5 syntax.
4. **Recall eval** — read-only script over `search/eval/ranking-queries.json`: for the 100 graded
   queries, top-K hit rate for the judged CELEX via the full-text index vs. the excerpt source,
   with win/loss lists, and with recitals toggled on/off (they partly duplicate today's excerpt
   signal). A subset build (`--fromYear 2020 --toYear 2024`) answers size/latency in minutes; the
   full build runs offline overnight.

**Exit criteria for Phase 1:** recall meaningfully improves on the eval set, artifact size and
query latency are compatible with whichever D4 option is chosen, and the recitals question has an
answer. If recall does *not* improve, stop here — the probe cost is contained and #137 is closed
with data.

## Phase 1 — Production API + MCP surface

The user-facing deliverable. Ships the artifact via the chosen storage (D4), the route, and a new
MCP tool. Deliberately does **not** touch `searchLaws` ranking (that is Phase 2, separately gated).

- **`GET /api/fulltext-search?q=…&celex=…&limit=…&offset=…`** — returns matches as
  `{celex, title, unitType, number, heading, snippet, url}`; `snippet()` needs match text
  available (see D3). Optional `celex` filter turns it into "search inside this act", which also
  serves the frontend later (Phase 3). Standard limiter; no origin guard / generation budget
  needed (no spend). Record analytics like the other search routes.
- **MCP tool `search_law_text`** — same handler, agent-tuned description:
  *"Full-text search inside the body text of EU legislation. Use when the user's words come from
  a provision rather than a law's title. Returns matching articles/recitals with snippets;
  follow up with get_law_part to read the full provision."* Update `search_eu_law`'s description
  to point at it for body-text queries. Register analytics via `recordMcpTool`.
- **Optionality** — server boots fine without the artifact; the tool/route 503s with a clear
  message. This keeps local dev (`npm run dev`) working with no multi-GB download.
- **Ops discipline** — add the new artifact + its version constant to the root `CLAUDE.md` cache
  table; publishing = new `data-vN` release carrying the **full** asset set + `DATA_RELEASE_TAG`
  bump in the same commit (unless D4 decouples it — one of the arguments for options B/C).

## Phase 2 — Ranking integration (only if the probe justifies it)

Add best-passage-rank-per-CELEX as a **fourth RRF source** in `searchLaws`, gated behind a
ranking-profile flag, A/B'd with `eval/run.js` + `compare-ranking.js` on the development set, one
holdout shot — the #125 discipline. This is where full-text stops being a separate endpoint and
starts improving the main `/api/search` + `search_eu_law` results. Plausible failure mode (long
acts win on term frequency) is exactly what the eval catches.

## Phase 3 — Optional follow-ons (separately shippable, not in scope now)

- Frontend "search inside the law text" and cross-law body search UI (falls out of the same
  route almost for free).
- Consolidated texts (#135 item 1) multiply the corpus by point-in-time versions — the size and
  latency curves learned in Phase 0 directly inform that feature's indexing cost.
- Semantic/hybrid retrieval (see D7).

---

## ⚖️ Decision points

### D1 — Probe first, or ship the endpoint directly?

| | Probe first (Phases 0→1) | Ship directly (merge Phases 0+1) |
|---|---|---|
| Risk | Minimal; stop-with-data if recall doesn't improve | Committed to storage/ops cost before knowing size & win |
| Time to user value | Slower (two rounds) | One round |
| When right | If Phase 1's storage answer depends on measured size | If you consider snippet-level search obviously valuable even with unknown recall delta |

**Recommendation:** probe first, but *build the probe route/CLI in the final shape* so Phase 1 is
mostly "publish the artifact and register the MCP tool", not new code. The size measurement
genuinely gates D4.

### D2 — Index scope

1. **Articles only** — smallest, cleanest signal.
2. **Articles + recitals** (recommended default) — recitals are where purpose/intent language
   lives, which is what natural-language agent queries often sound like; the eval's
   recitals-on/off toggle decides with data.
3. **+ Annexes** — mostly tariff tables and lists; they would dominate the index. Defer unless a
   concrete use case appears (they remain reachable via `get_law_part`).

### D3 — Snippets vs. artifact size (FTS5 layout)

1. **External-content FTS5 (`content='units'`), text stored uncompressed** — `snippet()` /
   `highlight()` work natively. Largest artifact (text stored once + index).
2. **Contentless FTS5 + compressed text sidecar** — store unit text gzipped in a blob column;
   `MATCH` for retrieval, decompress the few result rows in JS and build snippets in app code
   (a ~30-line highlighter). Substantially smaller artifact; slightly more code.
3. **No snippets in v1** — contentless, `detail=column`; return only locators. Smallest, but a
   materially worse agent experience — the snippet is half the value of the tool.

**Recommendation:** prototype at option 1 / `detail=full` (per #137), and let the measured size
choose between 1 and 2. Treat 3 as a fallback only if both blow the storage budget.

### D4 — Where the artifact lives (the S3 question)

The one hard rule: **SQLite must be queried from a local filesystem.** Object storage is a
distribution channel, not a query backend — every option below ends with the file on the
container's disk (or a volume); they differ in how it gets there and what a deploy costs.

1. **A. Status quo: GitHub Release asset, baked into the Docker image** (citation-graph
   precedent). Zero new infra or credentials. Constraints: 2 GiB/asset (shard or `xz` if
   exceeded), image size grows by the artifact (slower deploys, more registry storage), and every
   data refresh is a `DATA_RELEASE_TAG` bump + full-asset re-upload.
2. **B. Railway volume + download-at-boot** — image stays small; the server (or an entrypoint
   script) fetches the artifact from the GitHub Release into the volume on first boot / version
   change, verified by manifest hash. Survives redeploys without refetching. Costs: volume
   pricing, boot-time orchestration code, and Railway volumes attach to a single service.
3. **C. S3-compatible object storage as the artifact home** (revive #41's `s3-cache-service` as a
   small artifact-fetch module; e.g. Cloudflare R2 for free egress, or Railway's bucket offering
   if available). Same download-at-boot flow as B (with or without a volume in front), but
   removes the 2 GiB GitHub limit entirely, decouples data releases from GitHub Releases, and
   gives the offline build pipeline a natural push target. Costs: credentials to manage, one new
   service dependency.
4. **D. External search engine** (Meilisearch/Typesense/Postgres-FTS as a Railway service) —
   genuinely better ops for incremental updates and typo tolerance, but a new always-on moving
   part, a second source of truth for ranking, and a break from the "static artifact, zero infra"
   ethos that everything else here follows. Not recommended at this corpus scale unless A–C fail.

**Recommendation:** decide *after* Phase 0's size number. Rough guide: ≤ ~1.5 GiB compressed → A
(simplest, proven); larger, or if refresh cadence should decouple from deploys → B or C
(C if you also want the raw corpus backed up off-machine, which #41 was reaching for). D only on
clear evidence A–C can't serve the latency/size envelope.

### D5 — API/MCP shape

1. **Separate `/api/fulltext-search` + new `search_law_text` MCP tool** (recommended) — keeps the
   proven title/alias ranking untouched; agents get an explicit, well-described primitive; Phase 2
   can still fold the signal into `searchLaws` later.
2. **Fold into `/api/search` / `search_eu_law` as a mode or automatic fourth source from day
   one** — one surface, but couples shipping to the full #125 eval cycle and muddies the tool
   description ("law finder" vs. "passage finder" are different agent intents).

### D6 — Language scope

English-only v1 — settled by the corpus itself (every harvest stage filters ENG). Multilingual
indexing is a corpus project, not a search project; note it as out of scope in the docs so users
aren't surprised.

### D7 — Semantic/embedding search posture

Stay lexical for this effort (BM25 recall is the measured gap; #126's reranking was
inconclusive). Two cheap doors deliberately left open: the `units` table is exactly the chunk
inventory an embedding index would need, and a later hybrid could RRF-merge vector hits with FTS5
hits per unit. Revisit only with eval evidence, per the #125 discipline. If #126 is not going to
land, close it referencing this plan.

*Cost note (2026 prices, rough):* embedding the whole English corpus once — ~1–3M units at a few
hundred tokens each, call it 0.5–2B tokens — costs on the order of **$10–$40** with a budget
embedding model (~$0.02/M tokens, e.g. `text-embedding-3-small` or `voyage-3.5-lite`) and
**$60–$250** with a top-tier one (~$0.13/M). The one-off API spend is genuinely negligible; what
isn't is *serving*: 1–3M vectors ≈ 2–12 GB uncompressed (less with int8/Matryoshka truncation),
an ANN index to host, a per-query embedding call adding latency and a key dependency, and
re-embedding on every corpus refresh. That ops cost — not the embedding bill — is why v1 stays
lexical.

---

## Testing & acceptance

- Builder: `node:test` suites following `definition-index-build.test.js` (fixture corpus →
  expected units, resumability, annex stripping, HTML-law parity via `parseStructuredHtmlToCombined`).
- Store/route/MCP: fixture `fulltext.sqlite` in `__fixtures__`; route tests for the 503-absent
  path, FTS5 query escaping (quotes, `NEAR`, `*`, unbalanced parens), pagination, `celex` filter;
  MCP registration test in `mcp/register-tools.test.js`.
- Recall eval report checked in under `search/eval/` output conventions (top-K hit rate vs.
  excerpt source, win/loss lists, recitals on/off).
- Ops: manifest hash verification at load; startup log line with unit count + artifact version;
  `data-vN` release checklist entry.

## Suggested sequencing

1. Phase 0 probe (builder + CLI + eval) — small, self-contained; answers D2/D3/D4 inputs.
2. Decide D3/D4 with the size/latency numbers; publish artifact; ship Phase 1 route + MCP tool.
3. Phase 2 ranking integration as a separate, eval-gated PR.
4. Phase 3 items as independent follow-ons.

Relative to #135's ranking, this slots below consolidated texts as a product priority — but the
probe is cheap, unblocks the MCP story (#134/#135 item 5), and its cost curve de-risks
consolidated-text indexing later.
