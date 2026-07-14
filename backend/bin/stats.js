#!/usr/bin/env node

const args = process.argv.slice(2);
const isLocal = args.includes('--local');
const asJson = args.includes('--json');

const token = process.env.ANALYTICS_TOKEN;
if (!token) {
  console.error('ANALYTICS_TOKEN not set. Run via npm script so ../.env is loaded, or export it.');
  process.exit(1);
}

const base = isLocal
  ? `http://localhost:${process.env.PORT || 3001}`
  : process.env.BACKEND_URL || 'https://api.legalviz.eu';

const url = `${base}/api/_stats`;

(async () => {
  let res;
  try {
    res = await fetch(url, { headers: { 'x-analytics-token': token } });
  } catch (err) {
    console.error(`Request failed: ${err.message}`);
    process.exit(1);
  }

  const body = await res.text();
  if (!res.ok) {
    console.error(`${res.status} ${res.statusText} from ${url}`);
    console.error(body);
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    console.error('Response was not JSON:');
    console.error(body);
    process.exit(1);
  }

  if (asJson) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  print(data);
})();

function fmtUptime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function table(rows, cols) {
  const widths = cols.map((c) =>
    Math.max(c.label.length, ...rows.map((r) => String(c.get(r) ?? '').length))
  );
  const line = (cells) =>
    cells.map((cell, i) => String(cell).padEnd(widths[i])).join('  ').trimEnd();
  console.log(line(cols.map((c) => c.label)));
  console.log(line(widths.map((w) => '-'.repeat(w))));
  for (const r of rows) console.log(line(cols.map((c) => c.get(r) ?? '')));
}

function print(d) {
  console.log(`Backend: ${base}`);
  console.log(`Uptime:  ${fmtUptime(d.uptimeSec || 0)}`);
  console.log(
    `Today:   ${d.today?.date}  requests=${d.today?.requests}  uniqueUsers=${d.today?.uniqueUsers}`
  );

  const days = Object.keys({ ...(d.dayCounts || {}), ...(d.dayUniques || {}) }).sort();
  const recent = days.slice(-14);
  if (recent.length) {
    console.log('\nLast 14 days:');
    table(
      recent.map((date) => ({
        date,
        requests: d.dayCounts?.[date] ?? 0,
        unique: d.dayUniques?.[date] ?? 0,
      })),
      [
        { label: 'date', get: (r) => r.date },
        { label: 'requests', get: (r) => r.requests },
        { label: 'unique', get: (r) => r.unique },
      ]
    );
  }

  const section = (title, rows, cols) => {
    if (!rows?.length) return;
    console.log(`\n${title}:`);
    table(rows.slice(0, 10), cols);
  };

  section('Top routes', d.topRoutes, [
    { label: 'route', get: (r) => r.route },
    { label: 'count', get: (r) => r.count },
  ]);
  section('Top CELEXes', d.topCelexes, [
    { label: 'celex', get: (r) => r.celex },
    { label: 'count', get: (r) => r.count },
  ]);
  if (Number.isFinite(d.totalSearches)) {
    console.log(`\nSearches: ${d.totalSearches} total (query text is not stored)`);
  }

  if (d.caseLawCache) {
    console.log('\nCase-law cache:');
    console.log(
      `  total=${d.caseLawCache.total}  partial=${d.caseLawCache.partial}  failedRecently=${d.caseLawCache.failedRecently}`
    );
  }
}
