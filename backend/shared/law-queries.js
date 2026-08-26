/**
 * Shared SPARQL-based queries for law metadata, amendments, implementing acts,
 * and legislative procedure links.
 *
 * Used by both the API routes and the CLI to avoid duplicating queries
 * and result-shaping logic.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { JSDOM } = require('jsdom');
const {
  ACT_CELEX_MAP,
  CITATION_PARSER_VERSION,
  extractArticleCitationsFromText,
  hydrateContextualRefs,
  parseCitationsToRefs,
} = require('./case-law-parser');

function writeFileAtomically(filePath, data, encoding) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, data, encoding);
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // The write may have failed before creating the temporary file.
    }
    throw error;
  }
}

// Kept in step with parseInForce() in search/in-force-enrich.js: a shape change
// upstream must surface as "unknown", never as a default.
function parseInForceLiteral(value) {
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return null;
}

async function fetchMetadata(celex, runSparqlQuery) {
  const celexUri = `http://publications.europa.eu/resource/celex/${celex}`;
  const query = `
PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
PREFIX owl: <http://www.w3.org/2002/07/owl#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT DISTINCT
  ?dateEntryIntoForce ?dateEndOfValidity ?inForce
  ?eli ?dateSignature ?dateDocument
WHERE {
  ?work owl:sameAs <${celexUri}> .
  OPTIONAL { ?work cdm:resource_legal_date_entry-into-force ?dateEntryIntoForce }
  OPTIONAL { ?work cdm:resource_legal_date_end-of-validity ?dateEndOfValidity }
  OPTIONAL { ?work cdm:resource_legal_in-force ?inForce }
  OPTIONAL { ?work cdm:resource_legal_eli ?eli }
  OPTIONAL { ?work cdm:resource_legal_date_signature ?dateSignature }
  OPTIONAL { ?work cdm:work_date_document ?dateDocument }
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
    // Cellar answers this as the literal "1"/"0", not "true"/"false", so the
    // old `=== 'true'` made every act read false and the client learned to
    // ignore the field. Same three-state contract as in-force-enrich.js:
    // true / false / null, where null is "Cellar has no status".
    inForce: parseInForceLiteral(first.inForce?.value),
    eli: first.eli?.value || null,
    dateSignature: first.dateSignature?.value || null,
    dateDocument: first.dateDocument?.value || null,
  };
}

// Some acts (e.g. heavily-amended directives/regulations) have far more than a
// handful of amendments — 233 is the highest observed count in production.
// The cap must stay comfortably above that, and rows must survive ordered by
// newest first, or a truncated result silently drops the most recent
// amendments instead of the oldest ones (see `truncated` below).
const AMENDMENTS_LIMIT = 300;

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
ORDER BY DESC(?date)
LIMIT ${AMENDMENTS_LIMIT}`;

  const data = await runSparqlQuery(query);
  const bindings = data.results?.bindings || [];
  const amendments = bindings.map((b) => {
    const raw = b.sourceCelex?.value?.split('/').pop() || null;
    return {
      celex: raw ? decodeURIComponent(raw) : null,
      date: b.date?.value || null,
      type: b.type?.value || 'amendment',
    };
  }).filter((a) => a.celex);

  // Hitting the cap means older rows were left out (newest survive, per the
  // DESC order above), so the count callers derive from `amendments` is only
  // a lower bound — they must say "at least N", never a precise number.
  return { celex, amendments, truncated: bindings.length >= AMENDMENTS_LIMIT };
}

// Consolidated ("as amended") versions live in CELEX sector 0 under a
// point-in-time id: 32013R0575 -> 02013R0575-20260626. A suffixed original
// keeps its suffix: 31999F0130(06) -> 01999F0130(06)-20021220. Acts from any
// sector can have one — sector-2 international agreements (e.g. the EEA
// Agreement, 21994A0103(01) -> 01994A0103(01)-20160519) do too, not just
// sector-3 legislation — so this only rejects CELEX ids that aren't shaped
// like an original act to begin with (already a point-in-time id, malformed,
// etc.), short-circuiting those without a SPARQL round trip. The pattern
// mirrors validateCelex's domain (reference-utils.js) so nothing admitted by
// the route falls through here unchecked.
const ORIGINAL_ACT_CELEX = /^\d{5}[A-Z]{1,2}\d{4}(\(\d+\))?$/;
const CONSOLIDATED_CELEX = /^(0\d{4}[A-Z]{1,2}\d{4}(?:\(\d+\))?)-(\d{4})(\d{2})(\d{2})$/;

function consolidatedBaseCelex(celex) {
  const normalized = String(celex || '').toUpperCase();
  // `normalized` only reaches the interpolated SPARQL FILTER in
  // fetchConsolidatedVersions once it has passed this strict regex, whose
  // character class is limited to digits, A-Z, and literal parentheses — so
  // no quote, backslash, or brace can ever be smuggled into the query string.
  return ORIGINAL_ACT_CELEX.test(normalized) ? `0${normalized.slice(1)}` : null;
}

/**
 * List the consolidated versions EUR-Lex publishes for an act, oldest first.
 *
 * Cellar has no "consolidated version of" predicate that resolves from the base
 * act, so this matches on the point-in-time CELEX id instead. Consolidations can
 * be dated in the future (a version prepared for an amendment that has not yet
 * applied); the whole list is returned unfiltered and callers decide which one
 * is current, so the payload stays cacheable without a "today" baked into it.
 */
