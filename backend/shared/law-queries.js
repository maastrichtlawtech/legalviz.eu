/**
 * Shared SPARQL-based queries for law metadata, amendments, and implementing acts.
 *
 * Used by both the API routes and the CLI to avoid duplicating queries
 * and result-shaping logic.
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { getSharedPlaywrightPage, loadPlaywrightModule } = require('./eurlex-html-parser');
const {
  ACT_CELEX_MAP,
  CITATION_PARSER_VERSION,
  extractArticleCitationsFromText,
  hydrateContextualRefs,
  parseCitationsToRefs,
} = require('./case-law-parser');

const EURLEX_COOKIE_MAX_AGE_MS = parseInt(process.env.EURLEX_COOKIE_MAX_AGE_MS) || 12 * 60 * 60 * 1000; // 12h
const PARTIAL_RETRY_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h

let warmCookieHeader = null;
let warmUserAgent = null;
let cookieWarmPromise = null;
let warmFailedAt = 0;
const WARM_FAILURE_COOLDOWN_MS = 5 * 60 * 1000; // don't retry Playwright more than once per 5 min

// In-flight enrichment coalescing: celex -> Promise<void>
const enrichInFlight = new Map();

async function fetchMetadata(celex, runSparqlQuery) {
  const celexUri = `http://publications.europa.eu/resource/celex/${celex}`;
  const query = `
PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
PREFIX owl: <http://www.w3.org/2002/07/owl#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT DISTINCT
  ?dateEntryIntoForce ?dateEndOfValidity ?inForce
  ?eli ?dateSignature ?dateDocument ?eea
WHERE {
  ?work owl:sameAs <${celexUri}> .
  OPTIONAL { ?work cdm:resource_legal_date_entry-into-force ?dateEntryIntoForce }
  OPTIONAL { ?work cdm:resource_legal_date_end-of-validity ?dateEndOfValidity }
  OPTIONAL { ?work cdm:resource_legal_in-force ?inForce }
  OPTIONAL { ?work cdm:resource_legal_eli ?eli }
  OPTIONAL { ?work cdm:resource_legal_date_signature ?dateSignature }
  OPTIONAL { ?work cdm:work_date_document ?dateDocument }
  OPTIONAL { ?work cdm:resource_legal_eea ?eea }
}
LIMIT 10`;

  const data = await runSparqlQuery(query);
  const bindings = data.results?.bindings || [];
  const entryDates = [...new Set(bindings.map((b) => b.dateEntryIntoForce?.value).filter(Boolean))].sort();
  const first = bindings[0] || {};

  return {
    celex,
    entryIntoForce: entryDates,
    endOfValidity: first.dateEndOfValidity?.value || null,
    inForce: first.inForce?.value === 'true',
    eli: first.eli?.value || null,
    dateSignature: first.dateSignature?.value || null,
    dateDocument: first.dateDocument?.value || null,
    eea: first.eea?.value === 'true',
  };
}

async function fetchAmendments(celex, runSparqlQuery) {
  const celexUri = `http://publications.europa.eu/resource/celex/${celex}`;
  const query = `
PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
PREFIX owl: <http://www.w3.org/2002/07/owl#>
SELECT DISTINCT ?type ?sourceCelex ?date WHERE {
  ?work owl:sameAs <${celexUri}> .
  ?ax owl:annotatedTarget ?work ;
      owl:annotatedProperty ?p ;
      owl:annotatedSource ?sourceWork .
  FILTER(?p IN (cdm:resource_legal_amends_resource_legal, cdm:resource_legal_corrects_resource_legal))
  BIND(IF(?p = cdm:resource_legal_corrects_resource_legal, "corrigendum", "amendment") AS ?type)
  ?sourceWork owl:sameAs ?sourceCelex .
  FILTER(STRSTARTS(STR(?sourceCelex), "http://publications.europa.eu/resource/celex/"))
  OPTIONAL { ?sourceWork cdm:work_date_document ?date }
}
ORDER BY ?date
LIMIT 50`;

  const data = await runSparqlQuery(query);
  const amendments = (data.results?.bindings || []).map((b) => {
    const raw = b.sourceCelex?.value?.split('/').pop() || null;
    return {
      celex: raw ? decodeURIComponent(raw) : null,
      date: b.date?.value || null,
      type: b.type?.value || 'amendment',
    };
  }).filter((a) => a.celex);

  return { celex, amendments };
}

async function fetchImplementing(celex, runSparqlQuery) {
  const celexUri = `http://publications.europa.eu/resource/celex/${celex}`;
  const query = `
PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
PREFIX owl: <http://www.w3.org/2002/07/owl#>
SELECT DISTINCT ?actCelex ?date ?title WHERE {
  ?work owl:sameAs <${celexUri}> .
  ?ax owl:annotatedTarget ?work ;
      owl:annotatedProperty cdm:resource_legal_based_on_resource_legal ;
      owl:annotatedSource ?actWork .
  ?actWork owl:sameAs ?actCelex .
  FILTER(STRSTARTS(STR(?actCelex), "http://publications.europa.eu/resource/celex/"))
  OPTIONAL { ?actWork cdm:work_date_document ?date }
  OPTIONAL {
    ?actWork cdm:resource_legal_title ?titleExpr .
    FILTER(LANG(?titleExpr) = "en")
    BIND(STR(?titleExpr) AS ?title)
  }
}
ORDER BY ?date
LIMIT 100`;

  const data = await runSparqlQuery(query);
  const acts = (data.results?.bindings || []).map((b) => {
    const raw = b.actCelex?.value?.split('/').pop() || null;
    return {
      celex: raw ? decodeURIComponent(raw) : null,
      date: b.date?.value || null,
      title: b.title?.value || null,
    };
  }).filter((a) => a.celex);

  return { celex, acts };
}

function loadCookiesFromDisk(cacheDir) {
  if (!cacheDir) return;
  try {
    const filePath = path.join(cacheDir, 'eurlex-cookies.json');
    if (!fs.existsSync(filePath)) return;
    const { cookies, userAgent, fetchedAt } = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Date.now() - fetchedAt > EURLEX_COOKIE_MAX_AGE_MS) return;
    warmCookieHeader = cookies;
    warmUserAgent = userAgent;
  } catch {
    // best-effort
  }
}

function saveCookiesToDisk(cacheDir, cookies, userAgent) {
  if (!cacheDir) return;
  try {
    const filePath = path.join(cacheDir, 'eurlex-cookies.json');
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ cookies, userAgent, fetchedAt: Date.now() }), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch {
    // best-effort
  }
}

function invalidateCookies(cacheDir) {
  warmCookieHeader = null;
  warmUserAgent = null;
  if (cacheDir) {
    try { fs.unlinkSync(path.join(cacheDir, 'eurlex-cookies.json')); } catch { /* ok */ }
  }
}

