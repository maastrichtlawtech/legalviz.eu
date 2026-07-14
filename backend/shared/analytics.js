const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { CASE_LAW_CACHE_FILE } = require('./law-queries');

const FLUSH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DAY_RETENTION = 90;
const COUNTER_CAP = 1000;
const UNIQUE_BITMAP_BITS = 16 * 1024;
const UNIQUE_BITMAP_BYTES = UNIQUE_BITMAP_BITS / 8;

function getClientIp(req) {
  return req.ip || req.socket?.remoteAddress || null;
}

function truncateIp(ip) {
  if (!ip) return null;
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

function utcDateString(now = () => new Date()) {
  return now().toISOString().slice(0, 10);
}

function capMap(map) {
  if (map.size <= COUNTER_CAP) return;
  const sorted = [...map.entries()].sort((a, b) => a[1] - b[1]);
  const toDelete = sorted.slice(0, map.size - COUNTER_CAP);
  for (const [k] of toDelete) map.delete(k);
}

function increment(obj, key) {
  obj[key] = (obj[key] || 0) + 1;
}

function trimDays(days) {
  const keys = Object.keys(days).sort();
  for (const key of keys.slice(0, Math.max(0, keys.length - DAY_RETENTION))) delete days[key];
}

// A per-day record. Unique users are tracked in a keyed, fixed-size bitmap
// sketch rather than a stored set of addresses, so we keep no per-visitor
// identifiers on disk. `uniqueUsersLegacy` carries forward exact counts
// migrated from the old flat format as a floor for the estimate.
function newDaily(date) {
  return {
    date,
    requests: 0,
    uniqueSketch: Buffer.alloc(UNIQUE_BITMAP_BYTES),
    uniqueUsersLegacy: null,
    channels: { web: 0, api: 0, mcp: 0 },
    searches: 0,
  };
}

function decodeSketch(value) {
  if (!value) return Buffer.alloc(UNIQUE_BITMAP_BYTES);
  try {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === UNIQUE_BITMAP_BYTES) return decoded;
  } catch {
    // Invalid persisted sketches are treated as empty.
  }
  return Buffer.alloc(UNIQUE_BITMAP_BYTES);
}

function hydrateDaily(date, saved = {}) {
  const daily = newDaily(date);
  daily.requests = Number(saved.requests) || 0;
  daily.uniqueSketch = decodeSketch(saved.uniqueSketch);
  daily.uniqueUsersLegacy = Number.isFinite(saved.uniqueUsers) ? saved.uniqueUsers : null;
  daily.channels = { ...daily.channels, ...(saved.channels || {}) };
  daily.searches = Number(saved.searches) || 0;
  return daily;
}

function serializeDaily(daily) {
  return {
    requests: daily.requests,
    uniqueSketch: daily.uniqueSketch.toString('base64'),
    ...(daily.uniqueUsersLegacy == null ? {} : { uniqueUsers: daily.uniqueUsersLegacy }),
    channels: daily.channels,
    searches: daily.searches,
  };
}

// Fold an anonymized network bucket into the day's sketch. The HMAC key keeps
// buckets from being reversible and lets the token rotate without resetting
// deduplication when ANALYTICS_HASH_KEY is set separately.
function markUnique(daily, ip, hashKey) {
  const bucket = truncateIp(ip);
  if (!bucket) return;
  const digest = crypto.createHmac('sha256', hashKey).update(`${daily.date}:${bucket}`).digest();
  const bit = digest.readUInt16BE(0) % UNIQUE_BITMAP_BITS;
  daily.uniqueSketch[bit >> 3] |= 1 << (bit & 7);
}

// Estimate distinct buckets from the number of set bits using the standard
// "number of occupied cells" cardinality approximation.
function estimateUniques(daily) {
  let occupied = 0;
  for (const byte of daily.uniqueSketch) {
    let value = byte;
    while (value) {
      occupied += value & 1;
      value >>= 1;
    }
  }
  const estimated = occupied === UNIQUE_BITMAP_BITS
    ? UNIQUE_BITMAP_BITS
    : Math.round(-UNIQUE_BITMAP_BITS * Math.log(1 - occupied / UNIQUE_BITMAP_BITS));
  return Math.max(estimated, daily.uniqueUsersLegacy || 0);
}

