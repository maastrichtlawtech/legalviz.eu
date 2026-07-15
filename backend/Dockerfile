# Keep the Playwright image and playwright-core package on the same version so
# Chromium's baked-in revision matches what the runtime expects.
FROM mcr.microsoft.com/playwright:v1.58.2-noble AS runtime

# node:sqlite is part of Node. Pin the major line used by this repository while
# retaining Playwright's browser binaries and Ubuntu system dependencies.
RUN command -v curl >/dev/null 2>&1 \
    || (apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*)
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node --version \
    && node -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(':memory:'); db.exec('CREATE VIRTUAL TABLE test_fts USING fts5(value)'); db.close();"

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

FROM runtime AS data-builder

WORKDIR /app

# Only these converter sources participate in the expensive data layer's cache
# key. Normal application changes do not force the release assets to be fetched
# and converted again.
COPY search/build-sqlite-data.js search/search-ranking.js ./search/

ARG DATA_RELEASE_REPO=maastrichtlawtech/legalviz.eu
ARG DATA_RELEASE_TAG=data-v6
RUN mkdir -p search/data \
    && for asset in search-cache.json.gz case-law-cache-v5.json.gz; do \
         echo "Fetching data asset: $asset ($DATA_RELEASE_TAG)" \
         && curl -fSL --retry 3 --retry-delay 2 \
              -o "search/data/$asset" \
              "https://github.com/${DATA_RELEASE_REPO}/releases/download/${DATA_RELEASE_TAG}/$asset"; \
       done \
    && node search/build-sqlite-data.js \
    && ls -lh search/data/data.sqlite

FROM runtime AS final

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Confirm the exact package can find the browsers baked into the matching image.
RUN PW_VERSION=$(node -p "require('playwright-core/package.json').version") \
    && echo "Verifying Playwright browsers for version $PW_VERSION" \
    && node node_modules/playwright-core/cli.js install chromium chromium-headless-shell \
    && ls -1 /ms-playwright/

COPY . .
COPY --from=data-builder /app/search/data/data.sqlite ./search/data/data.sqlite

RUN mkdir -p law-cache

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
