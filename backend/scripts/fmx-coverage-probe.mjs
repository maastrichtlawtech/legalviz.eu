#!/usr/bin/env node

/**
 * Which acts does the reader actually serve from Formex, and which fall through
 * to the EUR-Lex HTML parser?
 *
 * The fallback is silent by design: `findFmx4Uri` throws a 404 when it cannot
 * locate a Formex manifestation, and `resolveParsedLaw` reads that as "this act
 * has no Formex" and parses EUR-Lex HTML instead. So an act whose manifestation
 * URI the matcher fails to recognise renders indistinguishably from one that
 * genuinely has no Formex — no error, no log, just worse output. This probe is
 * the difference: it asks Cellar what exists and the API what was used, and
 * reports where the two disagree.
 *
 * Run it after touching `findFmx4Uri`. A row moving from `fmx` to `eurlex-html`
 * is a regression even though nothing failed.
 *
 * Usage (from `backend/`):
 *   node scripts/fmx-coverage-probe.mjs                  # default sample
 *   node scripts/fmx-coverage-probe.mjs --json
 *   node scripts/fmx-coverage-probe.mjs 32013R0575 32006L0112
 *
 * `LEGALVIZ_API_BASE` selects which deployment answers (default production);
 * point it at http://localhost:3000 to check a local build.
 */

const CELLAR_BASE = 'http://publications.europa.eu/resource';
const API_BASE = process.env.LEGALVIZ_API_BASE || 'https://api.legalviz.eu';
const TIMEOUT_MS = 120_000;
const FMX4_ANY_LANG = /\.[A-Z]{3}\.fmx4$/;

// Spans the manifestation id formats Cellar mints, which is what the matcher
// has to cope with — post-2016 OJ, pre-2016 OJ with and without a part suffix,
// planned-OJ ids, and acts with no Formex at all.
const SAMPLE = [
  { celex: '32016R0679', label: 'GDPR' },
  { celex: '32022R2065', label: 'Digital Services Act' },
  { celex: '32022R1925', label: 'Digital Markets Act' },
  { celex: '32024R1689', label: 'AI Act' },
  { celex: '32015L0849', label: 'AML Directive 4' },
  { celex: '32011L0083', label: 'Consumer Rights Directive' },
  { celex: '32015L2366', label: 'PSD2' },
  { celex: '32014L0065', label: 'MiFID II' },
  { celex: '32013R0575', label: 'CRR' },
  { celex: '32013L0036', label: 'CRD IV' },
  { celex: '32006L0112', label: 'VAT Directive' },
  { celex: '32009L0138', label: 'Solvency II' },
  { celex: '32008L0098', label: 'Waste Framework Directive' },
  { celex: '32003L0087', label: 'Emissions Trading Directive' },
  { celex: '32006R1907', label: 'REACH' },
  { celex: '31995L0046', label: 'Data Protection Directive' },
];

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
  throw new Error(`HTTP ${response.status}`);
}

async function probe({ celex, label }) {
  const row = { celex, label };

  try {
    const rdf = await getText(`${CELLAR_BASE}/celex/${celex}`);
    const uris = [...rdf.matchAll(/rdf:resource="([^"]+)"/g)].map((match) => match[1]);
    const fmx4 = uris.find((uri) => FMX4_ANY_LANG.test(uri));
    row.manifestation = fmx4 ? fmx4.replace(`${CELLAR_BASE}/`, '') : null;
  } catch (error) {
    row.manifestation = null;
    row.cellarError = error.message;
  }

  try {
    const response = await fetch(`${API_BASE}/api/laws/${celex}/parsed?lang=ENG`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = await response.json();
    row.source = parsed.source || 'fmx';
    row.articles = (parsed.articles || []).length;
    row.recitals = (parsed.recitals || []).length;
    row.annexes = (parsed.annexes || []).length;
    row.definitions = (parsed.definitions || []).length;
  } catch (error) {
    row.source = `error: ${error.message}`;
  }

  // The finding this probe exists for: Cellar has Formex, the reader didn't use it.
  row.missed = Boolean(row.manifestation) && row.source === 'eurlex-html';

  // #142/#148: REACH-shaped failure — the act parses to nothing renderable at
  // all (zero articles, zero recitals, zero annexes), regardless of which
  // parser served it. Distinct from `missed`: a `fmx-consolidated` source
  // means the empty-parse fallback already recovered content, so it does not
  // count as empty here even though the as-adopted act itself parsed empty.
  row.emptyParse = row.articles === 0 && row.recitals === 0 && row.annexes === 0;
  return row;
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const requested = args.filter((arg) => !arg.startsWith('--'));
const sample = requested.length
  ? requested.map((celex) => ({ celex: celex.toUpperCase(), label: celex.toUpperCase() }))
  : SAMPLE;

const rows = [];
for (const entry of sample) {
  process.stderr.write(`· ${entry.label}\n`);
  rows.push(await probe(entry));
}

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const pad = (value, width) => String(value ?? '—').padEnd(width);
  const padStart = (value, width) => String(value ?? '—').padStart(width);

  console.log(`\nFORMEX COVERAGE — ${API_BASE}`);
  console.log('─'.repeat(118));
  console.log(`${pad('act', 28)}${pad('served from', 13)}${padStart('arts', 6)}${padStart('recs', 6)}${padStart('anx', 5)}${padStart('defs', 6)}  ${pad('manifestation', 46)}`);
  console.log('─'.repeat(118));
  for (const row of rows) {
    console.log(
      pad(row.label, 28)
      + pad(row.source, 13)
      + padStart(row.articles, 6)
      + padStart(row.recitals, 6)
      + padStart(row.annexes, 5)
      + padStart(row.definitions, 6)
      + '  ' + pad(row.manifestation, 46)
      + (row.missed ? '  ← Formex exists, unused' : '')
      + (row.emptyParse ? '  ⚠ EMPTY PARSE (0 articles/recitals/annexes)' : '')
    );
  }

  const missed = rows.filter((row) => row.missed);
  const noFmx = rows.filter((row) => !row.manifestation);
  const empty = rows.filter((row) => row.emptyParse);
  console.log('─'.repeat(118));
  console.log(`${rows.length} acts · ${missed.length} with unused Formex · ${noFmx.length} with none published · ${empty.length} with an empty parse\n`);
  if (missed.length || empty.length) process.exitCode = 1;
}
