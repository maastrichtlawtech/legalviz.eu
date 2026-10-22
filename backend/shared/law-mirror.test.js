const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { ClientError } = require('./api-utils');
const { createLawMirror, isUpstreamFailure } = require('./law-mirror');

test('isUpstreamFailure separates outages from definite answers', () => {
  assert.equal(isUpstreamFailure(new TypeError('fetch failed')), true);
  assert.equal(isUpstreamFailure(new Error('HTTP 503 for https://publications.europa.eu/x')), true);
  assert.equal(isUpstreamFailure(new ClientError('busy', 503, 'html_fetch_busy')), true);
  assert.equal(isUpstreamFailure(new ClientError('blocked', 403, 'eurlex_html_unavailable')), true);
  assert.equal(isUpstreamFailure(new ClientError('throttled', 429, 'eurlex_html_unavailable')), true);
  assert.equal(isUpstreamFailure(new ClientError('missing', 404, 'celex_not_found')), false);
  assert.equal(isUpstreamFailure(new ClientError('bad', 400)), false);
  assert.equal(isUpstreamFailure(null), false);
});

test('a mirror without a corpus is disabled and reads nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'law-mirror-'));
  try {
    for (const mirror of [createLawMirror({ dir }), createLawMirror({})]) {
      assert.equal(mirror.enabled, false);
      assert.equal(mirror.hasFmx('32016R0679'), false);
      assert.equal(await mirror.readFmx('32016R0679'), null);
      assert.equal(await mirror.readHtml('31987L0372'), null);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a mirror reads both corpus trees by CELEX', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'law-mirror-'));
  try {
    fs.mkdirSync(path.join(dir, 'laws', '2016'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'laws-html', '1987'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'laws', '2016', '32016R0679.xml.gz'), zlib.gzipSync('<ACT/>'));
    fs.writeFileSync(path.join(dir, 'laws-html', '1987', '31987L0372.html.gz'), zlib.gzipSync('<html/>'));

    const mirror = createLawMirror({ dir });
    assert.equal(mirror.enabled, true);
    assert.equal(mirror.lang, 'ENG');
    assert.equal(mirror.hasFmx('32016R0679'), true);
    assert.equal(mirror.hasHtml('32016R0679'), false);
    assert.equal(mirror.hasHtml('31987L0372'), true);
    assert.equal(await mirror.readFmx('32016R0679'), '<ACT/>');
    assert.equal(await mirror.readHtml('31987L0372'), '<html/>');
    assert.equal(await mirror.readFmx('32024R1689'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