async function warmEurlexCookies({ cacheDir } = {}) {
  if (cookieWarmPromise) return cookieWarmPromise;
  if (warmFailedAt && Date.now() - warmFailedAt < WARM_FAILURE_COOLDOWN_MS) return;

  cookieWarmPromise = (async () => {
    try {
      const playwrightModulePath = process.env.PLAYWRIGHT_MODULE_PATH || null;
      const playwright = await loadPlaywrightModule(playwrightModulePath);
      const page = await getSharedPlaywrightPage(playwright, {
        playwrightBrowsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH || null,
        headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
      });
      await page.goto('https://eur-lex.europa.eu/homepage.html', {
        waitUntil: 'domcontentloaded',
        timeout: 20_000,
      });
      try {
        await page.waitForLoadState('networkidle', { timeout: 15_000 });
      } catch {
        // networkidle may time out on challenge pages — proceed anyway
      }
      const cookies = await page.context().cookies();
      const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      const ua = await page.evaluate(() => navigator.userAgent);

      warmCookieHeader = cookieStr;
      warmUserAgent = ua;
      warmFailedAt = 0;
      saveCookiesToDisk(cacheDir, cookieStr, ua);
      console.log(`[case-law] EUR-Lex session cookies warmed (${cookies.length} cookies)`);
    } catch (err) {
      warmFailedAt = Date.now();
      console.warn(`[case-law] Cookie warming failed: ${err.message} (cooling down ${WARM_FAILURE_COOLDOWN_MS / 1000}s)`);
    }
  })();

  try {
    await cookieWarmPromise;
  } finally {
    cookieWarmPromise = null;
  }
}

