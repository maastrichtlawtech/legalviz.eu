const path = require('path');

const DEFAULT_RESOLUTION_CACHE_FILE = 'resolution-cache.sqlite';
const DEFAULT_RESOLUTION_CACHE_MAX_ENTRIES = 10_000;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
// Keep individual cache keys and serialized values below 64 KiB to bound file growth.
const MAX_RESOLUTION_CACHE_ENTRY_BYTES = 64 * 1024;
// Expired rows are swept on a timer rather than on every read and write: this
// cache sits on the request path, and a DELETE per lookup would take a write
// lock for each one. Correctness does not depend on the sweep — reads filter on
// `expires_at` — so it only bounds how long dead rows occupy the entry budget.
const PRUNE_INTERVAL_MS = 60 * 1000;

// This is deliberately independent of the shipped data.sqlite schema version.
const RESOLUTION_CACHE_SCHEMA_VERSION = 1;

function isTransientSqliteError(error) {
  return error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED';
}

function normalizeMaxEntries(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_RESOLUTION_CACHE_MAX_ENTRIES;
}

class ResolutionCacheStore {
  constructor({
    cacheDir,
    databasePath = null,
    maxEntries = DEFAULT_RESOLUTION_CACHE_MAX_ENTRIES,
  } = {}) {
    this.databasePath = databasePath || (cacheDir ? path.join(cacheDir, DEFAULT_RESOLUTION_CACHE_FILE) : null);
    this.maxEntries = normalizeMaxEntries(maxEntries);
    this.database = null;
    this.statements = null;
    this.writeTransaction = null;
    this.available = false;
    this.failureLogged = false;
    this.lastPrunedAt = 0;
    this.initialize();
  }

  initialize() {
    let database = null;
    try {
      if (!this.databasePath) {
        throw new Error('No cache directory configured');
      }

      // Load lazily so a missing native module degrades to the normal Map.
      const Database = require('better-sqlite3');
      database = new Database(this.databasePath);
      this.database = database;
      database.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
      // WAL keeps a writer from blocking the readers on the request path.
      database.pragma('journal_mode = WAL');

      const schemaVersion = database.pragma('user_version', { simple: true });
      if (schemaVersion !== RESOLUTION_CACHE_SCHEMA_VERSION) {
        database.exec('DROP TABLE IF EXISTS resolution_cache');
      }

      database.exec(`
        CREATE TABLE IF NOT EXISTS resolution_cache (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          key TEXT NOT NULL UNIQUE,
          value TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS resolution_cache_expires_at
          ON resolution_cache (expires_at);
      `);
      database.pragma(`user_version = ${RESOLUTION_CACHE_SCHEMA_VERSION}`);

      this.statements = {
        count: database.prepare('SELECT COUNT(*) AS count FROM resolution_cache'),
        deleteExpired: database.prepare('DELETE FROM resolution_cache WHERE expires_at <= ?'),
        deleteKey: database.prepare('DELETE FROM resolution_cache WHERE key = ?'),
        deleteOldest: database.prepare(`
          DELETE FROM resolution_cache
          WHERE id IN (
            SELECT id FROM resolution_cache ORDER BY id ASC LIMIT ?
          )
        `),
        findKey: database.prepare('SELECT id FROM resolution_cache WHERE key = ?'),
        get: database.prepare('SELECT value, expires_at AS expiresAt FROM resolution_cache WHERE key = ?'),
        upsert: database.prepare(`
          INSERT INTO resolution_cache (key, value, expires_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            expires_at = excluded.expires_at
        `),
      };

      this.writeTransaction = database.transaction((key, serialized, expiresAt, maxEntries) => {
        const now = Date.now();
        if (expiresAt <= now) {
          this.statements.deleteKey.run(key);
          return;
        }

        const existing = this.statements.findKey.get(key);
        if (!existing) {
          const count = this.statements.count.get().count;
          if (count >= maxEntries) {
            this.statements.deleteOldest.run(count - maxEntries + 1);
          }
        }
        this.statements.upsert.run(key, serialized, expiresAt);
      }).immediate;

      this.prune(this.maxEntries);
      this.available = true;
    } catch (error) {
      if (isTransientSqliteError(error)) {
        this.logTransientFailure(error);
        if (this.database && this.statements && this.writeTransaction) {
          this.available = true;
          return;
        }
        if (database) {
          try { database.close(); } catch { /* best effort */ }
        }
        this.database = null;
        this.statements = null;
        this.writeTransaction = null;
        return;
      }
      if (database && !this.database) {
        try { database.close(); } catch { /* best effort */ }
      }
      this.disable(error);
    }
  }

