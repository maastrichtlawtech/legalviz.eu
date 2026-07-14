// Downloads the raw EUR-Lex HTML for acts that have NO FMX manifestation, into
// the HTML corpus (laws-html/<year>/<CELEX>.html.gz). This is the fallback
// source for the ~137k mostly pre-2000 acts the FMX harvest could not reach.
//
// It only DOWNLOADS — no parsing. The HTML endpoint (eur-lex.europa.eu) is WAF-
// protected, so we try a plain fetch first and fall back to the shared Playwright
// browser on a challenge (the same workaround the app uses). Because the shared
// browser exposes a single page, fetches run sequentially (concurrency 1);
// parallelism comes from running several sharded worker PROCESSES.
//
// Resumable: a CELEX targets list is processed in order, advancing `nextIndex`
// in a small state file. Already-downloaded acts are skipped (corpus-first), so
// a resumed/re-run pass never re-fetches. 404s and transient failures are
// appended to sidecar files so a later pass can retry just the failures.

const fs = require("fs");
const fsp = require("fs/promises");

const { hasCorpusHtml, writeCorpusHtml } = require("./law-corpus-store");
const { ensureWarmHeaders, getWarmHeaders, invalidateCookies, warmCookies } = require("../shared/eurlex-cookies");

const DEFAULT_EURLEX_BASE = "https://eur-lex.europa.eu";

function isChallengeResponse(res) {
  return res.status === 202
    && String(res.headers.get("x-amzn-waf-action") || "").toLowerCase() === "challenge";
}

// EUR-Lex serves a 200 "site shell" (chrome only, no law text) for acts that
// have no HTML rendition — instead of a 404. The shell carries the message
// "The requested document does not exist." and none of the document-content
// containers a real page has. Detecting it lets us record a permanent miss
// rather than saving ~85 KB of navigation as if it were a law. We require BOTH
// the shell phrase AND the absence of any content container, so a genuine
// document is never discarded.
const SHELL_PHRASE = /the requested document does not exist/i;
const CONTENT_CONTAINER = /id="TexteOnly"|<TXT_TE|class="[^"]*\b(?:oj-ti-art|eli-subdivision)\b/i;

function isEmptyShellHtml(html) {
  const text = String(html || "");
  if (CONTENT_CONTAINER.test(text)) return false;
  return SHELL_PHRASE.test(text);
}

// Download one act's raw HTML with warm WAF cookies over a plain fetch. The
// headless browser is only touched to (re)warm cookies on a 202 challenge — not
// per page — so bulk downloading stays cheap.
async function fetchHtmlWithWarmCookies({ celex, eurlexBase, cacheDir, timeoutMs = 45_000 }) {
  const url = `${eurlexBase}/legal-content/EN/TXT/HTML/?uri=CELEX:${encodeURIComponent(celex)}`;
  await ensureWarmHeaders({ cacheDir });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: { "accept-language": "en", ...(getWarmHeaders() || {}) },
      });

      if (isChallengeResponse(res)) {
        invalidateCookies(cacheDir);
        await warmCookies({ cacheDir });
        continue;
      }
      if (res.status === 404) {
        const error = new Error(`No EUR-Lex HTML law found for ${celex}`);
        error.code = "law_not_found";
        throw error;
      }
      if (!res.ok) {
        const error = new Error(`EUR-Lex HTML fetch failed with HTTP ${res.status} for ${celex}`);
        error.statusCode = res.status;
        throw error;
      }
      return { celex, rawHtml: await res.text() };
    } finally {
      clearTimeout(timeout);
    }
  }

  const error = new Error(`EUR-Lex WAF challenge persisted for ${celex}`);
  error.code = "eurlex_html_challenged";
  throw error;
}

