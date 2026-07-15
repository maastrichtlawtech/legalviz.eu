# Keep the Playwright image and playwright-core package on the same version so
# Chromium's baked-in revision matches what the runtime expects.
FROM mcr.microsoft.com/playwright:v1.58.2-noble AS runtime

RUN command -v curl >/dev/null 2>&1 \
    || (apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*)

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

FROM runtime AS dependencies

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Verify the native SQLite binding, FTS5, and the exact Playwright browser
# revision before either the data build or final image proceeds.
RUN node -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.exec('CREATE VIRTUAL TABLE test_fts USING fts5(value)'); db.close();" \
    && PW_VERSION=$(node -p "require('playwright-core/package.json').version") \
    && echo "Verifying Playwright browsers for version $PW_VERSION" \
    && node node_modules/playwright-core/cli.js install chromium chromium-headless-shell \
    && ls -1 /ms-playwright/

FROM dependencies AS data-builder

# Only these converter sources participate in the expensive data layer's cache
# key. Normal application changes do not force the release assets to be fetched
# and converted again.
COPY search/build-sqlite-data.js search/search-ranking.js ./search/

# Precomputed data caches are NOT committed to git — a ~48 MB blob would bloat
# history permanently. They ship as GitHub Release assets (public repo, no auth)
# and are fetched here, then converted into the runtime SQLite store:
#   search/data/search-cache.json.gz      -> title/alias index + FTS5 excerpts
#   search/data/case-law-cache-v5.json.gz -> folded into data.sqlite
#   search/data/citation-graph.json.gz     -> gunzipped by citation-graph-store.js
# Placed before `COPY . .` so this (large) layer stays cached across code
# changes and only re-runs when DATA_RELEASE_TAG is bumped for a new data build.
ARG DATA_RELEASE_REPO=maastrichtlawtech/legalviz.eu
ARG DATA_RELEASE_TAG=data-v6
RUN mkdir -p search/data \
    && for asset in search-cache.json.gz case-law-cache-v5.json.gz citation-graph.json.gz; do \
         echo "Fetching data asset: $asset ($DATA_RELEASE_TAG)" \
         && curl -fSL --retry 3 --retry-delay 2 \
              -o "search/data/$asset" \
              "https://github.com/${DATA_RELEASE_REPO}/releases/download/${DATA_RELEASE_TAG}/$asset"; \
       done \
    && node search/build-sqlite-data.js \
    && ls -lh search/data/data.sqlite search/data/data.sqlite.manifest.json

FROM dependencies AS final

COPY . .
COPY --from=data-builder /app/search/data/data.sqlite ./search/data/data.sqlite
COPY --from=data-builder /app/search/data/data.sqlite.manifest.json ./search/data/data.sqlite.manifest.json
COPY --from=data-builder /app/search/data/citation-graph.json.gz ./search/data/citation-graph.json.gz

RUN mkdir -p law-cache

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
