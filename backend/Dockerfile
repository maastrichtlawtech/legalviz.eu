# Keep the Playwright image and playwright-core package on the same version so
# Chromium's baked-in revision matches what the runtime expects.
FROM mcr.microsoft.com/playwright:v1.58.2-noble AS runtime

RUN command -v curl >/dev/null 2>&1 \
    || (apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*)

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

FROM runtime AS dependencies

WORKDIR /app

COPY package.json package-lock.json* ./
# better-sqlite3 installs by downloading a prebuilt binary and, when that
# download fails, falling back to `node-gyp rebuild` — which can never succeed
# here, because the Playwright base image ships no compiler toolchain, so the
# fallback dies on "not found: make". That turns a momentary blip
# ("prebuild-install warn install socket hang up") into a failed build of an
# otherwise unchanged image. Retry instead, the way the data-asset fetch below
# already does with `curl --retry`.
RUN set -eu; \
    for attempt in 1 2 3; do \
      if npm ci --omit=dev; then exit 0; fi; \
      echo "npm ci failed (attempt ${attempt} of 3); retrying" >&2; \
      rm -rf node_modules; \
      sleep 5; \
    done; \
    echo "npm ci failed after 3 attempts" >&2; \
    exit 1

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
#   search/data/search-cache.json.gz    -> title/alias index + FTS5 excerpts
#   search/data/case-law-cache.json.gz  -> folded into data.sqlite
#   search/data/citation-graph.json.gz  -> folded into data.sqlite
#   search/data/definitions.json.gz     -> optional definition search index
# Placed before `COPY . .` so this (large) layer stays cached across code
# changes and only re-runs when DATA_RELEASE_TAG is bumped for a new data build.
# Release tags are dated: <train>-YYYY-MM-DD.NN, where NN is a same-day
# sequence starting at 01 (data-2026-08-21.02). The older <train>-vN tags are
# still valid pins for the releases that already carry them, but the refresh
# workflows never mint another one — see .github/scripts/release-tags.sh.
ARG DATA_RELEASE_REPO=maastrichtlawtech/legalviz.eu
ARG DATA_RELEASE_TAG=data-2026-08-22.01
# The full-text index ships on its own release tag, decoupled from the data
# train — see FULLTEXT_RELEASE_TAG in the root CLAUDE.md cache-invalidation
# table.
ARG FULLTEXT_RELEASE_TAG=fulltext-2026-08-22.01
# Every asset comes from this one tag, so a new release must carry the full set —
# re-upload the unchanged ones alongside the changed one or this fetch 404s.
# citation-graph.json.gz is a *build input* like the others: it is folded into
# data.sqlite here and never ships in the runtime image (as raw JSON it is ~373 MB
# and would cost >1 GB resident to load).
# `--retry 3 --retry-delay 2` gave up after ~7 seconds, which is shorter than a
# routine GitHub release-CDN wobble: four 503s inside 7s failed a build whose
# assets were downloadable a minute later. Dropping --retry-delay restores
# curl's exponential backoff (1s, 2s, 4s …), so 6 attempts now span ~60s, and
# --retry-all-errors covers the resets and partial transfers curl otherwise
# treats as permanent on a ~50 MB download. Note it also retries a 404, so a
# DATA_RELEASE_TAG pointing at a release that is missing an asset now takes the
# full backoff to fail rather than erroring immediately -- still a hard failure,
# just a slower one, with every 404 visible in the build log.
RUN mkdir -p search/data \
    && for asset in search-cache.json.gz case-law-cache.json.gz citation-graph.json.gz; do \
         echo "Fetching data asset: $asset ($DATA_RELEASE_TAG)" \
         && curl -fSL --retry 6 --retry-all-errors --retry-max-time 300 \
              -o "search/data/$asset" \
              "https://github.com/${DATA_RELEASE_REPO}/releases/download/${DATA_RELEASE_TAG}/$asset"; \
       done \
    && (curl -fSL --retry 6 --retry-all-errors --retry-max-time 300 \
          -o /tmp/definitions.json.gz \
          "https://github.com/${DATA_RELEASE_REPO}/releases/download/${DATA_RELEASE_TAG}/definitions.json.gz" \
        && mv /tmp/definitions.json.gz search/data/definitions.json.gz \
        || echo "Optional definitions asset is not present in $DATA_RELEASE_TAG") \
    && (curl -fSL --retry 6 --retry-all-errors --retry-max-time 300 \
          -o /tmp/fulltext.sqlite.gz \
          "https://github.com/${DATA_RELEASE_REPO}/releases/download/${FULLTEXT_RELEASE_TAG}/fulltext.sqlite.gz" \
        && gunzip -c /tmp/fulltext.sqlite.gz > search/data/fulltext.sqlite \
        && rm -f /tmp/fulltext.sqlite.gz \
        || { echo "Optional fulltext asset is not present in $FULLTEXT_RELEASE_TAG"; \
             touch search/data/fulltext.sqlite; }) \
    && node search/build-sqlite-data.js \
    && ls -lh search/data/data.sqlite search/data/data.sqlite.manifest.json

FROM dependencies AS final

COPY . .
COPY --from=data-builder /app/search/data/data.sqlite ./search/data/data.sqlite
COPY --from=data-builder /app/search/data/data.sqlite.manifest.json ./search/data/data.sqlite.manifest.json
# fulltext.sqlite is optional (own fulltext release train, see FULLTEXT_RELEASE_TAG
# above): the data-builder stage always leaves a file at this path — the real gunzip'd
# asset, or an empty placeholder `touch`ed when the release asset was absent — so this
# COPY never fails the build. legal-cache-store.js treats a missing/invalid/empty
# database as fulltextAvailable=false at boot, the same non-fatal pattern used for
# definitionsAvailable and the citation graph.
COPY --from=data-builder /app/search/data/fulltext.sqlite ./search/data/fulltext.sqlite

RUN mkdir -p law-cache

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