  prune(maxEntries = this.maxEntries) {
    if (!this.database || !this.statements) return;
    const normalizedMaxEntries = normalizeMaxEntries(maxEntries);
    this.statements.deleteExpired.run(Date.now());
    const count = this.statements.count.get().count;
    if (count > normalizedMaxEntries) {
      this.statements.deleteOldest.run(count - normalizedMaxEntries);
    }
    this.lastPrunedAt = Date.now();
  }

  maybePrune(maxEntries = this.maxEntries) {
    if (Date.now() - this.lastPrunedAt < PRUNE_INTERVAL_MS) return;
    this.prune(maxEntries);
  }

  get(key) {
    if (!this.available || !this.database || !this.statements) return null;

    try {
      const now = Date.now();
      const row = this.statements.get.get(String(key));
      if (!row || row.expiresAt <= now) return null;

      return {
        value: JSON.parse(row.value),
        expiresAt: row.expiresAt,
      };
    } catch (error) {
      if (isTransientSqliteError(error)) {
        this.logTransientFailure(error);
        return null;
      }
      this.disable(error);
      return null;
    }
  }

  set(key, value, expiresAt, maxEntries = this.maxEntries) {
    if (!this.available || !this.database || !this.statements || !this.writeTransaction) return;

    try {
      const serialized = JSON.stringify(value);
      if (typeof serialized !== 'string') {
        throw new TypeError('Cache value is not JSON-serializable');
      }
      const normalizedKey = String(key);
      if (Buffer.byteLength(normalizedKey, 'utf8') > MAX_RESOLUTION_CACHE_ENTRY_BYTES
        || Buffer.byteLength(serialized, 'utf8') > MAX_RESOLUTION_CACHE_ENTRY_BYTES) {
        return;
      }
      const normalizedMaxEntries = normalizeMaxEntries(maxEntries);
      this.maybePrune(normalizedMaxEntries);
      this.writeTransaction(normalizedKey, serialized, expiresAt, normalizedMaxEntries);
    } catch (error) {
      if (isTransientSqliteError(error)) {
        this.logTransientFailure(error);
        return;
      }
      this.disable(error);
    }
  }

  logTransientFailure(error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[ResolutionCache] Persistent operation skipped after transient SQLite error: ${message}`);
  }

  disable(error) {
    this.available = false;
    if (!this.failureLogged) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ResolutionCache] Persistent store disabled; using in-memory cache only: ${message}`);
      this.failureLogged = true;
    }

    if (this.database) {
      try { this.database.close(); } catch { /* best effort */ }
    }
    this.database = null;
    this.statements = null;
    this.writeTransaction = null;
  }

  close() {
    if (!this.database) return;
    try { this.database.close(); } catch { /* already closed or failed */ }
    this.database = null;
    this.statements = null;
    this.writeTransaction = null;
    this.available = false;
  }
}

function createPersistentCache(options = {}) {
  const cache = new Map();
  const store = new ResolutionCacheStore(options);
  Object.defineProperty(cache, 'persistentStore', {
    configurable: false,
    enumerable: false,
    value: store,
    writable: false,
  });
  return cache;
}

module.exports = {
  DEFAULT_RESOLUTION_CACHE_FILE,
  DEFAULT_RESOLUTION_CACHE_MAX_ENTRIES,
  MAX_RESOLUTION_CACHE_ENTRY_BYTES,
  RESOLUTION_CACHE_SCHEMA_VERSION,
  SQLITE_BUSY_TIMEOUT_MS,
  ResolutionCacheStore,
  createPersistentCache,
};
