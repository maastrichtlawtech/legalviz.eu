const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createFmxService } = require('./fmx-service');

const CELLAR_BASE = 'http://publications.europa.eu/resource';

// Every makeService() call mints its own scratch directory; track them so
// they can be removed once, rather than leaking one mkdtempSync() dir per
// test into the OS temp directory on every run.
const createdDirs = [];

function makeCacheDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmx-service-'));
  createdDirs.push(dir);
  return dir;
}

function ageFile(filePath, ageMs = 2 * 60 * 60 * 1000) {
  const old = new Date(Date.now() - ageMs);
  fs.utimesSync(filePath, old, old);
}

function makeService(dir = makeCacheDir(), storageLimitMB = 100) {
  return createFmxService({
    CELLAR_BASE,
    FMX_DIR: dir,
    STORAGE_LIMIT_MB: storageLimitMB,
    TIMEOUT_MS: 5000,
  });
}

test.after(() => {
  for (const dir of createdDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Serve one canned RDF document for the CELEX lookup, listing `uris` as
 * rdf:resource links — the only part of the payload findFmx4Uri reads.
 */
function withCannedRdf(uris, run) {
  const originalFetch = global.fetch;
  const body = uris.map((uri) => `<rdf:resource="${uri}" />`).join('');
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => `<rdf:RDF>${body}</rdf:RDF>`,
  });
  return (async () => {
    try {
      return await run();
    } finally {
      global.fetch = originalFetch;
    }
  })();
}

function responseWithBody(body, headers = {}) {
  const buffer = Buffer.from(body);
  return {
    ok: true,
    status: 200,
    text: async () => body,
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    headers: {
      get: (name) => headers[name.toLowerCase()] || null,
    },
  };
}

function rdfResponse(uris) {
  const body = uris.map((uri) => `<rdf:resource="${uri}" />`).join('');
  return responseWithBody(`<rdf:RDF>${body}</rdf:RDF>`);
}

function withMockFetch(fetchImpl, run) {
  const originalFetch = global.fetch;
  global.fetch = fetchImpl;
  return (async () => {
    try {
      return await run();
    } finally {
      global.fetch = originalFetch;
    }
  })();
}

function prepareFetch({ fmx4Uri, downloadUrls, xml }) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ method, url });
    if (calls.length === 1) return rdfResponse([fmx4Uri]);
    if (calls.length === 2) return rdfResponse(downloadUrls);
    if (method === 'HEAD') {
      return responseWithBody('', { 'content-length': String(Buffer.byteLength(xml)) });
    }
    return responseWithBody(xml);
  };
  return { calls, fetchImpl };
}

// Every manifestation id format observed in Cellar for real acts. The previous
// allowlist accepted only the first two, so the rest fell through to the
// EUR-Lex HTML parser without any error being raised.
const SHAPES = [
  ['post-2016 OJ (AI Act)', `${CELLAR_BASE}/oj/L_202401689.ENG.fmx4`],
  ['pre-2016 OJ (GDPR)', `${CELLAR_BASE}/oj/JOL_2016_119_R_0001.ENG.fmx4`],
  ['pre-2016 OJ with part suffix (CRR)', `${CELLAR_BASE}/oj/JOL_2013_176_R_0001_01.ENG.fmx4`],
  ['planned-OJ manifestation (PSD2)', `${CELLAR_BASE}/immc/planjo%3A20151123-007.ENG.fmx4`],
  ['celex-keyed (consolidated GDPR)', `${CELLAR_BASE}/celex/02016R0679-20160504.ENG.fmx4`],
  ['consolidation-keyed (consolidated CRR)', `${CELLAR_BASE}/consolidation/2013R0575%2F20260626.ENG.fmx4`],
];

for (const [label, uri] of SHAPES) {
  test(`findFmx4Uri accepts the ${label} URI shape`, async () => {
    const { findFmx4Uri } = makeService();
    const found = await withCannedRdf(
      ['http://example.invalid/unrelated', uri, `${CELLAR_BASE}/oj/L_202401689.pdfa1a`],
      () => findFmx4Uri('32013R0575', 'ENG')
    );
    assert.equal(found, uri);
  });
}

test('findFmx4Uri prefers the requested language over the ones beside it', async () => {
  const { findFmx4Uri } = makeService();
  const found = await withCannedRdf([
    `${CELLAR_BASE}/oj/JOL_2013_176_R_0001_01.ENG.fmx4`,
    `${CELLAR_BASE}/oj/JOL_2013_176_R_0001_01.DEU.fmx4`,
  ], () => findFmx4Uri('32013R0575', 'DEU'));

  assert.equal(found, `${CELLAR_BASE}/oj/JOL_2013_176_R_0001_01.DEU.fmx4`);
});