function logProgress(message) {
  console.log(`[html-harvest] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readState(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

async function writeStateAtomically(statePath, state) {
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fsp.rename(tempPath, statePath);
}

function readTargets(targetsPath) {
  return fs.readFileSync(targetsPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function ensurePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// A 404 means EUR-Lex simply has no HTML rendition for this act (common for very
// old / image-only acts) — a permanent miss, not worth retrying.
function isPermanentMiss(error) {
  return error?.code === "law_not_found" || error?.statusCode === 404;
}

async function harvestHtml(options = {}) {
  const targetsPath = options.targets;
  const statePath = options.statePath;
  const corpusDir = options.corpusDir;
  if (!targetsPath || !statePath || !corpusDir) {
    throw new Error("html-harvest requires --targets, --statePath and --corpusDir");
  }
  const eurlexBase = options.eurlexBase || DEFAULT_EURLEX_BASE;
  const maxRecords = options.maxRecords ? ensurePositiveInt(options.maxRecords, 0) : 0;
  const delayMs = Math.max(0, Number.parseInt(String(options.delayMs ?? "250"), 10) || 0);
  const timeoutMs = ensurePositiveInt(options.timeoutMs, 45_000);
  // Cookies (and their on-disk cache) live in the corpus dir so all workers
  // share one warmed session.
  const cacheDir = options.cookieCacheDir || corpusDir;
  const fetchImpl = options.fetchLawImpl || fetchHtmlWithWarmCookies;

  const targets = readTargets(targetsPath);
  const prior = readState(statePath) || {};
  const startIndex = ensurePositiveInt(prior.nextIndex, 0);
  const missesPath = `${statePath}.misses.txt`;
  const failsPath = `${statePath}.fails.txt`;

  let saved = ensurePositiveInt(prior.saved, 0);
  let skipped = ensurePositiveInt(prior.skipped, 0);
  let missing = ensurePositiveInt(prior.missing, 0);
  let failed = ensurePositiveInt(prior.failed, 0);

  logProgress(`Targets ${targets.length}, resuming at ${startIndex} (saved=${saved} missing=${missing} failed=${failed})`);

  // `visitedThisRun` drives the checkpoint cadence (every target we look at,
  // including cheap skips). `fetchedThisRun` bounds maxRecords, which exists to
  // recycle the process against slow memory growth — only real downloads cost
  // memory, so an all-skipped resume region shouldn't exhaust the budget.
  let visitedThisRun = 0;
  let fetchedThisRun = 0;
  let index = startIndex;

  for (; index < targets.length; index += 1) {
    if (maxRecords && fetchedThisRun >= maxRecords) break;
    const celex = targets[index];
    visitedThisRun += 1;

    if (hasCorpusHtml(corpusDir, celex)) {
      skipped += 1;
    } else {
      fetchedThisRun += 1;
      try {
        const result = await fetchImpl({ celex, eurlexBase, cacheDir, timeoutMs });
        if (result?.rawHtml && !isEmptyShellHtml(result.rawHtml)) {
          await writeCorpusHtml(corpusDir, celex, result.rawHtml);
          saved += 1;
        } else {
          // No rawHtml, or a chrome-only "does not exist" shell — permanent miss.
          missing += 1;
          fs.appendFileSync(missesPath, `${celex}\n`);
        }
      } catch (error) {
        if (isPermanentMiss(error)) {
          missing += 1;
          fs.appendFileSync(missesPath, `${celex}\n`);
        } else {
          failed += 1;
          fs.appendFileSync(failsPath, `${celex}\t${String(error.message || error).slice(0, 120)}\n`);
        }
      }
      if (delayMs) await sleep(delayMs);
    }

    if (visitedThisRun % 20 === 0 || index + 1 === targets.length) {
      await writeStateAtomically(statePath, {
        nextIndex: index + 1, total: targets.length, saved, skipped, missing, failed,
        finished: index + 1 >= targets.length, updatedAt: new Date().toISOString(),
      });
      logProgress(`${index + 1}/${targets.length}  saved=${saved} skipped=${skipped} missing=${missing} failed=${failed}`);
    }
  }

  const finished = index >= targets.length;
  await writeStateAtomically(statePath, {
    nextIndex: index, total: targets.length, saved, skipped, missing, failed,
    finished, updatedAt: new Date().toISOString(),
  });
  return { nextIndex: index, total: targets.length, saved, skipped, missing, failed, finished };
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith("--")) { options[key] = true; }
    else { options[key] = next; i += 1; }
  }
  const result = await harvestHtml(options);
  logProgress(`Done pass: ${JSON.stringify(result)}`);
}

if (require.main === module) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { harvestHtml, isEmptyShellHtml, isPermanentMiss };