const CASE_LAW_ENRICH_BUDGET_MS = 1_500;
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPartialEntry(entry) {
  return !entry
    || !entry.name
    || !Array.isArray(entry.declarations)
    || entry.declarations.length === 0
    || entry.citationParserVersion !== CITATION_PARSER_VERSION
    || !Array.isArray(entry.articleRefs)
    || entry.articleRefs.length === 0;
}

function isStaleEntry(entry) {
  if (!isPartialEntry(entry)) return false;
  return !entry?.lastFailedAt || (Date.now() - entry.lastFailedAt) > PARTIAL_RETRY_COOLDOWN_MS;
}

async function fetchCaseLaw(celex, runSparqlQuery, {
  cacheDir,
  detailsFetcher,
  enrichBudgetMs = CASE_LAW_ENRICH_BUDGET_MS,
  enrichConcurrency = 3,
  fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
} = {}) {
  if (cacheDir && warmCookieHeader === null && cookieWarmPromise === null) {
    loadCookiesFromDisk(cacheDir);
  }
  if (!detailsFetcher) {
    detailsFetcher = (caseCelex, opts) => fetchCaseDetails(caseCelex, { ...opts, timeoutMs: fetchTimeoutMs });
  }
  const cache = cacheDir ? loadCaseLawCache(cacheDir) : {};
  const celexUri = `http://publications.europa.eu/resource/celex/${celex}`;
  const query = `
PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
PREFIX owl: <http://www.w3.org/2002/07/owl#>
SELECT DISTINCT ?caseCelex ?ecli ?date WHERE {
  ?caseWork cdm:case-law_interpretes_resource_legal ?law .
  ?law owl:sameAs <${celexUri}> .
  ?caseWork cdm:resource_legal_id_celex ?caseCelex .
  FILTER(REGEX(?caseCelex, "^6[0-9]{4}(CJ|TJ)[0-9]"))
  OPTIONAL { ?caseWork cdm:case-law_ecli ?ecli }
  OPTIONAL { ?caseWork cdm:work_date_document ?date }
}
ORDER BY ?date
LIMIT 200`;

  const data = await runSparqlQuery(query);
  const cases = (data.results?.bindings || []).map((b) => {
    const caseCelex = b.caseCelex?.value || null;
    let caseNumber = caseCelex;
    const m = caseCelex?.match(/^6(\d{4})(CJ|TJ)(\d{4})$/);
    if (m) {
      const prefix = m[2] === 'TJ' ? 'T' : 'C';
      caseNumber = `${prefix}-${parseInt(m[3], 10)}/${m[1].slice(2)}`;
    }
    const cached = cache[caseCelex];
    return {
      celex: caseCelex,
      caseNumber,
      ecli: b.ecli?.value || null,
      date: b.date?.value || null,
      name: cached?.name || null,
      declarations: cached?.declarations || [],
      articlesCited: cached?.articlesCited || [],
      articleRefs: hydrateContextualRefs(cached?.articleRefs || [], celex),
    };
  }).filter((c) => c.celex);

  // Enrich uncached/stale cases with full details (name + decisions + articles)
  const uncached = cases.filter((c) => isStaleEntry(cache[c.celex]));
  if (uncached.length > 0) {
    let enrichPromise = enrichInFlight.get(celex);
    if (!enrichPromise) {
      enrichPromise = enrichWithCaseDetails(uncached, cache, {
        concurrency: enrichConcurrency,
        detailsFetcher,
        cacheDir,
        logLabel: celex,
      })
        .then(() => {
          if (cacheDir) saveCaseLawCache(cacheDir, cache);
        })
        .catch((err) => {
          console.warn(`[case-law] Details enrichment failed for ${celex}: ${err.message}`);
        })
        .finally(() => {
          enrichInFlight.delete(celex);
        });
      enrichInFlight.set(celex, enrichPromise);
    }

    if (enrichBudgetMs > 0) {
      await Promise.race([enrichPromise, wait(enrichBudgetMs)]);
    }
  }

  return { celex, cases };
}

