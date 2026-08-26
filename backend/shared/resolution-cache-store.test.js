const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { cacheGet, cacheSet } = require('./api-utils');
const {
  DEFAULT_RESOLUTION_CACHE_FILE,
  RESOLUTION_CACHE_SCHEMA_VERSION,
  createPersistentCache,
} = require('./resolution-cache-store');

function withTempCacheDir(callback) {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legalviz-resolution-cache-'));
  try {
    return callback(cacheDir);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

function closeCache(cache) {
  cache.persistentStore.close();
}

test('a value written before a simulated restart is served from the durable cache', () => {
  withTempCacheDir((cacheDir) => {
    const firstProcessCache = createPersistentCache({ cacheDir });
    const value = { results: [{ celex: '32016R0679' }], nested: { ok: true } };
    cacheSet(firstProcessCache, 'metadata:32016R0679', value, 60_000);
    closeCache(firstProcessCache);

    const restartedProcessCache = createPersistentCache({ cacheDir });
    assert.deepEqual(cacheGet(restartedProcessCache, 'metadata:32016R0679'), value);
    closeCache(restartedProcessCache);
  });
});

test('expired durable values are not served and are pruned', () => {
  withTempCacheDir((cacheDir) => {
    const firstProcessCache = createPersistentCache({ cacheDir });
    cacheSet(firstProcessCache, 'case-law:expired', { stale: true }, 60_000);
    closeCache(firstProcessCache);

    const databasePath = path.join(cacheDir, DEFAULT_RESOLUTION_CACHE_FILE);
    const database = new Database(databasePath);
    database.prepare('UPDATE resolution_cache SET expires_at = ?').run(Date.now() - 1);
    database.close();

    const restartedProcessCache = createPersistentCache({ cacheDir });
    assert.equal(cacheGet(restartedProcessCache, 'case-law:expired'), null);
    closeCache(restartedProcessCache);

    const prunedDatabase = new Database(path.join(cacheDir, DEFAULT_RESOLUTION_CACHE_FILE), { readonly: true });
    assert.equal(prunedDatabase.prepare('SELECT COUNT(*) AS count FROM resolution_cache').get().count, 0);
    prunedDatabase.close();
  });
});

test('an unavailable cache directory degrades to memory-only without throwing', () => {
  withTempCacheDir((cacheDir) => {
    const directoryPath = path.join(cacheDir, 'not-a-directory');
    fs.writeFileSync(directoryPath, 'occupied');
    const cache = createPersistentCache({ cacheDir: directoryPath });

    assert.doesNotThrow(() => cacheSet(cache, 'procedure:32016R0679', { memoryOnly: true }, 60_000));
    assert.deepEqual(cacheGet(cache, 'procedure:32016R0679'), { memoryOnly: true });
    assert.equal(cache.persistentStore.available, false);
    closeCache(cache);
  });
});

test('a corrupt SQLite file degrades to memory-only without throwing', () => {
  withTempCacheDir((cacheDir) => {
    fs.writeFileSync(path.join(cacheDir, DEFAULT_RESOLUTION_CACHE_FILE), 'not a SQLite database');
    const cache = createPersistentCache({ cacheDir });

    assert.doesNotThrow(() => cacheSet(cache, 'consolidated:32016R0679', { memoryOnly: true }, 60_000));
    assert.deepEqual(cacheGet(cache, 'consolidated:32016R0679'), { memoryOnly: true });
    assert.equal(cache.persistentStore.available, false);
    closeCache(cache);
  });
});

test('the durable cache evicts its oldest rows at the configured entry limit', () => {
  withTempCacheDir((cacheDir) => {
    const cache = createPersistentCache({ cacheDir });
    cacheSet(cache, 'oldest', { value: 1 }, 60_000, 2);
    cacheSet(cache, 'middle', { value: 2 }, 60_000, 2);
    cacheSet(cache, 'newest', { value: 3 }, 60_000, 2);
    closeCache(cache);

    const restartedCache = createPersistentCache({ cacheDir });
    assert.equal(cacheGet(restartedCache, 'oldest'), null);
    assert.deepEqual(cacheGet(restartedCache, 'middle'), { value: 2 });
    assert.deepEqual(cacheGet(restartedCache, 'newest'), { value: 3 });
    closeCache(restartedCache);
  });
});

test('a schema-version mismatch resets the cache table instead of serving stale rows', () => {
  withTempCacheDir((cacheDir) => {
    const firstProcessCache = createPersistentCache({ cacheDir });
    cacheSet(firstProcessCache, 'amendments:stale', { stale: true }, 60_000);
    closeCache(firstProcessCache);

    const databasePath = path.join(cacheDir, DEFAULT_RESOLUTION_CACHE_FILE);
    const database = new Database(databasePath);
    database.pragma(`user_version = ${RESOLUTION_CACHE_SCHEMA_VERSION + 1}`);
    database.close();

    const restartedProcessCache = createPersistentCache({ cacheDir });
    assert.equal(cacheGet(restartedProcessCache, 'amendments:stale'), null);

    cacheSet(restartedProcessCache, 'amendments:fresh', { fresh: true }, 60_000);
    closeCache(restartedProcessCache);

    const finalProcessCache = createPersistentCache({ cacheDir });
    assert.deepEqual(cacheGet(finalProcessCache, 'amendments:fresh'), { fresh: true });
    closeCache(finalProcessCache);
  });
});
