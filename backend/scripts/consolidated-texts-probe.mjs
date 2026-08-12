#!/usr/bin/env node

/**
 * Spike harness for issue #135 item 1: consolidated ("as amended") texts.
 *
 * For each sampled act it answers, with evidence rather than argument:
 *
 *   1. Does EUR-Lex publish consolidated versions, how many, and how stale is
 *      the newest one relative to the newest amendment?
 *   2. Is the consolidated text available as Formex at all, and at which
 *      manifestation URI shape?
 *   3. Does the shipped parser accept it, and what does it yield?
 *   4. How far does the consolidated text drift from the as-adopted text the
 *      app renders today — same articles, or a different act?
 *
 * Nothing here is production code: it reuses the shipped parser and the shipped
 * consolidated-version query so the answers describe the real pipeline, but it
 * writes no caches and touches no app state.
 *
 * Usage (from `backend/`):
 *   node scripts/consolidated-texts-probe.mjs              # default sample, table output
 *   node scripts/consolidated-texts-probe.mjs --json       # machine-readable, for diffing runs
 *   node scripts/consolidated-texts-probe.mjs 32013R0575 32006L0112
 *   node scripts/consolidated-texts-probe.mjs --articles 32013R0575
 */

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { fetchConsolidatedVersions, fetchAmendments } = require('../shared/law-queries.js');
const { parseFmxXml, isFmxDocument } = require('../shared/fmx-parser-node.js');

const CELLAR_BASE = 'http://publications.europa.eu/resource';
const SPARQL_ENDPOINT = 'https://publications.europa.eu/webapi/rdf/sparql';
const API_BASE = process.env.LEGALVIZ_API_BASE || 'https://api.legalviz.eu';
const TIMEOUT_MS = 120_000;

// Sampled to span the axes that matter: never amended (the control), amended
// once, amended into a different act, pre-Formex, and the two the discussion in
// #135 named by hand (GDPR as the "barely changed" case, CRR as the worst case).
const SAMPLE = [
  { celex: '32016R0679', label: 'GDPR' },
  { celex: '32022R2065', label: 'Digital Services Act' },
  { celex: '32022R1925', label: 'Digital Markets Act' },
  { celex: '32024R1689', label: 'AI Act' },
  { celex: '32011L0083', label: 'Consumer Rights Directive' },
  { celex: '32015L2366', label: 'PSD2' },
  { celex: '32015L0849', label: 'AML Directive 4' },
  { celex: '32013R0575', label: 'CRR' },
  { celex: '32013L0036', label: 'CRD IV' },
  { celex: '32006L0112', label: 'VAT Directive' },
  { celex: '32014L0065', label: 'MiFID II' },
  { celex: '32009L0138', label: 'Solvency II' },
  { celex: '32008L0098', label: 'Waste Framework Directive' },
  { celex: '32003L0087', label: 'Emissions Trading Directive' },
  { celex: '32006R1907', label: 'REACH' },
];

