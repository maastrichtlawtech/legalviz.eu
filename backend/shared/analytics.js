const fs = require('fs');
const path = require('path');

const FLUSH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DAY_RETENTION = 90;
const COUNTER_CAP = 1000;

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
}

function truncateIp(ip) {
  if (!ip || ip === 'unknown') return 'unknown';
  // Strip IPv6 zone ID
  const bare = ip.replace(/%.*$/, '');
  // v4-mapped IPv6: ::ffff:1.2.3.4
  const v4mapped = bare.match(/^::ffff:(\d+\.\d+\.\d+)\.\d+$/i);
  if (v4mapped) return `${v4mapped[1]}.0`;
  // Plain IPv4
  const v4 = bare.match(/^(\d+\.\d+\.\d+)\.\d+$/);
  if (v4) return `${v4[1]}.0`;
  // IPv6: keep first 4 hextets
  if (bare.includes(':')) {
    const full = bare.replace(/::/, ':'.repeat(9 - bare.split(':').length) + ':').split(':').slice(0, 4);
    return `${full.join(':')}::`;
  }
  return bare;
}

function utcDateString() {
  return new Date().toISOString().slice(0, 10);
}

function capMap(map) {
  if (map.size <= COUNTER_CAP) return;
  const sorted = [...map.entries()].sort((a, b) => a[1] - b[1]);
  const toDelete = sorted.slice(0, map.size - COUNTER_CAP);
  for (const [k] of toDelete) map.delete(k);
}

function trimObject(obj, maxEntries) {
  const keys = Object.keys(obj);
  if (keys.length <= maxEntries) return obj;
  const sorted = keys.sort();
  const keep = sorted.slice(sorted.length - maxEntries);
  const result = {};
  for (const k of keep) result[k] = obj[k];
  return result;
}

