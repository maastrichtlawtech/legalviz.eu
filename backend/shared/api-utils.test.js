'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CACHE_SWEEP_INTERVAL_MS,
  cacheGet,
  cacheSet,
  sweepExpiredEntries,
} = require('./api-utils');

test('sweepExpiredEntries drops expired entries and keeps live ones', () => {
  const cache = new Map([
    ['expired', { value: 1, expiresAt: 1_000 }],
    ['live', { value: 2, expiresAt: 3_000 }],
  ]);
  sweepExpiredEntries(cache, 2_000);
  assert.deepEqual([...cache.keys()], ['live']);
});

test('a cache written to is swept of expired entries without being read again', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  const cache = new Map();
  cacheSet(cache, 'short', 'a', 1_000);
  cacheSet(cache, 'long', 'b', 10 * CACHE_SWEEP_INTERVAL_MS);
  assert.equal(cache.size, 2);

  t.mock.timers.tick(CACHE_SWEEP_INTERVAL_MS);
  assert.deepEqual([...cache.keys()], ['long'], 'the expired entry is gone, though no one asked for it');
  assert.equal(cacheGet(cache, 'long'), 'b');

  t.mock.timers.tick(10 * CACHE_SWEEP_INTERVAL_MS);
  assert.equal(cache.size, 0);
});