const HAS_UNZIP = (() => {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/**
 * Cellar throws transient 503s and 5xx under load; a run without retries
 * reports flakiness as missing data, which is the one thing this probe must not
 * do. 406 is not retried — Cellar returns it for resources it has indexed but
 * cannot serve, which is a real finding rather than a hiccup.
 */
async function getText(url, headers = {}, attempt = 1) {
  const response = await fetch(url, {
    headers: { Accept: '*/*', 'Accept-Language': 'eng', ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.ok) return response.text();
  if (response.status >= 500 && attempt <= 3) {
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    return getText(url, headers, attempt + 1);
  }
  throw new Error(`HTTP ${response.status} for ${url}`);
}

async function runSparqlQuery(query) {
  const url = new URL(SPARQL_ENDPOINT);
  url.searchParams.set('query', query);
  url.searchParams.set('format', 'application/sparql-results+json');
  return JSON.parse(await getText(url.toString(), { Accept: 'application/sparql-results+json' }));
}

function extractUris(rdf) {
  return [...rdf.matchAll(/rdf:resource="([^"]+)"/g)].map((match) => match[1]);
}

/**
 * Resolve a CELEX to its Formex XML, recording which URI shape answered.
 *
 * The serving path (`backend/shared/fmx-service.js`) only matches the `/oj/…`
 * shapes; this deliberately accepts any `.<LANG>.fmx4`, the way the search
 * builder already does, so the probe can report *which* acts the serving path
 * would have missed rather than failing alongside it.
 */
async function fetchFmxXml(celex, lang = 'ENG') {
  const rdf = await getText(`${CELLAR_BASE}/celex/${celex}`);
  const uris = extractUris(rdf);
  const fmx4 = uris.find((uri) => uri.endsWith(`.${lang}.fmx4`));
  if (!fmx4) return { uriShape: null, xml: null };

  // Which path segment Cellar answered with. `findFmx4Uri` in the serving path
  // only matches `/oj/…`, so anything else here is an act it cannot reach.
  // Note the `/consolidation/…` shape only appears when the request carries
  // `Accept-Language`; without it Cellar returns a manifestation-less document.
  const uriShape = (/\/resource\/([^/]+)\//.exec(fmx4) || [])[1] || 'unknown';
  const manifestation = extractUris(await getText(fmx4));

  const zip = manifestation.find((uri) => uri.endsWith('.zip'));
  if (zip) {
    if (!HAS_UNZIP) return { uriShape, xml: null, note: 'zip manifestation, no unzip binary' };
    const dir = mkdtempSync(path.join(tmpdir(), 'fmx-spike-'));
    const archive = path.join(dir, 'fmx.zip');
    const response = await fetch(zip, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
    execFileSync('unzip', ['-o', '-q', archive, '-d', dir]);
    // The act itself is the largest member; the rest are annexes and the
    // publication wrapper.
    const members = readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith('.xml') && !name.toLowerCase().endsWith('.doc.xml'))
      .map((name) => path.join(dir, name));
    if (!members.length) return { uriShape, xml: null, note: 'zip contained no act XML' };
    const biggest = members.sort((a, b) => readFileSync(b).length - readFileSync(a).length)[0];
    return { uriShape, xml: readFileSync(biggest, 'utf8') };
  }

  const xmlUri = manifestation.find((uri) => /\.fmx4\.[^/]+\.xml$/.test(uri) && !uri.endsWith('.doc.xml'));
  if (!xmlUri) return { uriShape, xml: null, note: 'no XML manifestation' };
  return { uriShape, xml: await getText(xmlUri) };
}

function summarizeParse(parsed) {
  const articleNumbers = (parsed.articles || []).map((article) => String(article.article_number));
  return {
    title: parsed.title || '',
    articles: articleNumbers.length,
    articleNumbers: new Set(articleNumbers),
    recitals: (parsed.recitals || []).length,
    annexes: (parsed.annexes || []).length,
    definitions: (parsed.definitions || []).length,
    crossRefSources: Object.keys(parsed.crossReferences || {}).length,
  };
}

/** The as-adopted side of the comparison: what the app renders for this act today. */
async function fetchShippedParse(celex) {
  const response = await fetch(`${API_BASE}/api/laws/${celex}/parsed?lang=ENG`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from /parsed`);
  return summarizeParse(await response.json());
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

async function probe({ celex, label }) {
  const row = { celex, label };

  const [{ versions }, { amendments }] = await Promise.all([
    fetchConsolidatedVersions(celex, runSparqlQuery),
    fetchAmendments(celex, runSparqlQuery),
  ]);

  const applied = versions.filter((version) => version.date <= todayIso());
  const amendmentDates = amendments
    .filter((entry) => entry.type === 'amendment' && entry.date)
    .map((entry) => entry.date)
    .sort();

  row.amendments = amendmentDates.length;
  row.latestAmendment = amendmentDates.at(-1) || null;
  row.versions = versions.length;
  row.futureVersions = versions.length - applied.length;
  row.latestVersion = applied.at(-1)?.date || null;
  // Days the consolidated text trails the newest amending act. Approximate by
  // construction — an amending act dated later may not apply yet — which is
  // exactly why the reader UI states dates instead of claiming staleness.
  row.lagDays = row.latestVersion && row.latestAmendment
    ? Math.round((Date.parse(row.latestAmendment) - Date.parse(row.latestVersion)) / 86_400_000)
    : null;

  if (!applied.length) {
    row.status = 'no consolidated version';
    return row;
  }

  const consolidatedCelex = applied.at(-1).celex;
  const { uriShape, xml, note } = await fetchFmxXml(consolidatedCelex);
  row.uriShape = uriShape;
  if (!xml) {
    row.status = note || 'no FMX manifestation';
    return row;
  }

  // The frontend's raw-XML gate (src/utils/parsers.js, formexApi.js). The
  // backend's /parsed route does not consult it — it parses whatever the FMX
  // service handed back — so this failing blocks the browser path only.
  row.passesIsFmxDocument = await isFmxDocument(xml);
  row.rootElement = (/<([A-Z][A-Z.0-9]*)[\s>]/.exec(xml) || [])[1] || null;

  let consolidated;
  try {
    consolidated = summarizeParse(await parseFmxXml(xml));
  } catch (error) {
    row.status = `parse threw: ${error.message.slice(0, 80)}`;
    return row;
  }

  row.consolidated = {
    articles: consolidated.articles,
    recitals: consolidated.recitals,
    annexes: consolidated.annexes,
    definitions: consolidated.definitions,
    title: consolidated.title.slice(0, 90),
  };

  try {
    const adopted = await fetchShippedParse(celex);
    row.adopted = {
      articles: adopted.articles,
      recitals: adopted.recitals,
      annexes: adopted.annexes,
      definitions: adopted.definitions,
    };
    row.articlesAdded = [...consolidated.articleNumbers].filter((n) => !adopted.articleNumbers.has(n)).length;
    row.articlesRemoved = [...adopted.articleNumbers].filter((n) => !consolidated.articleNumbers.has(n)).length;
    // A consolidated file that opens with a corrigendum's <TITLE> block reports
    // the corrigendum as the act's title.
    row.titleLooksWrong = /^corrigendum/i.test(consolidated.title);
  } catch (error) {
    row.adoptedError = error.message.slice(0, 60);
  }

  row.status = 'parsed';
  return row;
}

function renderTable(rows) {
  const pad = (value, width) => String(value ?? '—').padEnd(width);
  const padStart = (value, width) => String(value ?? '—').padStart(width);

  console.log('');
  console.log('CONSOLIDATED VERSION AVAILABILITY');
  console.log('─'.repeat(104));
  console.log(`${pad('act', 28)}${padStart('amds', 5)}${padStart('vers', 6)}${padStart('ahead', 6)}  ${pad('newest applied', 15)}${padStart('lag(d)', 7)}  ${pad('uri', 14)}`);
  console.log('─'.repeat(104));
  for (const row of rows) {
    console.log(
      pad(row.label, 28)
      + padStart(row.amendments, 5)
      + padStart(row.versions, 6)
      + padStart(row.futureVersions, 6)
      + '  ' + pad(row.latestVersion, 15)
      + padStart(row.lagDays, 7)
      + '  ' + pad(row.uriShape, 14)
    );
  }

  console.log('');
  console.log('PARSER BEHAVIOUR ON THE CONSOLIDATED TEXT   (consolidated vs as-adopted)');
  console.log('─'.repeat(104));
  console.log(`${pad('act', 28)}${pad('root', 10)}${pad('gate', 6)}${pad('articles', 16)}${pad('recitals', 16)}${pad('defs', 14)}${padStart('±art', 8)}`);
  console.log('─'.repeat(104));
  for (const row of rows) {
    if (row.status !== 'parsed') {
      console.log(pad(row.label, 28) + row.status);
      continue;
    }
    const pair = (key) => `${row.consolidated[key]} vs ${row.adopted ? row.adopted[key] : '?'}`;
    const delta = row.articlesAdded == null ? '—' : `+${row.articlesAdded}/-${row.articlesRemoved}`;
    console.log(
      pad(row.label, 28)
      + pad(row.rootElement, 10)
      + pad(row.passesIsFmxDocument ? 'pass' : 'FAIL', 6)
      + pad(pair('articles'), 16)
      + pad(pair('recitals'), 16)
      + pad(pair('definitions'), 14)
      + padStart(delta, 8)
      + (row.titleLooksWrong ? '   title=corrigendum' : '')
    );
  }
  console.log('');
}

/**
 * Detail mode: name the articles consolidation adds and removes, so a large
 * "+265" can be checked for what it is — genuine inserted articles (`92a`,
 * `494b`) versus parser noise.
 */
async function reportArticleDelta(celex) {
  const { versions } = await fetchConsolidatedVersions(celex, runSparqlQuery);
  const applied = versions.filter((version) => version.date <= todayIso());
  if (!applied.length) throw new Error(`no applied consolidated version for ${celex}`);

  const { xml } = await fetchFmxXml(applied.at(-1).celex);
  if (!xml) throw new Error(`no Formex for ${applied.at(-1).celex}`);

  const consolidated = summarizeParse(await parseFmxXml(xml));
  const adopted = await fetchShippedParse(celex);
  const added = [...consolidated.articleNumbers].filter((n) => !adopted.articleNumbers.has(n));
  const removed = [...adopted.articleNumbers].filter((n) => !consolidated.articleNumbers.has(n));
  const suffixed = added.filter((n) => /[a-z]$/i.test(n));

  console.log(`\n${celex} — consolidated ${applied.at(-1).celex}`);
  console.log(`  articles: ${consolidated.articles} consolidated vs ${adopted.articles} as adopted`);
  console.log(`  added   : ${added.length} (${suffixed.length} suffixed, e.g. 92a) — ${added.slice(0, 20).join(', ')}${added.length > 20 ? ' …' : ''}`);
  console.log(`  removed : ${removed.length} — ${removed.join(', ') || '—'}\n`);
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const articlesOf = args.includes('--articles');
const requested = args.filter((arg) => !arg.startsWith('--'));
const sample = requested.length
  ? requested.map((celex) => ({ celex: celex.toUpperCase(), label: celex.toUpperCase() }))
  : SAMPLE;

if (articlesOf) {
  for (const entry of sample) await reportArticleDelta(entry.celex);
  process.exit(0);
}

const rows = [];
for (const entry of sample) {
  process.stderr.write(`· ${entry.label}\n`);
  try {
    rows.push(await probe(entry));
  } catch (error) {
    rows.push({ ...entry, status: `error: ${error.message.slice(0, 80)}` });
  }
}

if (asJson) console.log(JSON.stringify(rows, null, 2));
else renderTable(rows);
