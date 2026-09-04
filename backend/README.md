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

To enable cross-law definition search, build the resumable English definition
index from the same local FMX and HTML corpus before building SQLite:

```bash
npm run build:definition-index
npm run build:sqlite-data
```

### Repairing a duplicated corpus

Corpora harvested before the `findDownloadUrls` dedupe (issue #219) hold each
act two or three times over in one file: Cellar lists the same physical
`.fmx4.<lang>.xml` under several manifestation URIs, the build copy of
`findDownloadUrls` returned all of them, and `fetchCombinedFmxXml` fetched and
concatenated each. 24,132 of the 28,009 files in `corpus-2026-08-21.01` are
affected, and the duplicates flow into every corpus-derived artifact that does
not key its units by number — the shipped full-text index carried 331,421
excess rows (26.5%).

Fixing the harvest does not fix the corpus, because enrichment is corpus-first
and never refetches a file it already has. Sweep it instead:

```bash
npm run repair:corpus -- --dry-run        # report only, writes nothing
npm run repair:corpus                     # split each file on its top-level
                                          # block boundaries, keep unique blocks
npm run repair:corpus -- --limit 5000     # in slices; resumable via the journal
```

The sweep is idempotent, journals progress to
`search/data/corpus-dedupe-progress.json` so it resumes after an interrupt
(`--no-resume` ignores the journal), writes atomically, and leaves any file it
cannot split with certainty untouched. It makes no assumption about the root
element — 61 files are legitimately rooted at `GENERAL` or `ANNEX`, and block
order is not guaranteed.

Exact-block dedupe is a **floor** in principle, not a proof: Cellar can list
the same act under manifestations that differ in incidental markup, which no
whole-block comparison catches — `32016D0298` keeps two ACT blocks (8,412 and
8,157 bytes) and its recitals still parse twice. That one is not a repair
shortfall, though: the serving path deduplicates on the same key, so production
`/api/laws/32016D0298/parsed` shows the same doubled recitals. Over a 250-act
spread the repair cut recitals from 4,775 to 1,684 and annexes from 822 to 303,
and left **one** act with a repeated recital where 209 of the 250 had one
before; on 22 acts spot-checked against production `/parsed`, the repaired
corpus matched recital, article, definition and annex counts exactly. Only a
re-harvest through the fixed `findDownloadUrls` verifies against Cellar itself.

Rebuild the search cache, definition index, citation graph and full-text index
against the repaired corpus afterwards — none of them re-derive themselves —
then publish the new artifacts and bump `DATA_RELEASE_TAG` /
`FULLTEXT_RELEASE_TAG` in `backend/Dockerfile` as usual.

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
| `GET` | `/api/laws/:celex/info?lang=ENG` | Law type and format metadata. Returns `200` with `formexAvailable: false` (and `type: null`) for acts EUR-Lex publishes without Formex — those still parse via the HTML fallback. `404` means the CELEX itself is unknown to Cellar. |
| `GET` | `/api/laws/:celex/metadata` | SPARQL metadata (entry into force, ELI, etc.) |
| `GET` | `/api/laws/:celex/amendments` | Amendment and corrigendum history |
| `GET` | `/api/laws/:celex/consolidated` | Consolidated ("as amended") versions EUR-Lex publishes for the act, oldest first. Future-dated versions are included — the caller decides which one is current. |
| `GET` | `/api/laws/:celex/implementing` | Implementing and delegated acts |
| `GET` | `/api/laws/:celex/procedure` | Official EUR-Lex legislative procedure overview link |
| `GET` | `/api/laws/:celex/case-law?lang=ENG` | CJEU judgments citing this act, with operative parts and structured `articleRefs` |
| `GET` | `/api/laws/:celex/recital-titles?lang=ENG` | Cached AI-generated short titles for recitals. Requires `RECITAL_TITLE_OPENROUTER_API_KEY` or `OPENROUTER_API_KEY` on cache miss. |
| `GET` | `/api/laws/:celex/summary?lang=ENG` | Cached static law overview with article citations. Requires `LAW_SUMMARY_OPENROUTER_API_KEY`, `ARTICLE_QA_OPENROUTER_API_KEY`, or `OPENROUTER_API_KEY` on cache miss. |
| `GET` | `/api/laws/:celex/summary-cached` | Read-only English summary cache lookup. Never generates, resolves, or parses a law; returns `404 summary_not_cached` when no current model/version-matching entry exists. |
| `GET` | `/api/laws/:celex/case-law-digest?lang=ENG` | Cached static digest of CJEU case law interpreting the whole act, grouped into doctrinal themes. Zero-case results are cached without an LLM call. |
| `GET` | `/api/laws/:celex/articles/:n/case-law-digest?lang=ENG` | Cached static digest of CJEU case law interpreting one article. Zero-case results are cached without an LLM call. |
| `GET` | `/api/laws/by-reference?actType=...&year=...&number=...` | Fetch law by official reference |
| `GET` | `/api/search?q=keyword&limit=10` | Search law metadata |
| `GET` | `/api/fulltext-search?q=keyword&celex=32016R0679&limit=10` | Strict AND search inside English body text (articles and recitals), with snippets and highlight ranges |
| `POST` | `/api/fulltext-search` with `{ "q": "keyword", "celexes": ["32016R0679"], "limit": 10 }` | Strict AND search inside a supplied CELEX collection |
| `GET` | `/api/definitions/search?q=term&limit=10&filter=different` | Search extracted legal definitions; omit `q` and use `filter=different` or `filter=reused` for discovery |
| `GET` | `/api/definitions/compare?term=risk` | Compare a term's definitions across laws |
| `GET` | `/api/topics?celex=32016R0679,32024R1689` | Bulk EuroVoc topics for up to 200 CELEX ids (`{ topics: { CELEX: string[] } }`) |
| `GET` | `/api/resolve-reference?actType=...&year=...&number=...` | Resolve legal reference to CELEX |
| `GET` | `/api/resolve-url?url=...` | Resolve EUR-Lex URL to CELEX |
| `POST` | `/mcp` | Model Context Protocol endpoint (see [MCP server](#mcp-server)) |

`/api/search` searches a local metadata cache of primary regulations/directives/decisions.
`/api/fulltext-search` searches the optional English full-text index's `text`
column only. It accepts `q` (required, at most 200 characters and 12
searchable terms, with at least one term of 2+ characters), an optional CELEX
scope, and `limit` (1–50); there is no offset in this first version. Unquoted
terms are prefix-matched and quoted segments are phrase-matched. Queries use
strict AND semantics and punctuation-only input is rejected. Global results
return at most one best unit per CELEX; GET requests scoped to one CELEX may
include multiple matching units from that act. POST requests take
`{ q, celexes, limit }`, require 1–200 valid CELEX values, and return one best
unit per requested CELEX after normalising and deduplicating the collection.
Each result contains `{ celex, title, unitType, number, heading, snippet,
highlightRanges }`; the snippet is plain text and ranges use zero-based
`{start, end}` offsets. If the optional artifact is missing or stale, the
endpoint returns `503` with `code=fulltext_index_unavailable` and the
full-text status details.

## MCP server

The backend also exposes its EU-law data as a [Model Context Protocol](https://modelcontextprotocol.io) server at **`POST /mcp`** (stateless Streamable HTTP). This lets people query EU law from inside AI assistants (Claude, ChatGPT, Cursor, …) without any coding — they add one URL as a connector. It reuses the same services, caches, and rate limiting as the REST API; no separate process or deployment.

**Tools** (structured primary-law data only — no AI summaries):

| Tool | Purpose |
|------|---------|
| `search_eu_law` | Find a law's CELEX id by keyword, title, or citation |
| `search_law_text` | Search the body text of EU legislation for a term or phrase, returning matching article/recital units |
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
  "model": "google/gemini-3.5-flash-lite",
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

`GET /api/laws/:celex/summary-cached` is the read-only cache-only variant. It
returns the same version fields and summary payload when a current English
entry for the configured summary model exists, or `404` with
`{ "error": "No cached summary is available", "code": "summary_not_cached" }`.
It does not require an OpenRouter key.

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

The builder runs a pool of persistent worker threads (`--pool`, default `2`) that pull batches of `--batchSize` laws from a queue; parsing is CPU-bound, so the second worker roughly halves wall-clock time on a 4-vCPU machine. Workers live across batches — safe because `shared/fmx-parser-node.js` recycles its DOM-shim window every `FMX_DOM_SHIM_RECYCLE` parses — and are replaced automatically if one dies on an oversized act, with the failed batch split and retried down to single laws. `--workerHeapMb` (default 768) caps each worker's old space; raise it for corpora containing acts that need several GB to parse.

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

`npm run build:sqlite-data` converts `search-cache.json(.gz)`,
`case-law-cache.json(.gz)`, and the optional `definitions.json(.gz)` into
`search/data/data.sqlite`. It writes a
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

The automated release train is split across three workflows: `Refresh corpus`
([`refresh-corpus.yml`](../.github/workflows/refresh-corpus.yml)) runs monthly at
`43 3 5 * *`, then successful `workflow_run` events trigger `Refresh data`
([`refresh-data.yml`](../.github/workflows/refresh-data.yml)) and `Refresh
fulltext` ([`refresh-fulltext.yml`](../.github/workflows/refresh-fulltext.yml)).
The chain publishes validated immutable dated releases automatically
(`<train>-YYYY-MM-DD.NN`, see `.github/scripts/release-tags.sh`) and opens
separate Docker tag-bump PRs for
`DATA_RELEASE_TAG` and `FULLTEXT_RELEASE_TAG`. Merging those PRs is the only
human deploy gate; no environment approval is required.

See the [case-law data refresh runbook](docs/case-law-data-refresh.md) for the
corpus-stage schedule, Chromium/WAF behavior, candidate review, and recovery
steps.

See the [legislation data refresh runbook](docs/legislation-data-refresh.md) for
the exact three-workflow corpus → data → full-text chain, release/PR
behavior, manual recovery, flag traps, and accepted v1 limitations.

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
  Don't let a label upgrade this into a claim the data can't support. The pill
  says "Not in force" on the flag alone; it only says "No longer in force" where
  an end-of-validity date backs it, and "Not yet in force" where an
  entry-into-force date in the future does.
- **The flag is authoritative; never derive status from dates.** They disagree:
  `32015L2366` (PSD2) is flagged in force while carrying an `endOfValidity` of
  `2026-06-18`, already in the past.
- **`9999-12-31` is a sentinel**, not a date. `in-force-enrich.js` normalises it
  to `null`, in `endOfValidity` and `entryIntoForce` alike, along with
  placeholder years no act could carry (Cellar answers `32026D1296` with
  `1001-01-01`).
- **`entry-into-force` is fetched**, as `entryIntoForce`, and it is the only
  thing that separates the two meanings of `false`. It is genuinely
  multi-valued — the GDPR carries 2016-05-24 and 2018-05-25, `32026R1818`
  carries ten dates out to 2036 — so joining it fans an act out into one row per
  date. That is only safe because nothing is aggregated server-side any more:
  `reduceBindings` takes the earliest, which is when the act enters into force,
  the later dates staging individual provisions. Measured cost on a 500-act
  sample: 1.19x rows, ~520ms per 100-id batch, ~7 minutes for a full sweep.

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

`build-cache-from-corpus.js --rederive` inverts the normal merge for one
purpose: refreshing `title` and `excerpt` on records the cache already holds,
after a parser fix that the additive monthly refresh would never reach (issue
#180). It applies no year floor, adds no acts, and skips EuroVoc/in-force
entirely — those fields, plus `date` and the alias fields, are preserved from
the existing record — so it is offline in the driver as well as in the workers.
It stamps `parserVersion` bare only when nothing stale was left behind; see
[docs/legislation-data-refresh.md](docs/legislation-data-refresh.md) for when to
run it and what the other three assets need.

If a cache is fine but its topics or status aren't — a build ran `--no-eurovoc`,
EuroVoc changed upstream, or acts have since fallen out of force — backfill
without a rebuild:

```bash
node --max-old-space-size=8192 search/fetch-eurovoc.js
node --max-old-space-size=8192 search/fetch-in-force.js
```

`fetch-in-force.js` only ever fills a gap: it skips any record that already
carries `inForce` and any celex already answered in `data/in-force.json`, so it
never re-asks Cellar about a status once known. Because `inForce` is
time-varying (an act can be repealed after its first harvest), that first-ever
value would otherwise be carried forward indefinitely.
`search/in-force-recheck.js` is the periodic counterpart: it clears the field
and re-queries Cellar (issue #167). It runs automatically as a step of
`refresh-data.yml`; run it by hand only to patch a published cache out of band:

```bash
node --max-old-space-size=8192 search/in-force-recheck.js
```

It re-checks **every** act in the cache. Skipping the ~63% already reading
`inForce: false` (50,397 of 80,535 in `data-v12`) looks like free money and is
not: `false` is not terminal. An act is harvested when it is published, which is
normally *before* it enters into force, so Cellar answers `0` and the cache
records it — then the act enters into force and the answer becomes `1`. Measured
on `data-v12`, 13 acts had already made that transition unnoticed, 12 of them
2026 acts with entry-into-force dates in July 2026, plus one 2023 decision whose
validity was extended (`32023D2440`). Skipping `false` would strand exactly the
newest legislation permanently mislabelled. At 100 CELEX ids per SPARQL batch
and 200–400 ms per batch, the full sweep is ~806 requests: there is deliberately
no slicing, batch budget or turnover cycle, because at that cost a partial
re-check would only buy staleness back.

It also runs with `useJournal: false`, so `data/in-force.json` is neither read
nor written. The run is all-or-nothing — the cache is written once, at the end —
so there is nothing to resume from, and journalling would only rewrite an
80k-entry file every few batches. The builders keep the journal; an interrupted
multi-hour harvest genuinely needs it.

Both this and `fetch-in-force.js` query Cellar **unaggregated**, collapsing
fan-out client-side in `reduceBindings`. The earlier
`SELECT ... (SAMPLE(?inForceValue) AS ?inForce) (MIN(?endValue) AS ?endOfValidity)
... GROUP BY ?celex` mis-assigned values across groups at batch scale: in a real
100-CELEX batch, 32006R0988 (end-of-validity 2020-12-31) and 32006R1066 (the
9999-12-31 sentinel) both came back as 2020-12-31, while the same batch
unaggregated — and 32006R1066 queried alone — returned the sentinel correctly.
The wrong value is stable for a given batch and moves when the batch composition
moves, so it cannot be retried away; it silently writes one act's expiry date
onto another. Do not reintroduce a server-side `GROUP BY` here.

Two properties matter to the pipeline it runs in:

- **It rewrites the cache only if a status actually moved.** Confirming 30k
  unchanged statuses leaves the file byte-identical, so `refresh-data.yml`'s
  change digest still reports "unchanged" and no data release — and no
  Docker tag PR — is cut on a quiet month.
- **It refuses to write a degraded result.** If more than `--max-null-ratio`
  (default 5%) of the re-checked records lose a previously known status, Cellar
  is answering but degraded, and publishing would erode the status coverage
  `backend-docker.yml` asserts (>80%, currently 87%). The run fails instead.

Flags: `--limit N` caps the run for a smoke test; `--no-gz` skips the `.gz`
sidecar when the caller gzips the JSON itself, as the workflow does;
`--max-null-ratio R` adjusts the degradation guard.

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

Publish `search-cache.json.gz` as the next data release asset and bump
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
| `FMX_DOM_SHIM_RECYCLE` | Parses between replacements of the shared jsdom DOM-shim window used by Formex parsing. jsdom pins every selector-queried XML document to its window, so long-lived processes (API server, build workers) would otherwise retain each parsed act until exit; replacing the window releases them. `0` disables. Default `25`. |
| `PARSER_POOL_SIZE` | Number of persistent serving parser workers for Formex and EUR-Lex HTML fallback parsing. `0` disables the pool and uses inline parsing. Default `2`. |
| `PARSER_WORKER_HEAP_MB` | Maximum old-space heap per serving parser worker. Default `640`. |
| `HTML_CACHE_LIMIT_MB` | Max size of the legacy-HTML fallback cache. Default `200`. |
| `RATE_LIMIT_MAX` | Per-IP request cap for the 15-minute window. |
| `GENERATION_LIMIT_MAX` | Per-IP cap on *billed* AI generations per window, applied to the four generation routes. Only cache misses are charged. Default `10`. |
| `GENERATION_LIMIT_WINDOW_MS` | Window for `GENERATION_LIMIT_MAX`. Default `3600000` (1 hour). |
| `AI_ALLOWED_ORIGINS` | Comma-separated browser origins allowed to call the generation routes. Requests with no `Origin` header are always allowed; `*` disables the check. Defaults to the legalviz.eu origins plus the Vite dev ports. |
| `OPENROUTER_MAX_CONCURRENCY` | Max concurrent OpenRouter calls in this process. Default `3`. |
| `OPENROUTER_MAX_QUEUE` | Max OpenRouter calls queued behind that limit before new ones are rejected with 429. Default `20`. |
| `HTML_FETCH_CONCURRENCY` | Max concurrent EUR-Lex HTML fetches (each can launch a Chromium during a WAF challenge). Default `2`. |
| `HTML_FETCH_QUEUE_LIMIT` | Max HTML fetches queued behind that limit before new ones get a 503. Default `20`. |
| `HTML_EMPTY_PARSE_TTL_MS` | How long a CELEX that fetched but parsed to no content is remembered, so it isn't re-fetched on every request. Default `600000` (10 minutes). |
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
| `LAW_SUMMARY_MODEL` | Model for cached law summaries. Default falls back through `ARTICLE_QA_ANSWER_MODEL`, `ARTICLE_QA_MODEL`, then `google/gemini-3.5-flash-lite`. |
| `ARTICLE_DIGEST_MODEL` | Model for cached article case-law digests. Default falls back through `LAW_SUMMARY_MODEL`, `ARTICLE_QA_ANSWER_MODEL`, `ARTICLE_QA_MODEL`, then `google/gemini-3.5-flash-lite`. |
| `ARTICLE_QA_MODEL` / `ARTICLE_QA_ANSWER_MODEL` | Legacy model fallbacks still accepted for static summary generation. |
| `ARTICLE_QA_PLANNER_MODEL` | Legacy model fallback used only by recital-title defaults. |
| `RECITAL_TITLE_MODEL` | Model for cached AI-generated recital titles. Default `google/gemini-3.5-flash-lite`. |
| `PLAYWRIGHT_HEADLESS` / `PLAYWRIGHT_BROWSERS_PATH` / `PLAYWRIGHT_MODULE_PATH` / `LEGALVIZ_PLAYWRIGHT_MODULE_PATH` | Playwright configuration for fetching laws that require rendering. |

**OpenRouter spend cap:** the production deployment relies on an account-level spend limit configured in the OpenRouter dashboard as the hard ceiling on AI-feature cost. The API adds three softer guards in front of it: a per-IP generation budget charged only on cache misses (`GENERATION_LIMIT_MAX`), an origin allowlist on the generation routes (`AI_ALLOWED_ORIGINS`, while CORS stays permissive everywhere else), and a cap on concurrent model calls (`OPENROUTER_MAX_CONCURRENCY`). None of them replaces the dashboard limit — any key used in deployment should carry one. When the limit is exhausted, cache misses on the AI endpoints start failing (OpenRouter rejects the calls) while already-cached titles, summaries, and digests keep serving normally.

## Notes

- FMX fetching and search are separate concerns. Search does not download FMX files.
- `/api/search` prefers primary acts and deprioritizes implementing/delegated/corrigendum material.
- Search quality is strongest for CELEX, `type + year/number`, and well-titled flagship laws.
- The builder is resumable, but a partially enriched cache is still only best-effort for relevance.

## License

MIT