// ---------------------------------------------------------------------------
// Case law cache: { caseCelex: { name, declarations, articlesCited, articleRefs } }
// ---------------------------------------------------------------------------

const CASE_LAW_CACHE_FILE = 'case-law-cache-v5.json';
const CASE_LAW_CACHE_FILES_LEGACY = ['case-law-cache-v4.json', 'case-law-cache-v3.json'];

function loadCaseLawCache(cacheDir) {
  try {
    const filePath = path.join(cacheDir, CASE_LAW_CACHE_FILE);
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    const legacyName = CASE_LAW_CACHE_FILES_LEGACY.find((name) => fs.existsSync(path.join(cacheDir, name)));
    if (legacyName) {
      const legacy = JSON.parse(fs.readFileSync(path.join(cacheDir, legacyName), 'utf8'));
      const migrated = {};
      for (const [k, v] of Object.entries(legacy)) {
        migrated[k] = v && typeof v === 'object'
          ? { ...v, articleRefs: v.articleRefs || parseCitationsToRefs(v.articlesCited) }
          : v;
      }
      try {
        fs.writeFileSync(filePath, JSON.stringify(migrated, null, 2), 'utf8');
      } catch {
        // best-effort; we'll re-migrate next load
      }
      return migrated;
    }
    return {};
  } catch {
    return {};
  }
}

function saveCaseLawCache(cacheDir, cache) {
  try {
    const filePath = path.join(cacheDir, CASE_LAW_CACHE_FILE);
    fs.writeFileSync(filePath, JSON.stringify(cache, null, 2), 'utf8');
  } catch {
    // best-effort
  }
}

function isChallengeResponse(res) {
  return res.status === 202
    && String(res.headers.get('x-amzn-waf-action') || '').toLowerCase() === 'challenge';
}

function cleanText(text) {
  return text.replace(/[\s\n\t]+/g, ' ').trim();
}

/**
 * Extract the operative part (ruling) from a CJEU judgment DOM.
 */
function extractOperativePart(document) {
  const body = document.body;
  if (!body) return { declarations: [] };

  const allParagraphs = body.querySelectorAll('p.coj-normal');
  let operativeStartIdx = -1;

  for (let i = 0; i < allParagraphs.length; i++) {
    const text = allParagraphs[i].textContent.trim();
    if (text.match(/^On\s+those\s+grounds/i) && text.match(/hereby\s+(rules|declares|orders)/i)) {
      operativeStartIdx = i;
      break;
    }
  }

  if (operativeStartIdx === -1) {
    // Try older Curia format (C41DispositifIntroduction + C08Dispositif)
    const oldFormat = extractOperativePartOldFormat(body);
    if (oldFormat.declarations.length > 0) return oldFormat;
    // Try pre-2004 OJ format (<dt>N.</dt> after "hereby rules")
    const legacy = extractOperativePartLegacyOj(document);
    if (legacy.declarations.length > 0) return legacy;
    return extractOperativePartFromText(body.textContent || '');
  }

  const declarations = [];
  let currentNumber = 0;
  let currentText = '';

  const operativeP = allParagraphs[operativeStartIdx];
  let node = operativeP.closest('table') || operativeP.closest('tr') || operativeP;
  node = node.nextElementSibling || node.parentElement?.nextElementSibling;

  while (node) {
    if (node.querySelector?.('.coj-signaturecase') || node.classList?.contains('coj-signaturecase')) break;
    if (node.tagName === 'HR' && node.classList?.contains('coj-note')) break;

    const countEl = node.querySelector?.('.coj-count.coj-bold, .coj-count .coj-bold');
    if (countEl) {
      const numMatch = countEl.textContent.match(/(\d+)\./);
      if (numMatch) {
        if (currentNumber > 0 && currentText.trim()) {
          declarations.push({ number: currentNumber, text: currentText.trim() });
        }
        currentNumber = parseInt(numMatch[1], 10);
        const textCell = countEl.closest('tr')?.querySelector('td:last-child');
        currentText = textCell ? cleanText(textCell.textContent) : '';
        node = node.nextElementSibling;
        continue;
      }
    }

    if (currentNumber > 0) {
      const normalP = node.querySelector?.('p.coj-normal');
      if (normalP) {
        const additionalText = cleanText(normalP.textContent);
        if (additionalText && !additionalText.match(/^Delivered in open court/i)) {
          currentText += ' ' + additionalText;
        }
      }
    }

    node = node.nextElementSibling;
  }

  if (currentNumber > 0 && currentText.trim()) {
    declarations.push({ number: currentNumber, text: currentText.trim() });
  }

  if (declarations.length === 0) {
    const oldFormat = extractOperativePartOldFormat(body);
    if (oldFormat.declarations.length > 0) return oldFormat;
    const legacy = extractOperativePartLegacyOj(document);
    if (legacy.declarations.length > 0) return legacy;
    return extractOperativePartFromText(body.textContent || '');
  }

  return { declarations };
}