async function fetchConsolidatedVersions(celex, runSparqlQuery) {
  const base = consolidatedBaseCelex(celex);
  if (!base) return { celex, base: null, versions: [] };

  const query = `
PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
SELECT DISTINCT ?id WHERE {
  ?work cdm:resource_legal_id_celex ?id .
  FILTER(STRSTARTS(STR(?id), "${base}-"))
}
ORDER BY ?id
LIMIT 200`;

  const data = await runSparqlQuery(query);
  const versions = (data.results?.bindings || [])
    .map((binding) => {
      const id = String(binding.id?.value || '').toUpperCase();
      const match = CONSOLIDATED_CELEX.exec(id);
      if (!match || match[1] !== base) return null;
      return { celex: id, date: `${match[2]}-${match[3]}-${match[4]}` };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));

  return { celex, base, versions };
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

function bindingValue(binding, names) {
  for (const name of names) {
    const value = binding?.[name]?.value;
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return null;
}

function extractCodProcedure(values) {
  for (const value of values) {
    if (!value) continue;
    const text = String(value);
    const match = text.match(/\bCOD\s*[/: -]?\s*(\d{4})\s*\/\s*(\d{1,4})\b/i)
      || text.match(/\b(\d{4})\s*\/\s*(\d{1,4})\s*(?:\/\s*COD\b|\(\s*COD\s*\))/i);
    if (!match) continue;
    const year = match[1];
    const number = String(match[2]).padStart(4, '0');
    return {
      reference: `${year}/${number}(COD)`,
      procedureUrl: `https://eur-lex.europa.eu/procedure/EN/${year}_${Number(number)}`,
    };
  }
  return { reference: null, procedureUrl: null };
}

/**
 * Resolve an adopted act to the official EUR-Lex procedure overview.
 * Modern Cellar records keep the structured reference on the proposal's
 * dossier; the miscellaneous proposal field is retained as a legacy fallback.
 */
async function fetchLegislativeProcedure(celex, runSparqlQuery) {
  const celexUri = `http://publications.europa.eu/resource/celex/${celex}`;
  const query = `
PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
PREFIX owl: <http://www.w3.org/2002/07/owl#>
SELECT DISTINCT ?procedureReference
WHERE {
  ?finalWork owl:sameAs <${celexUri}> .
  ?finalWork cdm:resource_legal_adopts_resource_legal ?proposalWork .
  {
    { ?proposalWork cdm:work_part_of_dossier ?dossier }
    UNION
    { ?dossier cdm:dossier_contains_work ?proposalWork }
    ?dossier cdm:procedure_code_interinstitutional_reference_procedure ?procedureReference .
  }
  UNION {
    ?proposalWork cdm:resource_legal_information_miscellaneous ?procedureReference
  }
}
LIMIT 20`;

  const data = await runSparqlQuery(query);
  const bindings = data.results?.bindings || [];
  const procedure = extractCodProcedure(bindings.map((binding) => bindingValue(binding, [
    'procedureReference',
    'procedureRef',
    'procedure',
    'reference',
  ])));

  return { celex, ...procedure };
}

async function fetchCaseLaw(celex, runSparqlQuery, {
  cacheDir,
  dataStore,
} = {}) {
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
  const bindings = data.results?.bindings || [];
  const caseCelexes = bindings.map((binding) => binding.caseCelex?.value).filter(Boolean);
  const sqliteDetails = typeof dataStore?.getCaseLawDetails === 'function'
    ? dataStore.getCaseLawDetails(caseCelexes)
    : null;
  const cache = sqliteDetails === null
    ? (cacheDir ? loadCaseLawCache(cacheDir, { readOnly: true }) : {})
    : Object.fromEntries(sqliteDetails);
  const cases = bindings.map((b) => {
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

  return { celex, cases };
}

// ---------------------------------------------------------------------------
// Case law cache: { caseCelex: { name, declarations, articlesCited, articleRefs } }
// ---------------------------------------------------------------------------

const CASE_LAW_CACHE_FILE = 'case-law-cache-v5.json';
const CASE_LAW_CACHE_FILES_LEGACY = ['case-law-cache-v4.json', 'case-law-cache-v3.json'];

// The bulk-parsed corpus cache is ~50 MB, so parsing it on every request is no
// longer acceptable. Memoize by (path, mtime, size): a save from enrichment
// changes the mtime and invalidates the memo, so live pickup still works.
let caseLawCacheMemo = null;

// A gzipped copy of the bulk-parsed cache is fetched into search/data/ at Docker
// build time (a GitHub Release asset; see backend/Dockerfile) so fresh deploys
// start with the full precomputed corpus instead of re-enriching from EUR-Lex.
const CASE_LAW_CACHE_SEED = path.join(__dirname, '..', 'search', 'data', `${CASE_LAW_CACHE_FILE}.gz`);

function readCaseLawCacheFile(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (caseLawCacheMemo
    && caseLawCacheMemo.path === filePath
    && caseLawCacheMemo.mtimeMs === stat.mtimeMs
    && caseLawCacheMemo.size === stat.size) {
    return caseLawCacheMemo.cache;
  }
  const cache = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  caseLawCacheMemo = { path: filePath, mtimeMs: stat.mtimeMs, size: stat.size, cache };
  return cache;
}

// Same memo contract as readCaseLawCacheFile, for the gzipped seed asset:
// keyed on mtime + size so a rebuilt seed is picked up without a restart.
let caseLawSeedMemo = null;

function readCaseLawSeed() {
  let stat;
  try {
    stat = fs.statSync(CASE_LAW_CACHE_SEED);
  } catch {
    return null;
  }
  if (caseLawSeedMemo
    && caseLawSeedMemo.mtimeMs === stat.mtimeMs
    && caseLawSeedMemo.size === stat.size) {
    return caseLawSeedMemo.cache;
  }
  const cache = JSON.parse(zlib.gunzipSync(fs.readFileSync(CASE_LAW_CACHE_SEED)).toString('utf8'));
  caseLawSeedMemo = { mtimeMs: stat.mtimeMs, size: stat.size, cache };
  return cache;
}

function loadCaseLawCache(cacheDir, { readOnly = false } = {}) {
  try {
    const filePath = path.join(cacheDir, CASE_LAW_CACHE_FILE);
    const memoized = readCaseLawCacheFile(filePath);
    if (memoized) return memoized;
    // A caller-provided legacy cache is more specific than the bundled seed
    // (and lets existing deployments migrate their own entries). Check it
    // before populating an otherwise empty cache directory from the corpus.
    const legacyName = CASE_LAW_CACHE_FILES_LEGACY.find((name) => fs.existsSync(path.join(cacheDir, name)));
    if (legacyName) {
      const legacy = JSON.parse(fs.readFileSync(path.join(cacheDir, legacyName), 'utf8'));
      const migrated = {};
      for (const [k, v] of Object.entries(legacy)) {
        migrated[k] = v && typeof v === 'object'
          ? { ...v, articleRefs: v.articleRefs || parseCitationsToRefs(v.articlesCited) }
          : v;
      }
      if (!readOnly) {
        try {
          fs.mkdirSync(cacheDir, { recursive: true });
          writeFileAtomically(filePath, JSON.stringify(migrated, null, 2), 'utf8');
        } catch {
          // best-effort; we'll re-migrate next load
        }
      }
      return migrated;
    }
    if (fs.existsSync(CASE_LAW_CACHE_SEED)) {
      try {
        // Read-only callers (the no-SQLite fallback) never write the seed out
        // to `filePath`, so they'd gunzip and re-parse ~50 MB on every request
        // without a memo of their own — readCaseLawCacheFile only memoises the
        // on-disk cache.
        if (readOnly) {
          const memoizedSeed = readCaseLawSeed();
          if (memoizedSeed) return memoizedSeed;
        }
        const seedBytes = zlib.gunzipSync(fs.readFileSync(CASE_LAW_CACHE_SEED));
        fs.mkdirSync(cacheDir, { recursive: true });
        writeFileAtomically(filePath, seedBytes);
        const seeded = readCaseLawCacheFile(filePath);
        if (seeded) return seeded;
      } catch {
        // fall through to legacy migration / empty cache
      }
    }
    return {};
  } catch {
    return {};
  }
}

function saveCaseLawCache(cacheDir, cache) {
  try {
    const filePath = path.join(cacheDir, CASE_LAW_CACHE_FILE);
    fs.mkdirSync(cacheDir, { recursive: true });
    writeFileAtomically(filePath, JSON.stringify(cache, null, 2), 'utf8');
    // Refresh the memo in place so the next request doesn't re-parse ~50 MB.
    const stat = fs.statSync(filePath);
    caseLawCacheMemo = { path: filePath, mtimeMs: stat.mtimeMs, size: stat.size, cache };
  } catch {
    // best-effort
  }
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
 * declarations + article citations). Kept separate so the parse runs OFFLINE
 * against the locally-harvested case-law corpus — the
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

module.exports = {
  ACT_CELEX_MAP,
  fetchMetadata,
  fetchAmendments,
  fetchConsolidatedVersions,
  fetchImplementing,
  fetchLegislativeProcedure,
  fetchCaseLaw,
  parseCitationsToRefs,
  parseCaseDetailsFromHtml,
  loadCaseLawCache,
  saveCaseLawCache,
  CITATION_PARSER_VERSION,
  CASE_LAW_CACHE_FILE,
};
