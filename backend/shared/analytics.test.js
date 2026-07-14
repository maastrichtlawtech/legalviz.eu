const test = require('node:test');
const assert = require('node:assert/strict');

const { createAnalytics } = require('./analytics');
const { CASE_LAW_CACHE_FILE } = require('./law-queries');

// Drive the finish handler the way Express would.
function hit(analytics, req, statusCode = 200) {
  let onFinish;
  const res = { statusCode, on: (event, cb) => { if (event === 'finish') onFinish = cb; } };
  analytics.middleware(req, res, () => {});
  onFinish();
}

function baseReq(overrides = {}) {
  return { headers: {}, socket: {}, statusCode: 200, ...overrides };
}

test('classifies requests into mcp / web / api channels', () => {
  const analytics = createAnalytics({});
  hit(analytics, baseReq({ path: '/mcp', route: { path: '/mcp' } }));
  hit(analytics, baseReq({ path: '/api/search', route: { path: '/api/search' }, query: {}, headers: { 'x-legalviz-client': 'web' } }));
  hit(analytics, baseReq({ path: '/api/laws/32016R0679', route: { path: '/api/laws/:celex' } }));

  const stats = analytics.getStats();
  assert.deepEqual(stats.channels, { mcp: 1, web: 1, api: 1 });
  assert.deepEqual(stats.today.channels, { web: 1, api: 1, mcp: 1 });
  analytics.shutdown();
});

test('recordMcpTool feeds route, celex, and search counters', () => {
  const analytics = createAnalytics({});
  analytics.recordMcpTool('get_law_part', { celex: '32016R0679' });
  analytics.recordMcpTool('search_eu_law', { query: 'Right To Erasure' });

  const stats = analytics.getStats();
  assert.ok(stats.topRoutes.some((r) => r.route === 'mcp:get_law_part' && r.count === 1));
  assert.ok(stats.topRoutes.some((r) => r.route === 'mcp:search_eu_law'));
  assert.ok(stats.topCelexes.some((c) => c.celex === '32016R0679'));
  assert.equal(stats.totalSearches, 1);
  analytics.shutdown();
});

test('persists channel counters across a flush/reload cycle', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-channels-'));

  const first = createAnalytics({ cacheDir });
  hit(first, baseReq({ path: '/mcp', route: { path: '/mcp' } }));
  hit(first, baseReq({ path: '/api/x', route: { path: '/api/x' }, headers: { 'x-legalviz-client': 'web' } }));
  first.shutdown(); // flush to disk

  const persisted = JSON.parse(fs.readFileSync(path.join(cacheDir, 'analytics.json'), 'utf8'));
  assert.equal(persisted.schemaVersion, 2);
  assert.equal(persisted.channelCounts.mcp, 1);
  assert.equal(persisted.channelCounts.web, 1);
  assert.deepEqual(persisted.today.channels, { web: 1, api: 0, mcp: 1 });
  assert.equal(typeof persisted.today.uniqueSketch, 'string');
  assert.equal('uniqueIps' in persisted.today, false);
  assert.equal('searchCounts' in persisted, false);

  // A fresh instance hydrates the persisted channel state.
  const second = createAnalytics({ cacheDir });
  const stats = second.getStats();
  assert.equal(stats.channels.mcp, 1);
  assert.equal(stats.channels.web, 1);
  second.shutdown();
});

test('getStats reads case-law cache stats from the current cache filename', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-caselaw-'));

  assert.equal(CASE_LAW_CACHE_FILE, 'case-law-cache-v5.json');
  fs.writeFileSync(
    path.join(cacheDir, CASE_LAW_CACHE_FILE),
    JSON.stringify({
      '62016CJ0001': { name: 'Case 1', declarations: ['x'] },
      '62016CJ0002': { name: null, declarations: [] },
    }),
    'utf8'
  );

  const analytics = createAnalytics({ cacheDir });
  const stats = analytics.getStats();
  assert.deepEqual(stats.caseLawCache, { total: 2, partial: 1, failedRecently: 0 });
  analytics.shutdown();
});

test('getClientIp prefers req.ip and falls back to the socket address', () => {
  const analytics = createAnalytics({});
  hit(analytics, baseReq({
    path: '/api/x',
    route: { path: '/api/x' },
    ip: '203.0.113.5',
    headers: { 'x-forwarded-for': '10.0.0.1' }, // client-supplied header must be ignored
  }));
  hit(analytics, baseReq({
    path: '/api/y',
    route: { path: '/api/y' },
    socket: { remoteAddress: '198.51.100.9' },
  }));

  const stats = analytics.getStats();
  assert.equal(stats.today.uniqueUsers, 2);
  analytics.shutdown();
});

test('exposes useful per-day aggregates without identifiers or query text', () => {
  let current = new Date('2026-07-12T23:59:00Z');
  const analytics = createAnalytics({
    now: () => current,
    hashKey: 'test-only-secret',
  });

  hit(analytics, baseReq({
    ip: '203.0.113.10',
    path: '/api/search',
    route: { path: '/api/search' },
    query: { q: 'possibly sensitive phrase' },
    headers: { 'x-legalviz-client': 'web' },
  }));
  hit(analytics, baseReq({
    ip: '203.0.113.99', // Same anonymized /24 bucket.
    path: '/api/search',
    route: { path: '/api/search' },
    query: { q: 'another phrase' },
  }), 503);

  current = new Date('2026-07-13T00:01:00Z');
  const stats = analytics.getStats();
  assert.deepEqual(stats.days['2026-07-12'], {
    requests: 2,
    uniqueUsersEstimate: 1,
    channels: { web: 1, api: 1, mcp: 0 },
    statusCodes: { '2xx': 1, '5xx': 1 },
    searches: 1,
    topRoutes: [{ route: '/api/search', count: 2 }],
    topCelexes: [],
  });
  assert.equal(JSON.stringify(stats).includes('sensitive phrase'), false);
  analytics.shutdown();
});

test('migrates legacy history and archives a stale persisted today', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-migration-'));
  fs.writeFileSync(path.join(cacheDir, 'analytics.json'), JSON.stringify({
    dayCounts: { '2026-07-10': 12 },
    dayUniques: { '2026-07-10': 4 },
    today: {
      date: '2026-07-12',
      requests: 7,
      uniqueIps: ['203.0.113.0', '198.51.100.0'],
      channels: { web: 5, api: 2, mcp: 0 },
    },
    searchCounts: { private: 3, terms: 2 },
  }), 'utf8');

  const analytics = createAnalytics({
    cacheDir,
    now: () => new Date('2026-07-13T12:00:00Z'),
    hashKey: 'test-only-secret',
  });
  const stats = analytics.getStats();
  assert.equal(stats.days['2026-07-10'].requests, 12);
  assert.equal(stats.days['2026-07-10'].uniqueUsersEstimate, 4);
  assert.equal(stats.days['2026-07-12'].requests, 7);
  assert.equal(stats.days['2026-07-12'].uniqueUsersEstimate, 2);
  assert.equal(stats.totalSearches, 5);

  analytics.shutdown();
  const persisted = fs.readFileSync(path.join(cacheDir, 'analytics.json'), 'utf8');
  assert.equal(persisted.includes('uniqueIps'), false);
  assert.equal(persisted.includes('private'), false);
});