/**
 * Extract operative part from pre-2004 OJ HTML format, e.g. 62001CJ0101.
 * Structure:
 *   <p>On those grounds, ... hereby rules:</p>
 *   <b>
 *     <dt>1.</dt><dd></dd> declaration text
 *     <dt>2.</dt><dd></dd> ...
 *   </b>
 *   <table> signatures </table>
 */
function extractOperativePartLegacyOj(document) {
  const body = document.body;
  if (!body) return { declarations: [] };
  const win = document.defaultView;
  if (!win) return { declarations: [] };

  const dts = [...body.querySelectorAll('dt')].filter((dt) => /^\d+\.?$/.test(cleanText(dt.textContent)));
  if (dts.length === 0) return { declarations: [] };

  const walker = document.createTreeWalker(body, win.NodeFilter.SHOW_TEXT);
  let markerNode = null;
  let n;
  while ((n = walker.nextNode())) {
    if (/hereby\s+(rules|declares|orders)/i.test(n.textContent)) { markerNode = n; break; }
  }
  if (!markerNode) return { declarations: [] };

  const FOLLOWING = win.Node.DOCUMENT_POSITION_FOLLOWING;
  const past = dts.filter((dt) => markerNode.compareDocumentPosition(dt) & FOLLOWING);
  if (past.length === 0) return { declarations: [] };

  function nextInDocOrder(node) {
    if (node.firstChild) return node.firstChild;
    while (node) {
      if (node.nextSibling) return node.nextSibling;
      node = node.parentNode;
    }
    return null;
  }

  const declarations = [];
  for (let i = 0; i < past.length; i++) {
    const dt = past[i];
    const num = parseInt(cleanText(dt.textContent).match(/^(\d+)/)[1], 10);
    const nextDt = past[i + 1];
    let text = '';
    let cur = dt;
    while ((cur = nextInDocOrder(cur))) {
      if (nextDt && cur === nextDt) break;
      if (cur.nodeType === 1 && cur.tagName === 'TABLE') break;
      if (cur.nodeType === 3) text += cur.textContent;
    }
    text = cleanText(text).replace(/^\d+\.\s*/, '');
    if (text) declarations.push({ number: num, text });
  }
  return { declarations };
}

/**
 * Extract operative part from older Curia HTML format (pre-2013-ish cases).
 * Structure:
 *   <P class="C41DispositifIntroduction">On those grounds, the Court ... hereby rules:</P>
 *   <P class="C08Dispositif">1.&nbsp;...</P>
 *   <P class="C08Dispositif">2.&nbsp;...</P>
 * Some very old cases use a single C08Dispositif without numbering.
 */
