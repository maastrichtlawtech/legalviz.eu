# LegalViz Backend

REST API **and** command-line tool for downloading, parsing, and searching EU legislation in [Formex](https://op.europa.eu/en/web/eu-vocabularies/formex) format. Part of [LegalViz.EU](../README.md) — shares the Formex parser with the web app through `backend/shared/formex-parser/`.

## Prerequisites

- **Node.js >= 24** (uses `fetch`, `AbortController`, and dynamic `import()`)
- npm (comes with Node.js)

## Installation

```bash
cd backend
npm install
```

### CLI setup

After `npm install`, you can run commands via `npx`:

```bash
npx eurlex get 32016R0679
```

Or link globally to use `eurlex` anywhere:

```bash
npm link                   # run once from backend/
eurlex get 32016R0679      # now works globally
```

### API server setup

```bash
npm start                  # starts on port 3000 (or PORT env var)
```

To also enable law search, build the search cache first:

```bash
npm run build:search-cache
npm start
```

Production uses one precomputed SQLite store for law metadata, excerpt search,
and case-law details. Build it from the two release-format JSON inputs with
`npm run build:sqlite-data`. The server automatically uses
`search/data/data.sqlite` when present; an explicit `DATA_SQLITE_PATH` is
strict. Without SQLite, the existing JSON files remain the local-development
fallback.

To enable reverse-citation queries, also build the citation graph from the local corpus:

```bash
npm run build:citation-graph
```

## CLI

The `eurlex` command exposes the same functionality as the API server so you can work with EU legislation locally without running the server.

```bash
npx eurlex <command> [options]
```

### Commands

| Command | Description |
|---------|-------------|
| `eurlex get <celex>` | Download a law by CELEX, parse it, output structured JSON |
| `eurlex fetch <celex>` | Download raw Formex XML (no parsing) |
| `eurlex parse <file>` | Parse a local Formex XML file to JSON (or pipe via stdin) |
| `eurlex metadata <celex>` | Fetch SPARQL metadata (entry-into-force, ELI, etc.) |
| `eurlex amendments <celex>` | List amendments and corrigenda |
| `eurlex implementing <celex>` | List implementing/delegated acts |
| `eurlex case-law <celex>` | List CJEU judgments that cite the law |
| `eurlex recital-titles <celex>` | Generate or read cached AI titles for recitals |
| `eurlex search <query>` | Search the local law metadata cache |
| `eurlex resolve <text>` | Resolve a legal reference to a CELEX number |
| `eurlex resolve-url <url>` | Resolve a EUR-Lex URL to a CELEX number |
| `eurlex list` | List locally cached FMX files |

Every command supports `--help` for detailed usage.

### Examples

```bash
# Download & parse laws
eurlex get 32016R0679                            # GDPR (English, stdout)
eurlex get 32024R1689 --lang DEU -o ai-act.json  # AI Act in German → file
eurlex get 32022R2065 | jq '.articles | length'  # count DSA articles

# Raw XML download
eurlex fetch 32016R0679 -o gdpr.xml

# Parse a local file
eurlex parse gdpr.xml -o gdpr.json
cat gdpr.xml | eurlex parse | jq '.definitions'

# Metadata & related acts
eurlex metadata 32016R0679
eurlex amendments 32016R0679
eurlex implementing 32016R0679
eurlex case-law 32016R0679

# Optional AI features (requires OPENROUTER_API_KEY or feature-specific keys)
eurlex recital-titles 32016R0679

# Search & resolve
eurlex search "artificial intelligence" --limit 5
eurlex resolve "Regulation 2016/679"
eurlex resolve --actType directive --year 2018 --number 1972
eurlex resolve-url "https://eur-lex.europa.eu/eli/reg/2016/679/oj"
```

### Parsed JSON structure

`eurlex get 32016R0679` (and `GET /api/laws/32016R0679/parsed`) returns:

```json
{
  "celex": "32016R0679",
  "lang": "ENG",
  "title": "Regulation (EU) 2016/679 ...",
  "langCode": "EN",
  "articles": [
    {
      "article_number": "1",
      "article_title": "Subject-matter and objectives",
      "article_html": "<p>...</p>",
      "division": {
        "chapter": { "number": "I", "title": "General provisions" },
        "section": null
      }
    }
  ],
  "recitals": [
    {
      "recital_number": "1",
      "recital_title": "Protection of natural persons",
      "recital_text": "The protection of natural persons ...",
      "recital_html": "<p>...</p>"
    }
  ],
  "definitions": [
    { "term": "personal data", "definition": "any information relating to ..." }
  ],
  "annexes": [],
  "crossReferences": {
    "1": [
      { "type": "article", "target": "2", "raw": "Article 2" },
      { "type": "external", "raw": "Directive 95/46/EC", "celex": "31995L0046" }
    ]
  }
}
```

Cross-references now include external-act forms (both post-2004 `Regulation (EU) 2016/679` and pre-2004 `Directive 95/46/EC` styles) with their resolved CELEX when available, so the viewer can link across acts. `recital_title` is present when titles have been generated or merged by a client; the `/recital-titles` endpoint returns those titles separately for cacheable enhancement.

### Global CLI options

| Flag | Description |
|------|-------------|
| `--lang <CODE>` | EUR-Lex language code, e.g. `ENG`, `DEU`, `FRA` (default: `ENG`) |
| `-o, --output <file>` | Write output to a file instead of stdout |
| `--help, -h` | Show help for a command |

### `parse-fmx` (standalone shortcut)

Lightweight alias for `eurlex parse`:

```bash
parse-fmx input.xml -o output.json
cat input.xml | parse-fmx > output.json
```

---

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/api/laws` | List cached FMX files |
| `GET` | `/api/laws/:celex?lang=ENG` | Download raw Formex XML by CELEX (falls back to EUR-Lex HTML when FMX isn't available) |
| `GET` | `/api/laws/:celex/parsed?lang=ENG` | **Parsed law as structured JSON** |
| `GET` | `/api/laws/:celex/info?lang=ENG` | Law type and format metadata |
| `GET` | `/api/laws/:celex/metadata` | SPARQL metadata (entry into force, ELI, etc.) |
| `GET` | `/api/laws/:celex/amendments` | Amendment and corrigendum history |
| `GET` | `/api/laws/:celex/implementing` | Implementing and delegated acts |
| `GET` | `/api/laws/:celex/case-law?lang=ENG` | CJEU judgments citing this act, with operative parts and structured `articleRefs` |
| `GET` | `/api/laws/:celex/recital-titles?lang=ENG` | Cached AI-generated short titles for recitals. Requires `RECITAL_TITLE_OPENROUTER_API_KEY` or `OPENROUTER_API_KEY` on cache miss. |
| `GET` | `/api/laws/:celex/summary?lang=ENG` | Cached static law overview with article citations. Requires `LAW_SUMMARY_OPENROUTER_API_KEY`, `ARTICLE_QA_OPENROUTER_API_KEY`, or `OPENROUTER_API_KEY` on cache miss. |
| `GET` | `/api/laws/:celex/case-law-digest?lang=ENG` | Cached static digest of CJEU case law interpreting the whole act, grouped into doctrinal themes. Zero-case results are cached without an LLM call. |
| `GET` | `/api/laws/:celex/articles/:n/case-law-digest?lang=ENG` | Cached static digest of CJEU case law interpreting one article. Zero-case results are cached without an LLM call. |
| `GET` | `/api/laws/by-reference?actType=...&year=...&number=...` | Fetch law by official reference |
| `GET` | `/api/search?q=keyword&limit=10` | Search law metadata |
| `GET` | `/api/topics?celex=32016R0679,32024R1689` | Bulk EuroVoc topics for up to 200 CELEX ids (`{ topics: { CELEX: string[] } }`) |
| `GET` | `/api/resolve-reference?actType=...&year=...&number=...` | Resolve legal reference to CELEX |
| `GET` | `/api/resolve-url?url=...` | Resolve EUR-Lex URL to CELEX |
| `POST` | `/mcp` | Model Context Protocol endpoint (see [MCP server](#mcp-server)) |

`/api/search` searches a local metadata cache of primary regulations/directives/decisions.

## MCP server

The backend also exposes its EU-law data as a [Model Context Protocol](https://modelcontextprotocol.io) server at **`POST /mcp`** (stateless Streamable HTTP). This lets people query EU law from inside AI assistants (Claude, ChatGPT, Cursor, …) without any coding — they add one URL as a connector. It reuses the same services, caches, and rate limiting as the REST API; no separate process or deployment.

**Tools** (structured primary-law data only — no AI summaries):

| Tool | Purpose |
|------|---------|
| `search_eu_law` | Find a law's CELEX id by keyword, title, or citation |
| `resolve` | Turn a citation ("Directive 2018/1972"), a CELEX id, or an EUR-Lex URL into a CELEX |
| `get_law_part` | Read a slice of a law: `structure` (table of contents), `article`, `recital` (with cached AI title when available), `annex`, or `definitions` |
| `get_case_law` | List CJEU judgments interpreting a law |
| `get_law_relations` | Amendments/corrigenda and implementing acts for a law |

`get_law_part` never returns a whole law at once — call `structure` first for the map, then request individual articles/recitals. The first fetch of an uncached law can take up to ~30s (downloaded from EUR-Lex); subsequent calls are fast.

### Add it to an AI client

```bash
# Claude Code
claude mcp add --transport http eurlex https://api.legalviz.eu/mcp

# Local dev
claude mcp add --transport http eurlex-local http://localhost:3000/mcp
```

- **Claude.ai / Claude Desktop**: Settings → Connectors → add custom connector with the `/mcp` URL.
- **ChatGPT**: Settings → Connectors → Advanced settings → **Add custom connector** (or, inside a chat with Developer Mode enabled, Tools → **Add connector**) → paste the `/mcp` URL as the MCP server URL. ChatGPT connects over Streamable HTTP directly, no auth needed.
- **Cursor / VS Code / Windsurf**: add an entry to the client's MCP config, e.g.
  ```json
  { "mcpServers": { "eurlex": { "url": "https://api.legalviz.eu/mcp" } } }
  ```
- **Other MCP-compatible clients**: any client supporting the Streamable HTTP transport can connect directly to `https://api.legalviz.eu/mcp` — no API key or extra headers required.

### Analytics

`/api/_stats` reports request counts split by **channel** — `web` (own frontend, tagged via the `x-legalviz-client: web` header), `api` (direct REST callers), and `mcp` — under `channels` (all-time) and `dayChannels` (per day). Individual MCP tool calls appear in `topRoutes` as `mcp:<tool>`.

### Case-law endpoint

`/api/laws/:celex/case-law` returns every CJEU judgment that cites the act, parsed into:

```json
{
  "celex": "62012CJ0131",
  "ecli": "ECLI:EU:C:2014:317",
  "caseNumber": "C-131/12",
  "date": "2014-05-13",
  "name": "Google Spain",
  "declarations": [
    { "number": 1, "text": "Article 2(b) of Directive 95/46/EC …" }
  ],
  "articleRefs": [
    { "raw": "Article 7(f)", "act": "Directive 95/46", "actCelex": "31995L0046",
      "article": "7", "paragraph": "f", "point": null }
  ]
}
```

The parser handles post-2004 EUR-Lex Formex, pre-2004 OJ HTML, and older Curia HTML shapes.

Judgment discovery remains live through SPARQL, but names, operative rulings,
and article references are read only from precomputed data. Refresh them by
running the case-law harvest/parser pipeline, publishing updated release
assets, and rebuilding the image; API requests never scrape or rewrite this
cache.

### Recital titles endpoint

`GET /api/laws/:celex/recital-titles?lang=ENG` returns AI-generated short titles keyed by recital number:

```json
{
  "celex": "32016R0679",
  "lang": "ENG",
  "model": "google/gemini-2.5-pro",
  "cached": true,
  "titles": {
    "1": "Protection of natural persons",
    "26": "Definition of personal data"
  }
}
```

The backend stores titles in `recital-title-cache-v1.json` with a cache `version`, source-content hash, model, and generation timestamp. The web app also keeps a versioned IndexedDB copy so repeated browser visits do not call the endpoint again.

### Static summary endpoints

`GET /api/laws/:celex/summary?lang=ENG` returns a cached overview:

```json
{
  "celex": "32016R0679",
  "lang": "ENG",
  "cached": true,
  "summary": {
    "purpose": { "text": "…", "citations": ["1"] },
    "scope": { "text": "…", "citations": ["2", "3"] },
    "keyObligations": [
      { "text": "…", "citations": ["5"] }
    ],
    "structure": "…"
  }
}
```

`GET /api/laws/:celex/articles/:n/case-law-digest?lang=ENG` returns a cached article-level digest:

```json
{
  "celex": "32016R0679",
  "articleNumber": "6",
  "lang": "ENG",
  "caseLawCacheVersion": "case-law-cache-v5",
  "digest": {
    "summary": "…",
    "themes": [
      {
        "name": "Legal basis",
        "description": "…",
        "cites": [{ "ecli": "ECLI:EU:C:2020:559", "celex": "62018CJ0311", "declarationNumber": "1" }]
      }
    ],
    "noCaseLaw": false
  }
}
```

`GET /api/laws/:celex/case-law-digest?lang=ENG` returns the same digest shape (`summary` / `themes` / `noCaseLaw`) but grouped across the whole act rather than a single article — useful for laws whose case law is too thin to attribute to individual articles:

```json
{
  "celex": "32014L0104",
  "lang": "ENG",
  "caseLawCacheVersion": "case-law-cache-v5",
  "digest": {
    "summary": "…",
    "themes": [
      {
        "name": "Disclosure of evidence",
        "description": "…",
        "cites": [{ "ecli": "ECLI:EU:C:2022:863", "celex": "62021CJ0163", "declarationNumber": "1" }]
      }
    ],
    "noCaseLaw": false
  }
}
```

These endpoints validate generated JSON and citations before writing cache files. The backend stores summaries in `law-summary-cache-v1.json`, article digests in `article-digest-cache-v1.json`, and whole-law case-law digests in `case-law-digest-cache-v1.json`, with cache version, prompt/schema version, source hash, model, and generation timestamp. The shared plumbing for these features (text clipping, cache read/write, single-flight, citation grounding) lives in `shared/ai-digest-utils.js`.

## Using from Python (and other languages)

There are three ways to consume EU law data from outside JavaScript.

### Option 1: Call the CLI from a subprocess

The simplest approach — no server needed. The CLI outputs JSON to stdout.

```python
import subprocess, json

def get_law(celex, lang="ENG"):
    result = subprocess.run(
        ["npx", "eurlex", "get", celex, "--lang", lang],
        capture_output=True, text=True, check=True,
        cwd="path/to/backend"
    )
    return json.loads(result.stdout)

gdpr = get_law("32016R0679")
print(f"{gdpr['title']} — {len(gdpr['articles'])} articles")

for defn in gdpr["definitions"]:
    print(f"  {defn['term']}: {defn['definition'][:80]}...")
```

Works the same for any command:

```python
# Metadata
meta = json.loads(subprocess.run(
    ["npx", "eurlex", "metadata", "32016R0679"],
    capture_output=True, text=True, cwd="path/to/backend"
).stdout)

# Resolve a reference
ref = json.loads(subprocess.run(
    ["npx", "eurlex", "resolve", "Directive 2018/1972"],
    capture_output=True, text=True, cwd="path/to/backend"
).stdout)
```

### Option 2: HTTP API with `requests`

Start the server (`npm start`), then call it from any language:

```python
import requests

base = "http://localhost:3000"

# Parsed law as JSON
law = requests.get(f"{base}/api/laws/32016R0679/parsed", params={"lang": "ENG"}).json()

# Search
results = requests.get(f"{base}/api/search", params={"q": "digital markets", "limit": 5}).json()

# Metadata
meta = requests.get(f"{base}/api/laws/32016R0679/metadata").json()
```

### Option 3: CLI + file output for batch processing

For batch jobs, write JSON files and process them separately:

```bash
# Download multiple laws
for celex in 32016R0679 32024R1689 32022R1925 32022R2065; do
  eurlex get "$celex" -o "${celex}.json"
done
```

```python
import json, glob

for path in glob.glob("*.json"):
    law = json.load(open(path))
    print(f"{law['celex']}: {law['title'][:60]}... ({len(law['articles'])} articles)")
```

### Using from R, Julia, or other languages

The same patterns work — call the CLI via your language's subprocess API, or make HTTP requests to the running API server. All output is JSON.

```r
# R example
library(jsonlite)
gdpr <- fromJSON(system("npx eurlex get 32016R0679", intern = TRUE))
```

## Search

Search is intentionally narrow and conservative:
- primary acts only
- regulations, directives, decisions
- local metadata cache
- lexical ranking only

Each result returns:
- `celex`
- `title`
- `type`
- `date`
- `eli`
- `fmxAvailable`
- `matchReason`

Examples:

```bash
curl "http://localhost:3000/api/search?q=32016R0679"
curl "http://localhost:3000/api/search?q=regulation%202016/679"
curl "http://localhost:3000/api/search?q=digital%20markets%20act&limit=5"
```

If the search cache has not been built yet, `/api/search` returns `503` with `code=search_cache_unavailable`.

## Citation Graph

The offline citation graph provides reverse lookups across the locally harvested legislation corpus and cached CJEU case law:

```bash
npm run build:citation-graph
curl "http://localhost:3000/api/laws/32016R0679/articles/6/cited-by?limit=50&offset=0"
curl "http://localhost:3000/api/laws/32016R0679/cited-by?citingLaws=10"
```

The article endpoint returns paginated citing provisions and judgments. The act endpoint returns aggregate counts split between act-only and article-specific citations, plus `citingLaws` — the top citing acts (legislation only) ranked by how many distinct provisions cite the target, capped by the `citingLaws` query parameter (default 10, max 50). The MCP endpoint exposes the same data through `get_citing_provisions`; omit its `article` argument to request act-level counts. If the artifact has not been built or cannot be loaded, these queries return `503` with `code=citation_graph_unavailable`.

The default artifact is `search/data/citation-graph.json`. Restart the API after rebuilding it, because it is loaded once at startup. Like the search and case-law caches, the graph is **not committed** — a fresh deploy fetches `citation-graph.json.gz` as a **GitHub Release asset** at Docker build time (see `backend/Dockerfile`, `DATA_RELEASE_TAG`); the store gunzips it at startup when the raw file is absent, and a local rebuild still wins. To publish a new build: rebuild the graph against the current corpus and case-law cache, `gzip -k` the artifact, upload `citation-graph.json.gz` to the `DATA_RELEASE_TAG` release, and redeploy.

The v1 graph covers the FMX corpus only: HTML-only laws are counted in artifact coverage metadata but are not parsed. To prevent annex-heavy documents from exhausting builder memory, decompressed FMX larger than 1 MiB is parsed only when complete uppercase annex siblings can be removed and the remaining `ACT` also fits below 1 MiB. Those laws are explicitly reported as operative-only and their annex citations are not covered. Unsafe or still-oversized documents are skipped; override the guard only with adequate memory using `--maxXmlBytes <bytes>`. The 1 MiB default is empirical: a 2.97 MiB act with 125 annexes exhausted a 4 GiB heap during full-DOM parsing.

The CLI additionally parses deterministic batches in disposable worker threads (100 laws by default), releasing the parser DOM heap between batches. If a worker fails, its batch is recursively split until the offending law can be recorded and skipped without abandoning the build. Use `--batchSize <count>` to tune the isolation interval. Progress is printed after each completed worker batch.

## Search Cache Build

The search cache is built manually and loaded at server startup.

Build it:

```bash
npm run build:search-cache
```

Useful options:

```bash
npm run build:search-cache -- --concurrency 6
npm run build:search-cache -- --resume --concurrency 6
npm run build:search-cache -- --fromYear 2026 --toYear 2010 --limit 200
```

Builder behavior:
- harvests primary `reg|dir|dec` `/eli/.../oj` acts from the official Publications Office SPARQL endpoint
- enriches titles from FMX/Formex where available
- records FMX availability
- writes the cache atomically
- persists resumable build state

Default files:
- search cache: `search/data/search-cache.json`
- build state: `search/data/search-build-state.json`

Important: restart the API server after rebuilding the cache, because the cache is loaded on startup.

### Precomputed runtime store

`npm run build:sqlite-data` converts `search-cache.json(.gz)` and
`case-law-cache.json(.gz)` into `search/data/data.sqlite`. It writes a
temporary database, validates its schema, row counts, and integrity, then
renames it atomically. The build also emits `data.sqlite.manifest.json` with
source and artifact SHA-256 checksums, schema version, table counts, and mapping
integrity results. Runtime opens the result read-only through
`better-sqlite3`; the serving path does not depend on Node's experimental
`node:sqlite` API.

The revised search keeps deterministic CELEX, official-reference, and exact
alias matches first. Broad queries retrieve independent candidate lists from an
in-memory title/alias MiniSearch index, an in-memory EuroVoc MiniSearch index,
and the contentless SQLite FTS5 excerpt index. Weighted reciprocal-rank fusion
combines those lists, then applies bounded act-type, in-force-status, and
log-damped citation priors. The JSON path uses a separate excerpt MiniSearch
index as its development fallback; production serves SQLite.

This costs roughly 385 MB V8 heap / 675 MB process RSS for data-v9 before a
browser is launched. Provision at least 1.5 GiB for the backend process so law
fetching and parsing have headroom. Re-run `search/eval/run.js` after changing
the data release or Node runtime; see `search/eval/README.md` for the quality,
latency, memory, signal-coverage, and paired-comparison gates.

Before publishing a data artifact, compare JSON and SQLite ranking against the
full release corpus:

```bash
npm run test:search-parity -- \
  --search search/data/search-cache.json.gz \
  --sqlite search/data/data.sqlite \
  --report search/data/search-parity-report.json
```

The committed query contract checks exact identifiers and aliases, common
misspellings, modifier-heavy natural queries, and documented intentional rank
changes. The gate fails when expected laws move outside their allowed rank,
SQLite loses a previous result entirely, or an unapproved previous top result
moves outside the configured top-N window.

### Automated release gates

`.github/workflows/backend-docker.yml` builds the real multi-stage image when
backend files change, starts it, exercises SQLite-backed search, topics, and
reference resolution, and verifies that the final image contains the database
manifest but not the source JSON artifacts.

`.github/workflows/refresh-case-law-data.yml` runs the offline judgment refresh
monthly and on demand. Scheduled runs produce a validated candidate artifact and
retain it for review; they never publish automatically. A manual run may opt into
publication with a new immutable `data-vN` tag. Publication is attached to the
`data-release` GitHub environment and opens a separate pull request that bumps
the Docker release tag, keeping deployment reviewable and reversible.

See the [case-law data refresh runbook](docs/case-law-data-refresh.md) for the
schedule, incremental-update model, Chromium/WAF behavior, candidate review and
approval procedure, recovery steps, and current operational limitations.

### Metadata that isn't in the corpus (dates, EuroVoc topics, in-force status)

`date`, `eurovoc` and `inForce` are SPARQL metadata that the gzipped source on
disk doesn't carry, so an offline rebuild (`build-cache-from-corpus.js`) can't
reconstruct them. Both builders fill them in, and **all of them ship inside the
release asset** (`date`/`eurovoc` from `data-v6`, `inForce` from `data-v8`) — the
server reads them straight off each record and merges nothing at startup.

- **`date`** (`cdm:work_date_document`) — `search-build.js` persists it for every
  year it harvests into `search/data/law-dates.json` (`law-corpus-dates.js`),
  which the offline rebuild overlays back onto its records.
- **`eurovoc`** (subject labels) — `search/eurovoc-enrich.js` runs as the **last
  step of both builders**, fetching labels for any record that doesn't have them
  and journaling results to `search/data/eurovoc.json`.
- **`inForce`** / **`endOfValidity`** — `search/in-force-enrich.js`, same shape,
  journaling to `search/data/in-force.json`.

`inForce` is a **tri-state**: `true`, `false`, or `null` when Cellar has no
status for the act. Three things about it are easy to get wrong:

- **`false` means "no longer in force" and nothing more.** Cellar exposes no
  repeal predicate, so there is no way to tell a repealed act from one that
  expired on its own terms (`31970R0729` ran out in 1999 and was never repealed).
  Don't let a label upgrade this into a claim the data can't support — EUR-Lex
  itself says "No longer in force".
- **The flag is authoritative; never derive status from dates.** They disagree:
  `32015L2366` (PSD2) is flagged in force while carrying an `endOfValidity` of
  `2026-06-18`, already in the past.
- **`9999-12-31` is a sentinel**, not a date. `in-force-enrich.js` normalises it
  to `null`; `entry-into-force` is deliberately not fetched because it is
  multi-valued and fans every act out into duplicate rows.

All three journals are **gitignored build-time artifacts** and resume journals
only: they mean an interrupted harvest (~800 batches over Cellar) doesn't restart
from zero, and a rebuild reuses values already fetched for unchanged acts.

Enrichment is part of the build **on purpose**. Topics are keyed by CELEX, so a
pass bolted on afterwards is generated against one cache and served alongside
another — every record it never saw silently serves empty topics, and nothing
errors. That is exactly how the `data-v5` corpus expansion (13k → 80k acts) left
~83% of records topic-less.

It's best-effort: a Cellar outage logs and ships the cache without topics rather
than discarding a multi-hour harvest. Opt out with `--no-eurovoc` /
`--no-in-force`, which for `build-cache-from-corpus.js` also restores a genuinely
network-free build (the enrichment runs in the driver; the parse workers keep
their hard `fetch` block either way).

If a cache is fine but its topics or status aren't — a build ran `--no-eurovoc`,
EuroVoc changed upstream, or acts have since fallen out of force — backfill
without a rebuild:

```bash
node --max-old-space-size=8192 search/fetch-eurovoc.js
node --max-old-space-size=8192 search/fetch-in-force.js
```

If whole acts are missing rather than a field — a transient Cellar failure during
the sweep, or an act Cellar had not indexed yet when it ran — add them by CELEX
instead of re-sweeping the year around them:

```bash
node --max-old-space-size=8192 search/backfill-cache.js \
  --celex 32014D0055,32016D0040 --cachePath search/data/search-cache.json.gz
node --max-old-space-size=8192 search/backfill-cache.js \
  --celex @missing.txt --cachePath search/data/search-cache.json.gz
```

`backfill-cache.js` runs the same steps as the full builder in the same order
(SPARQL metadata → title/excerpt, corpus-first → EuroVoc → in-force →
`enrichSearchRecord`), so a backfilled record is indistinguishable from a swept
one. It reads/writes `.json` and `.json.gz`, so it patches the release asset
directly, and it skips ids already in the cache — a re-run after a partial
failure only fetches what is still missing. Note this is the opposite direction
from `reenrich-cache.js`, which only refreshes records already present.

**Only English-language acts are indexable.** The pipeline is English-only
throughout (`FILTER(LANG(?title) = "en")`, `/EN/TXT/`, `ENG.fmx4`). Most pre-1973
acts and many pre-2004 ones exist in Cellar **only** in DAN/DEU/FRA/ITA/NLD, so
they have no English rendition to fetch and are permanently out of scope — not a
coverage bug. When auditing gaps, filter the manifestation query by
`cdm:expression_uses_language <…/authority/language/ENG>` or the result will
overcount by an order of magnitude (see issue #100: 942 "missing" acts, 29 real).

**Backfill; don't rebuild, to add a field.** These tools patch the cache they
read, touching only their own field and carrying everything else through
verbatim. A rebuild re-derives `date` and `eurovoc` from scratch and will happily
ship a cache with 13k/80k dates and zero topics if the harvest is anything short
of complete — that is not hypothetical, it is what the first `data-v7` upload
did, and CI only caught half of it. `fetch-in-force.js` refuses to write if the
date or EuroVoc counts regress against the cache it loaded.

Publish `search-cache.json.gz` as the next `data-vN` release asset and bump
`DATA_RELEASE_TAG` in `backend/Dockerfile`. Docker fetches both JSON assets and
converts them into one runtime SQLite file, so a release must carry both assets
even when only one changed. A future release may ship SQLite directly and
remove this transitional conversion stage.

## Project Layout

```text
backend/
├─ package.json
├─ server.js
├─ README.md
├─ bin/
│  ├─ eurlex.js          # Full-featured CLI
│  └─ parse-fmx.js       # Standalone parse shortcut
├─ routes/
│  └─ api-routes.js
├─ search/
│  ├─ search-build.js
│  ├─ build-sqlite-data.js
│  ├─ search-index.js
│  ├─ search-ranking.js
│  ├─ search-route.js
│  ├─ search-regression.test.js
│  └─ search-route.test.js
└─ shared/
   ├─ api-utils.js
   ├─ fmx-parser-node.js        # Node.js wrapper for browser-side Formex parser
   ├─ fmx-service.js
   ├─ law-queries.js             # Shared SPARQL queries (metadata, amendments, implementing, case-law)
   ├─ case-law-parser.js         # Parses article citations across CJEU judgment HTML eras
   ├─ article-digest-service.js  # Cached static article case-law digests
   ├─ law-summary-service.js     # Cached static law overviews
   ├─ openrouter-chat.js         # OpenRouter chat-completions wrapper
   ├─ recital-title-service.js   # Cached AI-generated short titles for recitals
   ├─ rate-limit.js
   ├─ reference-utils.js         # Parses legal references (incl. pre-2004 forms)
   └─ reference-utils.test.js
```

## Development

```bash
npm run dev                # start with --watch (auto-restart on changes)
```

Verify the server is running:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/api/laws/32016R0679/parsed?lang=ENG | jq .title
curl "http://localhost:3000/api/search?q=gdpr"
```

## Tests

Run all current tests:

```bash
npm test
```

Search-only tests:

```bash
npm run test:search
```

Current test coverage includes:
- search regression ranking checks
- search route behavior
- CELEX/reference parsing helpers
- case-law citation lists, ranges, contextual refs, and historical HTML shapes

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Port for the API server. |
| `CACHE_DIR` | Directory for cached FMX/XML/ZIP downloads and derived artefacts. Defaults to `backend/law-cache` for the API. The CLI also respects legacy `FMX_DIR`. |
| `STORAGE_LIMIT_MB` | Max size of the FMX download cache before eviction starts. Default `500`. |
| `HTML_CACHE_LIMIT_MB` | Max size of the legacy-HTML fallback cache. Default `200`. |
| `RATE_LIMIT_MAX` | Per-IP request cap for the 15-minute window. |
| `TIMEOUT_MS` | HTTP request timeout in ms. Default `30000`. |
| `DATA_SQLITE_PATH` | Optional strict path to the precomputed SQLite store. Missing or incompatible files do not fall back to JSON. |
| `SEARCH_CACHE_PATH` | Optional override for the legacy/local search cache JSON path. An explicit non-default path forces JSON unless `DATA_SQLITE_PATH` is set. |
| `CITATION_GRAPH_PATH` | Optional override for the citation graph JSON path. Defaults to `search/data/citation-graph.json`. |
| `ANALYTICS_TOKEN` | Token required by the `/api/_stats` endpoint; also used as the analytics sketch key unless `ANALYTICS_HASH_KEY` is set. |
| `ANALYTICS_HASH_KEY` | Optional stable secret used to key privacy-preserving daily unique-user estimates. Set this separately to allow analytics-token rotation without resetting deduplication. |
| `OPENROUTER_API_KEY` | Fallback OpenRouter key used by static summaries and recital titles when the feature-specific key is not set. |
| `OPENROUTER_BASE_URL` | Override (default `https://openrouter.ai/api/v1`). |
| `LAW_SUMMARY_OPENROUTER_API_KEY` | Optional OpenRouter key used for law summaries and article case-law digests. Falls back to `ARTICLE_QA_OPENROUTER_API_KEY`, then `OPENROUTER_API_KEY`. |
| `ARTICLE_QA_OPENROUTER_API_KEY` | Legacy fallback key still accepted for static summary generation. |
| `RECITAL_TITLE_OPENROUTER_API_KEY` | Optional OpenRouter key used only for recital-title generation and `eurlex recital-titles`. Falls back to `OPENROUTER_API_KEY`. |
| `LAW_SUMMARY_MODEL` | Model for cached law summaries. Default falls back through `ARTICLE_QA_ANSWER_MODEL`, `ARTICLE_QA_MODEL`, then `google/gemini-2.5-pro`. |
| `ARTICLE_DIGEST_MODEL` | Model for cached article case-law digests. Default falls back through `LAW_SUMMARY_MODEL`, `ARTICLE_QA_ANSWER_MODEL`, `ARTICLE_QA_MODEL`, then `google/gemini-2.5-pro`. |
| `ARTICLE_QA_MODEL` / `ARTICLE_QA_ANSWER_MODEL` | Legacy model fallbacks still accepted for static summary generation. |
| `ARTICLE_QA_PLANNER_MODEL` | Legacy model fallback used only by recital-title defaults. |
| `RECITAL_TITLE_MODEL` | Model for cached AI-generated recital titles. Default `google/gemini-2.5-pro`. |
| `PLAYWRIGHT_HEADLESS` / `PLAYWRIGHT_BROWSERS_PATH` / `PLAYWRIGHT_MODULE_PATH` / `LEGALVIZ_PLAYWRIGHT_MODULE_PATH` | Playwright configuration for fetching laws that require rendering. |

## Notes

- FMX fetching and search are separate concerns. Search does not download FMX files.
- `/api/search` prefers primary acts and deprioritizes implementing/delegated/corrigendum material.
- Search quality is strongest for CELEX, `type + year/number`, and well-titled flagship laws.
- The builder is resumable, but a partially enriched cache is still only best-effort for relevance.

## License

MIT