test('findFmx4Uri swaps the language segment when the requested language is absent', async () => {
  const { findFmx4Uri } = makeService();
  const found = await withCannedRdf(
    [`${CELLAR_BASE}/immc/planjo%3A20151123-007.ENG.fmx4`],
    () => findFmx4Uri('32015L2366', 'FRA')
  );

  // Only the trailing language segment changes; the id keeps its own casing
  // and percent-encoding, which a broader replace would corrupt.
  assert.equal(found, `${CELLAR_BASE}/immc/planjo%3A20151123-007.FRA.fmx4`);
});

test('findFmx4Uri still reports 404 for an act that genuinely has no Formex', async () => {
  const { findFmx4Uri } = makeService();
  await assert.rejects(
    () => withCannedRdf([
      `${CELLAR_BASE}/celex/32006R1907.ENG.pdfa1a`,
      `${CELLAR_BASE}/celex/32006R1907.ENG.xhtml`,
    ], () => findFmx4Uri('32006R1907', 'ENG')),
    (error) => error.statusCode === 404
  );
});

test('a truncated downloaded part is treated as a miss and replaced', async () => {
  const dir = makeCacheDir();
  const fmx4Uri = `${CELLAR_BASE}/oj/L_202401689.ENG.fmx4`;
  const downloadUri = `${CELLAR_BASE}/oj/L_202401689.ENG.fmx4.1.xml`;
  const filename = path.basename(downloadUri);
  fs.writeFileSync(path.join(dir, filename), '<?xml version="1.0"?><FMX><ARTICLE>1</ARTICLE>');

  const { calls, fetchImpl } = prepareFetch({
    fmx4Uri,
    downloadUrls: [downloadUri],
    xml: '<?xml version="1.0"?><FMX><ARTICLE>1</ARTICLE></FMX>',
  });
  const service = makeService(dir);
  await withMockFetch(fetchImpl, () => service.prepareLawPayload('32024R1689', 'ENG'));

  assert.deepEqual(calls.map((call) => call.method), ['GET', 'GET', 'HEAD', 'GET']);
  assert.equal(fs.readFileSync(path.join(dir, filename), 'utf8'), '<?xml version="1.0"?><FMX><ARTICLE>1</ARTICLE></FMX>');
});

