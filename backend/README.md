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
| `GET` | `/api/laws/:celex/articles/:n/case-law-digest?lang=ENG` | Cached static digest of CJEU case law interpreting one article. Zero-case results are cached without an LLM call. |
| `GET` | `/api/laws/by-reference?actType=...&year=...&number=...` | Fetch law by official reference |
| `GET` | `/api/search?q=keyword&limit=10` | Search law metadata |
| `GET` | `/api/resolve-reference?actType=...&year=...&number=...` | Resolve legal reference to CELEX |
| `GET` | `/api/resolve-url?url=...` | Resolve EUR-Lex URL to CELEX |

`/api/search` searches a local metadata cache of primary regulations/directives/decisions.

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
    "structure": "…",
    "relatedInstruments": [
      { "label": "Directive 95/46/EC", "celex": "31995L0046", "relationship": "…" }
    ]
  }
}
```

`GET /api/laws/:celex/articles/:n/case-law-digest?lang=ENG` returns a cached article-level digest:

```json
{
  "celex": "32016R0679",
  "articleNumber": "6",
  "lang": "ENG",
  "caseLawCacheVersion": "case-law-cache-v4",
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

Both endpoints validate generated JSON and citations before writing cache files. The backend stores summaries in `law-summary-cache-v1.json` and digests in `article-digest-cache-v1.json`, with cache version, prompt/schema version, source hash, model, and generation timestamp.

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
   ├─ case-law-parser.js         # Parses CJEU judgments (FMX + pre-2004 OJ HTML + Curia HTML)
   ├─ article-bundle.js          # Preserved bundle assembler for future cross-corpus Ask work
   ├─ article-qa-service.js      # Preserved planner + prompt logic for future Ask work
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

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Port for the API server. |
| `CACHE_DIR` | Directory for cached FMX/XML/ZIP downloads and derived artefacts. Defaults to `backend/law-cache` for the API. The CLI also respects legacy `FMX_DIR`. |
| `STORAGE_LIMIT_MB` | Max size of the FMX download cache before eviction starts. Default `500`. |
| `HTML_CACHE_LIMIT_MB` | Max size of the legacy-HTML fallback cache. Default `200`. |
| `RATE_LIMIT_MAX` | Per-IP request cap for the 15-minute window. |
| `TIMEOUT_MS` | HTTP request timeout in ms. Default `30000`. |
| `SEARCH_CACHE_PATH` | Optional override for the search cache JSON path. |
| `ANALYTICS_TOKEN` | Optional Plausible/analytics token for the `/api/_stats` endpoint. |
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
| `EURLEX_COOKIE_MAX_AGE_MS` | How long to reuse an EUR-Lex session cookie. |
| `PLAYWRIGHT_HEADLESS` / `PLAYWRIGHT_BROWSERS_PATH` / `PLAYWRIGHT_MODULE_PATH` / `LEGALVIZ_PLAYWRIGHT_MODULE_PATH` | Playwright configuration for fetching laws that require rendering. |

## Notes

- FMX fetching and search are separate concerns. Search does not download FMX files.
- `/api/search` prefers primary acts and deprioritizes implementing/delegated/corrigendum material.
- Search quality is strongest for CELEX, `type + year/number`, and well-titled flagship laws.
- The builder is resumable, but a partially enriched cache is still only best-effort for relevance.

## License

MIT
