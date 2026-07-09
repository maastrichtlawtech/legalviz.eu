const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseTitleJson, getCachedRecitalTitles } = require('./recital-title-service');

test('parseTitleJson extracts valid recital title mappings', () => {
  const titles = parseTitleJson('```json\n{"1":" Fundamental right to data protection.","2":"Free movement of data","999":"Ignore me"}\n```', ['1', '2']);

  assert.deepEqual(titles, {
    1: 'Fundamental right to data protection',
    2: 'Free movement of data',
  });
});

test('parseTitleJson returns empty object for malformed responses', () => {
  assert.deepEqual(parseTitleJson('not json', ['1']), {});
});

test('getCachedRecitalTitles returns cached titles on a content-hash match and nothing otherwise', () => {
  const recitals = [
    { recital_number: '1', recital_text: 'First recital.' },
    { recital_number: '2', recital_text: 'Second recital.' },
  ];
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recital-cache-'));

  // No cache file yet.
  assert.deepEqual(getCachedRecitalTitles({ celex: '32016R0679', lang: 'ENG', recitals, cacheDir }), { titles: {}, cached: false });

  const crypto = require('node:crypto');
  const stripTags = (v) => String(v || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const hash = crypto.createHash('sha256');
  for (const r of recitals) {
    hash.update(String(r.recital_number));
    hash.update('\0');
    hash.update(stripTags(r.recital_text));
    hash.update('\0');
  }
  fs.writeFileSync(path.join(cacheDir, 'recital-title-cache-v1.json'), JSON.stringify({
    '32016R0679_ENG': { version: 2, contentHash: hash.digest('hex'), model: 'm', titles: { 1: 'Title one', 2: 'Title two' } },
  }));

  const hit = getCachedRecitalTitles({ celex: '32016R0679', lang: 'ENG', recitals, cacheDir });
  assert.equal(hit.cached, true);
  assert.equal(hit.titles['1'], 'Title one');

  // Changed content invalidates the cache entry.
  const changed = getCachedRecitalTitles({ celex: '32016R0679', lang: 'ENG', recitals: [{ recital_number: '1', recital_text: 'Different.' }], cacheDir });
  assert.equal(changed.cached, false);
});