test('a truncated combined XML is rebuilt instead of served', async () => {
  const dir = makeCacheDir();
  const fmx4Uri = `${CELLAR_BASE}/oj/L_202401689.ENG.fmx4`;
  const downloadUrls = [
    `${CELLAR_BASE}/oj/L_202401689.ENG.fmx4.1.xml`,
    `${CELLAR_BASE}/oj/L_202401689.ENG.fmx4.2.xml`,
  ];
  const firstPart = path.join(dir, path.basename(downloadUrls[0]));
  const secondPart = path.join(dir, path.basename(downloadUrls[1]));
  fs.writeFileSync(firstPart, '<PART>one</PART>');
  fs.writeFileSync(secondPart, '<PART>two</PART>');
  fs.writeFileSync(firstPart.replace(/\.xml$/, '.combined.xml'), '<COMBINED.FMX><PART>one</PART>');

  const { calls, fetchImpl } = prepareFetch({
    fmx4Uri,
    downloadUrls,
    xml: '<unused />',
  });
  const service = makeService(dir);
  const result = await withMockFetch(fetchImpl, () => service.prepareLawPayload('32024R1689', 'ENG'));

  assert.deepEqual(calls.map((call) => call.method), ['GET', 'GET']);
  assert.equal(
    fs.readFileSync(result.servePath, 'utf8'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<COMBINED.FMX>\n<PART>one</PART>\n<PART>two</PART>\n</COMBINED.FMX>'
  );
});

test('orphaned temporary cache files are cleaned when the service starts', () => {
  const dir = makeCacheDir();
  const tempPath = path.join(dir, 'L_202401689.ENG.fmx4.1.xml.12345.tmp');
  fs.writeFileSync(tempPath, 'partial write');
  ageFile(tempPath);

  makeService(dir);

  assert.equal(fs.existsSync(tempPath), false);
});

test('orphaned temporary cache files are cleaned before an eviction pass', async () => {
  const dir = makeCacheDir();
  const service = makeService(dir);
  const tempPath = path.join(dir, 'L_202401689.ENG.fmx4.1.xml.12345.tmp');
  fs.writeFileSync(tempPath, 'partial write');
  ageFile(tempPath);

  const fmx4Uri = `${CELLAR_BASE}/oj/L_202401689.ENG.fmx4`;
  const downloadUri = `${CELLAR_BASE}/oj/L_202401689.ENG.fmx4.1.xml`;
  const cachedPath = path.join(dir, path.basename(downloadUri));
  fs.writeFileSync(cachedPath, '<?xml version="1.0"?><FMX><ARTICLE>1</ARTICLE></FMX>');
  const { fetchImpl } = prepareFetch({
    fmx4Uri,
    downloadUrls: [downloadUri],
    xml: '<unused />',
  });

  await withMockFetch(fetchImpl, () => service.prepareLawPayload('32024R1689', 'ENG'));

  assert.equal(fs.existsSync(tempPath), false);
});

test('fresh temporary cache files survive cleanup while old ones are removed', () => {
  const dir = makeCacheDir();
  const freshPath = path.join(dir, 'fresh.fmx4.1.xml.12345.tmp');
  const oldPath = path.join(dir, 'old.fmx4.1.xml.12345.tmp');
  fs.writeFileSync(freshPath, 'live write');
  fs.writeFileSync(oldPath, 'leaked write');
  ageFile(oldPath);

  makeService(dir);

  assert.equal(fs.existsSync(freshPath), true);
  assert.equal(fs.existsSync(oldPath), false);
});

test('a persisted serve-path memo avoids Cellar probes after restart', async () => {
  const dir = makeCacheDir();
  const fmx4Uri = `${CELLAR_BASE}/oj/L_202401689.ENG.fmx4`;
  const downloadUri = `${CELLAR_BASE}/oj/L_202401689.ENG.fmx4.1.xml`;
  const firstFetch = prepareFetch({
    fmx4Uri,
    downloadUrls: [downloadUri],
    xml: '<?xml version="1.0"?><FMX><ARTICLE>1</ARTICLE></FMX>',
  });
  const firstService = makeService(dir);
  const first = await withMockFetch(firstFetch.fetchImpl, () => (
    firstService.prepareLawPayload('32024R1689', 'ENG')
  ));

  assert.equal(fs.existsSync(path.join(dir, 'fmx-paths-v1.json')), true);

  const secondService = makeService(dir);
  await withMockFetch(async () => {
    throw new Error('Cellar should not be queried for a valid memo hit');
  }, async () => {
    const second = await secondService.prepareLawPayload('32024R1689', 'ENG');
    assert.equal(second.servePath, first.servePath);
  });
});

test('an expired serve-path memo re-probes Cellar and refreshes a changed manifestation', async () => {
  const dir = makeCacheDir();
  const firstFmx4Uri = `${CELLAR_BASE}/oj/L_202401689.ENG.fmx4`;
  const firstDownloadUri = `${CELLAR_BASE}/oj/L_202401689.ENG.fmx4.1.xml`;
  const firstFetch = prepareFetch({
    fmx4Uri: firstFmx4Uri,
    downloadUrls: [firstDownloadUri],
    xml: '<?xml version="1.0"?><FMX><ARTICLE>old</ARTICLE></FMX>',
  });
  const firstService = makeService(dir);
  await withMockFetch(firstFetch.fetchImpl, () => (
    firstService.prepareLawPayload('32024R1689', 'ENG')
  ));

  const memoPath = path.join(dir, 'fmx-paths-v1.json');
  const memo = JSON.parse(fs.readFileSync(memoPath, 'utf8'));
  memo.entries['32024R1689\u0000ENG'].writtenAt = Date.now() - (7 * 60 * 60 * 1000);
  fs.writeFileSync(memoPath, JSON.stringify(memo));

  const refreshedFmx4Uri = `${CELLAR_BASE}/oj/L_202608260.ENG.fmx4`;
  const refreshedDownloadUri = `${CELLAR_BASE}/oj/L_202608260.ENG.fmx4.1.xml`;
  const secondFetch = prepareFetch({
    fmx4Uri: refreshedFmx4Uri,
    downloadUrls: [refreshedDownloadUri],
    xml: '<?xml version="1.0"?><FMX><ARTICLE>current</ARTICLE></FMX>',
  });
  const secondService = makeService(dir);
  const result = await withMockFetch(secondFetch.fetchImpl, () => (
    secondService.prepareLawPayload('32024R1689', 'ENG')
  ));

  assert.deepEqual(secondFetch.calls.map((call) => call.method), ['GET', 'GET', 'HEAD', 'GET']);
  assert.match(fs.readFileSync(result.servePath, 'utf8'), /current/);
  assert.equal(fs.existsSync(path.join(dir, path.basename(firstDownloadUri))), true);

  const refreshedMemo = JSON.parse(fs.readFileSync(memoPath, 'utf8'));
  assert.equal(refreshedMemo.entries['32024R1689\u0000ENG'].fmx4Uri, refreshedFmx4Uri);
  assert.equal(Number.isFinite(refreshedMemo.entries['32024R1689\u0000ENG'].writtenAt), true);
});

test('a legacy serve-path memo without manifestation URI or timestamp is not accepted', async () => {
  const dir = makeCacheDir();
  const fmx4Uri = `${CELLAR_BASE}/oj/L_202401689.ENG.fmx4`;
  const downloadUri = `${CELLAR_BASE}/oj/L_202401689.ENG.fmx4.1.xml`;
  const firstFetch = prepareFetch({
    fmx4Uri,
    downloadUrls: [downloadUri],
    xml: '<?xml version="1.0"?><FMX><ARTICLE>1</ARTICLE></FMX>',
  });
  const firstService = makeService(dir);
  await withMockFetch(firstFetch.fetchImpl, () => (
    firstService.prepareLawPayload('32024R1689', 'ENG')
  ));

  const memoPath = path.join(dir, 'fmx-paths-v1.json');
  const memo = JSON.parse(fs.readFileSync(memoPath, 'utf8'));
  delete memo.entries['32024R1689\u0000ENG'].fmx4Uri;
  delete memo.entries['32024R1689\u0000ENG'].writtenAt;
  fs.writeFileSync(memoPath, JSON.stringify(memo));

  const secondFetch = prepareFetch({
    fmx4Uri,
    downloadUrls: [downloadUri],
    xml: '<?xml version="1.0"?><FMX><ARTICLE>2</ARTICLE></FMX>',
  });
  const secondService = makeService(dir);
  await withMockFetch(secondFetch.fetchImpl, () => (
    secondService.prepareLawPayload('32024R1689', 'ENG')
  ));

  assert.deepEqual(secondFetch.calls.map((call) => call.method), ['GET', 'GET']);
});

test('the serve-path memo keeps languages separate', async () => {
  const dir = makeCacheDir();
  const service = makeService(dir);
  const english = prepareFetch({
    fmx4Uri: `${CELLAR_BASE}/oj/L_202401689.ENG.fmx4`,
    downloadUrls: [`${CELLAR_BASE}/oj/L_202401689.ENG.fmx4.1.xml`],
    xml: '<?xml version="1.0"?><FMX><ARTICLE>ENG</ARTICLE></FMX>',
  });
  await withMockFetch(english.fetchImpl, () => service.prepareLawPayload('32024R1689', 'ENG'));

  const german = prepareFetch({
    fmx4Uri: `${CELLAR_BASE}/oj/L_202401689.DEU.fmx4`,
    downloadUrls: [`${CELLAR_BASE}/oj/L_202401689.DEU.fmx4.1.xml`],
    xml: '<?xml version="1.0"?><FMX><ARTICLE>DEU</ARTICLE></FMX>',
  });
  const result = await withMockFetch(german.fetchImpl, () => (
    service.prepareLawPayload('32024R1689', 'DEU')
  ));

  assert.equal(german.calls.length, 4);
  assert.notEqual(result.servePath, path.join(dir, 'L_202401689.ENG.fmx4.1.xml'));
  assert.match(fs.readFileSync(result.servePath, 'utf8'), /DEU/);
});

for (const [label, invalidate] of [
  ['missing', (servePath) => fs.unlinkSync(servePath)],
  ['corrupt', (servePath) => fs.writeFileSync(servePath, '<?xml version="1.0"?><FMX><ARTICLE>1</ARTICLE>')],
]) {
  test(`a ${label} persisted memo entry falls through to a fresh probe`, async () => {
    const dir = makeCacheDir();
    const fmx4Uri = `${CELLAR_BASE}/oj/L_202401689.ENG.fmx4`;
    const downloadUri = `${CELLAR_BASE}/oj/L_202401689.ENG.fmx4.1.xml`;
    const firstFetch = prepareFetch({
      fmx4Uri,
      downloadUrls: [downloadUri],
      xml: '<?xml version="1.0"?><FMX><ARTICLE>1</ARTICLE></FMX>',
    });
    const firstService = makeService(dir);
    const first = await withMockFetch(firstFetch.fetchImpl, () => (
      firstService.prepareLawPayload('32024R1689', 'ENG')
    ));
    invalidate(first.servePath);

    const secondFetch = prepareFetch({
      fmx4Uri,
      downloadUrls: [downloadUri],
      xml: '<?xml version="1.0"?><FMX><ARTICLE>2</ARTICLE></FMX>',
    });
    const secondService = makeService(dir);
    const second = await withMockFetch(secondFetch.fetchImpl, () => (
      secondService.prepareLawPayload('32024R1689', 'ENG')
    ));

    assert.equal(secondFetch.calls.length, 4);
    assert.equal(fs.readFileSync(second.servePath, 'utf8'), '<?xml version="1.0"?><FMX><ARTICLE>2</ARTICLE></FMX>');
  });
}