function createAnalytics({ cacheDir } = {}) {
  const startTime = Date.now();
  const analyticsFile = cacheDir ? path.join(cacheDir, 'analytics.json') : null;

  const routeCounts = new Map();
  const celexCounts = new Map();
  const searchCounts = new Map();
  const channelCounts = new Map(); // all-time: 'web' | 'api' | 'mcp' -> count
  let dayCounts = {};
  let dayUniques = {};
  let dayChannels = {}; // date -> { web, api, mcp }
  let todayDate = utcDateString();
  let todayIps = new Set();
  let todayRequests = 0;
  let todayChannels = { web: 0, api: 0, mcp: 0 };

  // Hydrate from disk
  if (analyticsFile) {
    try {
      if (fs.existsSync(analyticsFile)) {
        const saved = JSON.parse(fs.readFileSync(analyticsFile, 'utf8'));
        if (saved.routeCounts) for (const [k, v] of Object.entries(saved.routeCounts)) routeCounts.set(k, v);
        if (saved.celexCounts) for (const [k, v] of Object.entries(saved.celexCounts)) celexCounts.set(k, v);
        if (saved.searchCounts) for (const [k, v] of Object.entries(saved.searchCounts)) searchCounts.set(k, v);
        if (saved.channelCounts) for (const [k, v] of Object.entries(saved.channelCounts)) channelCounts.set(k, v);
        if (saved.dayCounts) dayCounts = saved.dayCounts;
        if (saved.dayUniques) dayUniques = saved.dayUniques;
        if (saved.dayChannels) dayChannels = saved.dayChannels;
        if (saved.today?.date === todayDate) {
          todayIps = new Set(saved.today.uniqueIps || []);
          todayRequests = saved.today.requests || 0;
          if (saved.today.channels) {
            todayChannels = {
              web: saved.today.channels.web || 0,
              api: saved.today.channels.api || 0,
              mcp: saved.today.channels.mcp || 0,
            };
          }
        }
      }
    } catch {
      // best-effort hydration
    }
  }

  function rolloverDayIfNeeded() {
    const today = utcDateString();
    if (today !== todayDate) {
      dayUniques[todayDate] = todayIps.size;
      dayCounts[todayDate] = (dayCounts[todayDate] || 0) + todayRequests;
      dayChannels[todayDate] = todayChannels;
      todayDate = today;
      todayIps = new Set();
      todayRequests = 0;
      todayChannels = { web: 0, api: 0, mcp: 0 };
      dayCounts = trimObject(dayCounts, DAY_RETENTION);
      dayUniques = trimObject(dayUniques, DAY_RETENTION);
      dayChannels = trimObject(dayChannels, DAY_RETENTION);
    }
  }

  function flush() {
    if (!analyticsFile) return;
    rolloverDayIfNeeded();
    try {
      const data = {
        routeCounts: Object.fromEntries(routeCounts),
        celexCounts: Object.fromEntries(celexCounts),
        searchCounts: Object.fromEntries(searchCounts),
        channelCounts: Object.fromEntries(channelCounts),
        dayCounts,
        dayUniques,
        dayChannels,
        today: { date: todayDate, requests: todayRequests, uniqueIps: [...todayIps], channels: todayChannels },
      };
      const tmp = analyticsFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
      fs.renameSync(tmp, analyticsFile);
    } catch {
      // best-effort
    }
  }

  const flushTimer = setInterval(flush, FLUSH_INTERVAL_MS).unref();

  function classifyChannel(req) {
    const requestPath = req.path || req.originalUrl || req.url || '';
    if (requestPath.startsWith('/mcp')) return 'mcp';
    if (req.headers?.['x-legalviz-client'] === 'web') return 'web';
    return 'api';
  }

  function middleware(req, res, next) {
    res.on('finish', () => {
      rolloverDayIfNeeded();

      const ip = truncateIp(getClientIp(req));
      todayIps.add(ip);
      todayRequests++;

      const channel = classifyChannel(req);
      todayChannels[channel] = (todayChannels[channel] || 0) + 1;
      channelCounts.set(channel, (channelCounts.get(channel) || 0) + 1);

      const route = req.route?.path;
      if (route) {
        routeCounts.set(route, (routeCounts.get(route) || 0) + 1);
        capMap(routeCounts);
      }

      const celex = req.params?.celex;
      if (celex && res.statusCode < 500) {
        celexCounts.set(celex, (celexCounts.get(celex) || 0) + 1);
        capMap(celexCounts);
      }

      if (route && route.includes('search') && res.statusCode === 200) {
        const q = String(req.query?.q || '').toLowerCase().trim().slice(0, 120);
        if (q) {
          searchCounts.set(q, (searchCounts.get(q) || 0) + 1);
          capMap(searchCounts);
        }
      }
    });
    next();
  }

  /**
   * Record a single MCP tool invocation. The HTTP middleware already counts the
   * POST /mcp request (and its channel); this adds per-tool granularity that the
   * middleware can't see inside the JSON-RPC body. Tool calls surface in
   * topRoutes under the key `mcp:<tool>`.
   */
  function recordMcpTool(toolName, { celex, query } = {}) {
    rolloverDayIfNeeded();
    const routeKey = `mcp:${toolName}`;
    routeCounts.set(routeKey, (routeCounts.get(routeKey) || 0) + 1);
    capMap(routeCounts);

    if (celex) {
      celexCounts.set(celex, (celexCounts.get(celex) || 0) + 1);
      capMap(celexCounts);
    }

    const q = String(query || '').toLowerCase().trim().slice(0, 120);
    if (q) {
      searchCounts.set(q, (searchCounts.get(q) || 0) + 1);
      capMap(searchCounts);
    }
  }

  function topN(map, n = 20) {
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([key, count]) => ({ key, count }));
  }

  function getCaseLawCacheStats() {
    if (!cacheDir) return null;
    try {
      const cache = JSON.parse(
        fs.readFileSync(path.join(cacheDir, 'case-law-cache-v3.json'), 'utf8')
      );
      const entries = Object.values(cache);
      const total = entries.length;
      const partial = entries.filter(
        (e) => !e.name || !Array.isArray(e.declarations) || e.declarations.length === 0
      ).length;
      const cooldown = 6 * 60 * 60 * 1000;
      const failedRecently = entries.filter(
        (e) => e.lastFailedAt && Date.now() - e.lastFailedAt < cooldown
      ).length;
      return { total, partial, failedRecently };
    } catch {
      return null;
    }
  }

  function getStats() {
    rolloverDayIfNeeded();
    const topCelexes = topN(celexCounts).map(({ key, count }) => ({ celex: key, count }));
    const topRoutes = topN(routeCounts).map(({ key, count }) => ({ route: key, count }));
    const topSearches = topN(searchCounts).map(({ key, count }) => ({ q: key, count }));
    return {
      uptimeSec: Math.floor((Date.now() - startTime) / 1000),
      today: { date: todayDate, requests: todayRequests, uniqueUsers: todayIps.size, channels: { ...todayChannels } },
      dayCounts,
      dayUniques,
      dayChannels,
      channels: Object.fromEntries(channelCounts),
      topCelexes,
      topRoutes,
      topSearches,
      caseLawCache: getCaseLawCacheStats(),
    };
  }

  function shutdown() {
    clearInterval(flushTimer);
    flush();
  }

  return { middleware, recordMcpTool, getStats, shutdown };
}

module.exports = { createAnalytics };
