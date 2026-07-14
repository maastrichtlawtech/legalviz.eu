# Official Playwright image: bundles Node.js (22 LTS), the browser binaries,
# and all of Chromium's system dependencies, so the build needs neither an
# apt-get step nor a browser download from cdn.playwright.dev.
#
# The image tag MUST match the playwright-core version pinned in
# package-lock.json (1.58.2). The baked-in browser revision (chromium v1208)
# then matches exactly what playwright-core looks for at runtime.
FROM mcr.microsoft.com/playwright:v1.58.2-noble

# The official image installs its browsers here; point playwright-core at them.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Safety net: confirm the browsers our exact playwright-core version needs are
# present. With the matching base image this is a fast no-op ("is already
# installed"); if anything were missing it would be fetched, so the files are
# guaranteed to exist at runtime. Uses the local playwright-core CLI (the
# version pinned in node_modules) rather than `npx playwright`, which would
# fetch the latest playwright package from the registry on every build.
RUN PW_VERSION=$(node -p "require('playwright-core/package.json').version") \
    && echo "Verifying Playwright browsers for version $PW_VERSION" \
    && node node_modules/playwright-core/cli.js install chromium chromium-headless-shell

# Surface what actually landed in the browser cache so build logs reveal any
# path/variant changes without failing the build.
RUN ls -1 /ms-playwright/ || true

# Precomputed data caches are NOT committed to git — a ~48 MB blob would bloat
# history permanently. They ship as GitHub Release assets (public repo, no auth)
# and are fetched here into the exact paths the server reads at startup:
#   search/data/search-cache.json.gz      -> gunzipped by legal-cache-store.js
#   search/data/case-law-cache-v5.json.gz -> materialized by law-queries.js
#   search/data/citation-graph.json.gz     -> gunzipped by citation-graph-store.js
# Placed before `COPY . .` so this (large) layer stays cached across code
# changes and only re-runs when DATA_RELEASE_TAG is bumped for a new data build.
ARG DATA_RELEASE_REPO=maastrichtlawtech/legalviz.eu
ARG DATA_RELEASE_TAG=data-v5
RUN command -v curl >/dev/null 2>&1 \
    || (apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*)
RUN mkdir -p search/data \
    && for asset in search-cache.json.gz case-law-cache-v5.json.gz citation-graph.json.gz; do \
         echo "Fetching data asset: $asset ($DATA_RELEASE_TAG)" \
         && curl -fSL --retry 3 --retry-delay 2 \
              -o "search/data/$asset" \
              "https://github.com/${DATA_RELEASE_REPO}/releases/download/${DATA_RELEASE_TAG}/$asset"; \
       done \
    && ls -lh search/data/*.gz

COPY . .

# Ensure cache directory exists (can be overridden with Railway volume mount via CACHE_DIR)
RUN mkdir -p law-cache

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