function extractOperativePartOldFormat(body) {
  const dispositifPs = body.querySelectorAll('p[class^="C08Dispositif"], p[class^="C09Dispositif"]');
  if (dispositifPs.length === 0) return { declarations: [] };

  const declarations = [];
  for (const p of dispositifPs) {
    const text = cleanText(p.textContent || '');
    if (!text) continue;
    const numMatch = text.match(/^(\d+)\.\s*(.+)$/s);
    if (numMatch) {
      declarations.push({ number: parseInt(numMatch[1], 10), text: cleanText(numMatch[2]) });
    } else {
      declarations.push({ number: declarations.length + 1, text });
    }
  }

  return { declarations };
}

function extractOperativePartFromText(fullText) {
  const operativePatterns = [
    // "On those grounds, THE COURT (Chamber), <in answer to the questions
    // referred…> hereby rules/declares/orders:". The court routinely inserts a
    // clause between "THE COURT" and the ruling verb (very common pre-2000), so
    // allow arbitrary text in between rather than requiring them adjacent.
    /On\s+those\s+grounds\s*,?[\s\S]{0,400}?\bhereby\s+(?:rules|declares|orders)\b\s*:?/i,
    // Pre-1970 phrasing: "For these reasons, THE COURT … declares:" — the verb
    // sometimes appears without "hereby".
    /For\s+these\s+reasons\s*,?[\s\S]{0,500}?\b(?:hereby\s+)?(?:rules|declares|orders)\b\s*:?/i,
    // Fallback: "THE COURT … hereby rules/declares/orders:" with no lead-in.
    /\bTHE\s+COURT\b[\s\S]{0,300}?\bhereby\s+(?:rules|declares|orders)\b\s*:?/i,
  ];

  let operativeStart = -1;
  for (const pattern of operativePatterns) {
    const match = fullText.match(pattern);
    if (match) {
      operativeStart = match.index + match[0].length;
      break;
    }
  }

  if (operativeStart === -1) return { declarations: [] };

  let rawOperative = fullText.substring(operativeStart).trim();

  const cutoffs = [/Delivered\s+in\s+open\s+court/i, /Language\s+of\s+the\s+case/i];
  for (const pattern of cutoffs) {
    const match = rawOperative.match(pattern);
    if (match) rawOperative = rawOperative.substring(0, match.index).trim();
  }

  const declarations = [];
  // Old uppercase judgments number points as "1 ." / "2 ." (space before the
  // dot); cap at two digits so a trailing year like "1968 ." is not mistaken
  // for a declaration number.
  const numberedPattern = /(?:^|\s)(\d{1,2})\s*\.\s+/g;
  const matches = [...rawOperative.matchAll(numberedPattern)];

  if (matches.length > 0) {
    for (let i = 0; i < matches.length; i++) {
      const start = matches[i].index + matches[i][0].length;
      const end = i + 1 < matches.length ? matches[i + 1].index : rawOperative.length;
      const text = cleanText(rawOperative.substring(start, end));
      if (text) declarations.push({ number: parseInt(matches[i][1], 10), text });
    }
  } else {
    const text = cleanText(rawOperative);
    if (text) declarations.push({ number: 1, text });
  }

  return { declarations };
}

/**
 * Extract article citations from judgment text. The parser is intentionally
 * independent of the judgment's HTML era; JSDOM supplies one visible text
 * stream for modern Formex, older Curia, and pre-2004 OJ pages.
 */
function extractArticleCitations(document) {
  return extractArticleCitationsFromText(document.body?.textContent || '');
}

/**
 * Extract the party name from EUR-Lex's DC.description / DC.title metadata — the
 * OJ notice line "Judgment of the Court (Chamber) of DATE. - PARTY v PARTY. -
 * SUBJECT. - Case C-…". This is populated consistently across every judgment era
 * (unlike the body's name markup, which changed shape several times), so it is a
 * far more reliable name source than scraping bold tags. Attribute values are
 * already HTML-entity-decoded by the DOM parser (e.g. "G&ouml;bbels" -> "Göbbels").
 */
