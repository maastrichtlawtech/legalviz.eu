// Warm EUR-Lex WAF/Cloudflare session cookies once with a headless browser, then
// reuse them for cheap plain-`fetch` requests. This mirrors what the server's
// case-law path (law-queries.js `warmEurlexCookies`) does, so bulk downloading
// does NOT open every page in Chromium — the browser is used only to solve the
// challenge and hand back the `cookie` + `user-agent`, and again only when the
// cookies expire (a 202 challenge reappears).

const fs = require("fs");
const path = require("path");

const {
  loadPlaywrightModule,
  getSharedPlaywrightPage,
  closeSharedPlaywrightBrowser,
} = require("./eurlex-html-parser");

const HOMEPAGE_URL = "https://eur-lex.europa.eu/homepage.html";

let warmCookieHeader = null;
let warmUserAgent = null;

function cookiesFilePath(cacheDir) {
  return path.join(cacheDir, "eurlex-cookies.json");
}

function loadCookiesFromDisk(cacheDir) {
  if (!cacheDir) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(cookiesFilePath(cacheDir), "utf8"));
    if (raw && raw.cookies) {
      warmCookieHeader = raw.cookies;
      warmUserAgent = raw.userAgent || null;
      return getWarmHeaders();
    }
  } catch {
    // no cached cookies yet
  }
  return null;
}

function saveCookiesToDisk(cacheDir, cookies, userAgent) {
  if (!cacheDir) return;
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const tmp = path.join(cacheDir, `eurlex-cookies.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ cookies, userAgent, savedAt: new Date().toISOString() }));
    fs.renameSync(tmp, cookiesFilePath(cacheDir));
  } catch {
    // best-effort
  }
}

function getWarmHeaders() {
  if (!warmCookieHeader) return null;
  return { cookie: warmCookieHeader, "user-agent": warmUserAgent || "Mozilla/5.0" };
}

function invalidateCookies(cacheDir) {
  warmCookieHeader = null;
  warmUserAgent = null;
  if (cacheDir) {
    try { fs.unlinkSync(cookiesFilePath(cacheDir)); } catch { /* ok */ }
  }
}

// Drive the browser once to obtain fresh WAF cookies + the browser's UA, then
// close the browser (plain fetch does the rest). Returns the warm headers.
async function warmCookies({ cacheDir = null, headless = true, playwrightModulePath = null, playwrightBrowsersPath = null } = {}) {
  const playwright = await loadPlaywrightModule(playwrightModulePath || process.env.PLAYWRIGHT_MODULE_PATH || null);
  try {
    const page = await getSharedPlaywrightPage(playwright, {
      playwrightBrowsersPath: playwrightBrowsersPath || process.env.PLAYWRIGHT_BROWSERS_PATH || null,
      headless,
    });
    await page.goto(HOMEPAGE_URL, { waitUntil: "domcontentloaded", timeout: 20_000 });
    try {
      await page.waitForLoadState("networkidle", { timeout: 15_000 });
    } catch {
      // networkidle may time out on a challenge page — proceed anyway
    }
    const cookies = await page.context().cookies();
    warmCookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    warmUserAgent = await page.evaluate(() => navigator.userAgent);
    saveCookiesToDisk(cacheDir, warmCookieHeader, warmUserAgent);
    return { headers: getWarmHeaders(), count: cookies.length };
  } finally {
    // We only need the cookies; don't keep a browser resident during bulk fetch.
    await closeSharedPlaywrightBrowser().catch(() => {});
  }
}

// Return warm headers, loading from disk or warming a browser if needed.
async function ensureWarmHeaders({ cacheDir = null, headless = true } = {}) {
  if (getWarmHeaders()) return getWarmHeaders();
  if (loadCookiesFromDisk(cacheDir)) return getWarmHeaders();
  await warmCookies({ cacheDir, headless });
  return getWarmHeaders();
}

module.exports = {
  HOMEPAGE_URL,
  ensureWarmHeaders,
  getWarmHeaders,
  invalidateCookies,
  loadCookiesFromDisk,
  saveCookiesToDisk,
  warmCookies,
};
