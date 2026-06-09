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

COPY . .

# Ensure cache directory exists (can be overridden with Railway volume mount via CACHE_DIR)
RUN mkdir -p law-cache

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