function nameFromDescription(document) {
  const meta = (n) => document.querySelector(`meta[name="${n}"]`)?.getAttribute('content') || '';
  const desc = meta('DC.description') || meta('DC.title') || '';
  if (!/^(Judgment|Order|Opinion|Ruling|View)\b/i.test(desc)) return null;
  // Segments are delimited by ". - "; the party name is the segment after the
  // "Judgment of the Court … of DATE" preamble.
  const segments = desc.split(/\.\s*[-–]\s*/).map((s) => s.trim()).filter(Boolean);
  if (segments.length < 2) return null;
  const candidate = segments[1];
  if (!candidate || /^Case\s/i.test(candidate) || /^Reference\b/i.test(candidate)) return null;
  return candidate.replace(/\s+/g, ' ').trim();
}

/**
 * Parse a judgment's raw HTML into structured details (name + operative
 * declarations + article citations). Split out from fetchCaseDetails so the same
 * parse can run OFFLINE against the locally-harvested case-law corpus — the
 * network fetch and the (JSDOM-based, format-fragile) parse are independent, and
 * decoupling them lets parser fixes reprocess the corpus with no re-scraping.
 * Returns null for empty/too-short HTML.
 */
function parseCaseDetailsFromHtml(html) {
  if (!html || html.length < 200) return null;

  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const operative = extractOperativePart(doc);
  const citations = extractArticleCitations(doc);

  // Also extract party name from the full HTML (more reliable than Range request).
  // Modern format: <span class="coj-bold">Name</span>
  // Older Curia format: <P class="C02AlineaAltA"><B>Name</B></P>
  const cleanBold = (raw) => raw
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/[,;]+$/, '').trim();

  const modernPattern = /<span class="(?:coj-)?bold">([^<]+)<\/span>/g;
  let boldMatches = [...html.matchAll(modernPattern)];
  if (boldMatches.length === 0) {
    const oldPattern = /<p\s+class="C02AlineaAlt[^"]*"[^>]*>([\s\S]*?)<\/p>/gi;
    for (const pMatch of html.matchAll(oldPattern)) {
      const bMatches = [...pMatch[1].matchAll(/<b>([\s\S]*?)<\/b>/gi)];
      for (const b of bMatches) boldMatches.push(b);
      if (boldMatches.length >= 2) break;
    }
  }
  if (boldMatches.length === 0) {
    // Pre-2004 OJ format: <font class="oj-font*"><b>Name</b></font>
    // First hit is usually "Case C-XX/YY"; prefer the first non-case-number hit.
    const legacyPattern = /<font[^>]+class="[^"]*oj-font[^"]*"[^>]*>\s*<b>([\s\S]*?)<\/b>\s*<\/font>/gi;
    for (const m of html.matchAll(legacyPattern)) {
      const spaced = m[1].replace(/<br\s*\/?>/gi, ' ');
      const plain = cleanBold(spaced);
      if (plain && !/^Case\s+[CT]-\d/i.test(plain)) {
        boldMatches.push([m[0], spaced]);
        break;
      }
    }
  }

  // Prefer the canonical OJ-notice name from metadata (works across all eras);
  // fall back to scraping bold party markup from the body when it is absent.
  let name = nameFromDescription(doc);
  if (!name && boldMatches.length > 0) {
    const first = cleanBold(boldMatches[0][1]);
    if (first && boldMatches.length >= 2) {
      const second = cleanBold(boldMatches[1][1]);
      name = second ? `${first} v ${second}` : first;
    } else {
      name = first || null;
    }
  }

  return {
    name,
    declarations: operative.declarations,
    articlesCited: citations.articlesCited,
    articleRefs: citations.articleRefs,
    citationParserVersion: CITATION_PARSER_VERSION,
  };
}

/**
 * Fetch full HTML for a case and extract decision + article citations.
 * Uses warm EUR-Lex session cookies to bypass WAF challenge.
 */
