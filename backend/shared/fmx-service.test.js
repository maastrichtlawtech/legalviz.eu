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

function makeService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmx-service-'));
  createdDirs.push(dir);
  return createFmxService({
    CELLAR_BASE,
    FMX_DIR: dir,
    STORAGE_LIMIT_MB: 100,
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