function createAnalytics({ cacheDir, now = () => new Date(), hashKey } = {}) {
  const startTime = Date.now();
  const analyticsFile = cacheDir ? path.join(cacheDir, 'analytics.json') : null;
  const uniqueHashKey = hashKey || process.env.ANALYTICS_HASH_KEY
    || process.env.ANALYTICS_TOKEN || crypto.randomBytes(32);

  const routeCounts = new Map();
  const celexCounts = new Map();
  const channelCounts = new Map(); // all-time: 'web' | 'api' | 'mcp' -> count
  const days = {};
  let totalSearches = 0;
  let today = newDaily(utcDateString(now));

  // Hydrate from disk
  if (analyticsFile) {
    try {
      if (fs.existsSync(analyticsFile)) {
        const saved = JSON.parse(fs.readFileSync(analyticsFile, 'utf8'));
        if (saved.routeCounts) for (const [k, v] of Object.entries(saved.routeCounts)) routeCounts.set(k, v);
        if (saved.celexCounts) for (const [k, v] of Object.entries(saved.celexCounts)) celexCounts.set(k, v);
        if (saved.channelCounts) for (const [k, v] of Object.entries(saved.channelCounts)) channelCounts.set(k, v);
        // Legacy formats persisted per-query counts; keep the aggregate total, drop the raw text.
        totalSearches = Number(saved.totalSearches) || Object.values(saved.searchCounts || {})
          .reduce((sum, count) => sum + (Number(count) || 0), 0);

        if (saved.days) {
          for (const [date, daily] of Object.entries(saved.days)) days[date] = hydrateDaily(date, daily);
        } else {
          // Migrate the flat v1 layout (dayCounts / dayUniques / dayChannels).
          for (const date of new Set([
            ...Object.keys(saved.dayCounts || {}),
            ...Object.keys(saved.dayUniques || {}),
            ...Object.keys(saved.dayChannels || {}),
          ])) {
            days[date] = hydrateDaily(date, {
              requests: saved.dayCounts?.[date],
              uniqueUsers: saved.dayUniques?.[date],
              channels: saved.dayChannels?.[date],
            });
          }
        }

        if (saved.today?.date === today.date) {
          today = hydrateDaily(today.date, saved.today);
          for (const ip of saved.today.uniqueIps || []) markUnique(today, ip, uniqueHashKey);
        } else if (saved.today?.date) {
          // The service restarted on a later date: archive the stale `today`
          // instead of dropping it.
          const stale = hydrateDaily(saved.today.date, saved.today);
          for (const ip of saved.today.uniqueIps || []) markUnique(stale, ip, uniqueHashKey);
          const existing = days[stale.date];
          if (!existing || stale.requests > existing.requests) days[stale.date] = stale;
        }
        trimDays(days);
      }
    } catch {
      // Analytics must never prevent the API from starting.
    }
  }

  function rolloverDayIfNeeded() {
    const date = utcDateString(now);
    if (date === today.date) return;
    days[today.date] = today;
    today = newDaily(date);
    trimDays(days);
  }

  function flush() {
    if (!analyticsFile) return;
    rolloverDayIfNeeded();
    try {
      const persistedDays = {};
      for (const [date, daily] of Object.entries(days)) persistedDays[date] = serializeDaily(daily);
      const data = {
        schemaVersion: 2,
        routeCounts: Object.fromEntries(routeCounts),
        celexCounts: Object.fromEntries(celexCounts),
        channelCounts: Object.fromEntries(channelCounts),
        totalSearches,
        days: persistedDays,
        today: { date: today.date, ...serializeDaily(today) },
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
      today.requests++;
      markUnique(today, getClientIp(req), uniqueHashKey);

      const channel = classifyChannel(req);
      increment(today.channels, channel);
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
        today.searches++;
        totalSearches++;
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

    if (String(query || '').trim()) {
      today.searches++;
      totalSearches++;
    }
  }

  function topN(map, n = 20) {
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([key, count]) => ({ key, count }));
  }

  function publicDaily(daily) {
    return {
      requests: daily.requests,
      uniqueUsersEstimate: estimateUniques(daily),
      channels: { ...daily.channels },
      searches: daily.searches,
    };
  }

  function getCaseLawCacheStats() {
    if (!cacheDir) return null;
    try {
      const cache = JSON.parse(
        fs.readFileSync(path.join(cacheDir, CASE_LAW_CACHE_FILE), 'utf8')
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
    const publicDays = {};
    for (const [date, daily] of Object.entries(days)) publicDays[date] = publicDaily(daily);
    const todayPublic = publicDaily(today);
    return {
      schemaVersion: 2,
      privacy: {
        uniqueUsers: 'daily estimate of anonymized network buckets from a keyed bitmap',
        searchQueriesStored: false,
        retentionDays: DAY_RETENTION,
      },
      uptimeSec: Math.floor((Date.now() - startTime) / 1000),
      today: { date: today.date, ...todayPublic, uniqueUsers: todayPublic.uniqueUsersEstimate },
      days: publicDays,
      channels: Object.fromEntries(channelCounts),
      totalSearches,
      topCelexes: topN(celexCounts).map(({ key, count }) => ({ celex: key, count })),
      topRoutes: topN(routeCounts).map(({ key, count }) => ({ route: key, count })),
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