async function fetchCaseDetails(caseCelex, { cacheDir, stats, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS } = {}) {
  const url = `https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:${caseCelex}`;

  if (warmCookieHeader === null && cookieWarmPromise === null) {
    loadCookiesFromDisk(cacheDir);
  }
  if (warmCookieHeader === null) {
    await warmEurlexCookies({ cacheDir });
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers = {
        'accept-language': 'en',
      };
      if (warmCookieHeader) {
        headers['cookie'] = warmCookieHeader;
        headers['user-agent'] = warmUserAgent || 'Mozilla/5.0';
      }

      const res = await fetch(url, { signal: controller.signal, headers });

      if (isChallengeResponse(res)) {
        clearTimeout(timeout);
        if (stats) stats.challenges++;
        invalidateCookies(cacheDir);
        if (attempt === 0) {
          await warmEurlexCookies({ cacheDir });
        } else {
          await new Promise((r) => setTimeout(r, 2000 * (2 ** attempt)));
        }
        continue;
      }

      if (!res.ok) return null;

      const html = await res.text();
      return parseCaseDetailsFromHtml(html);
    } finally {
      clearTimeout(timeout);
    }
  }

  return null;
}

/**
 * Enrich cases with full details (decisions + articles). Lower concurrency
 * than party-name enrichment since we fetch full pages.
 */
async function enrichWithCaseDetails(cases, detailsCache, {
  concurrency = 3,
  detailsFetcher = fetchCaseDetails,
  cacheDir,
  logLabel = '',
} = {}) {
  const stats = { enriched: 0, partial: 0, errors: 0, challenges: 0 };
  let consecutiveFails = 0;
  let blocked = false;
  let i = 0;

  async function next() {
    while (i < cases.length && !blocked) {
      const c = cases[i++];
      try {
        const details = await detailsFetcher(c.celex, { cacheDir, stats });
        const articleRefs = details?.articleRefs || parseCitationsToRefs(details?.articlesCited);
        const normalizedDetails = details ? { ...details, articleRefs } : null;
        if (normalizedDetails && !isPartialEntry(normalizedDetails)) {
          detailsCache[c.celex] = normalizedDetails;
          c.declarations = normalizedDetails.declarations;
          c.articlesCited = normalizedDetails.articlesCited;
          c.articleRefs = hydrateContextualRefs(articleRefs, logLabel);
          if (normalizedDetails.name && !c.name) c.name = normalizedDetails.name;
          stats.enriched++;
        } else {
          const existing = detailsCache[c.celex] || {};
          // Preserve whatever did parse (name/operative part) but keep the entry
          // retryable: a zero-ref result for a judgment known to interpret this
          // law is often a citation-grammar miss, not proof that no refs exist.
          detailsCache[c.celex] = { ...existing, ...(normalizedDetails || {}), lastFailedAt: Date.now() };
          if (normalizedDetails) {
            c.declarations = normalizedDetails.declarations || c.declarations;
            c.articlesCited = normalizedDetails.articlesCited || c.articlesCited;
            c.articleRefs = hydrateContextualRefs(articleRefs, logLabel);
            if (normalizedDetails.name && !c.name) c.name = normalizedDetails.name;
          }
          stats.partial++;
        }
        consecutiveFails = 0;
      } catch (err) {
        stats.errors++;
        consecutiveFails++;
        if (consecutiveFails >= 5) {
          blocked = true;
          console.warn(`[case-law] Stopping details enrichment after ${consecutiveFails} consecutive failures: ${err.message}`);
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, next));

  const suffix = logLabel ? ` for ${logLabel}` : '';
  console.log(
    `[case-law] Enrichment${suffix} done: ${stats.enriched} enriched, ` +
    `${stats.partial} partial, ${stats.errors} errors, ${stats.challenges} WAF challenges (of ${cases.length} cases)`
  );
}

module.exports = {
  ACT_CELEX_MAP,
  fetchMetadata,
  fetchAmendments,
  fetchImplementing,
  fetchCaseLaw,
  parseCitationsToRefs,
  parseCaseDetailsFromHtml,
  loadCaseLawCache,
  saveCaseLawCache,
  isPartialEntry,
  CITATION_PARSER_VERSION,
  CASE_LAW_CACHE_FILE,
};
