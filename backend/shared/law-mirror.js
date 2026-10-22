const fs = require('fs');
const path = require('path');

const {
  corpusPathForVariant,
  readCorpusXml,
  readCorpusHtml,
} = require('../search/law-corpus-store');

/**
 * Read-only access to a local copy of the English raw-law corpus (the
 * `laws.tar` and `laws-html.tar` assets of a `corpus-*` release), used as a
 * fallback when EUR-Lex or Cellar is unreachable (#246).
 *
 * The corpus uses the layout `search/law-corpus-store.js` writes:
 *   <dir>/laws/<year>/<CELEX>.xml.gz        combined FMX XML
 *   <dir>/laws-html/<year>/<CELEX>.html.gz  EUR-Lex HTML for FMX-less acts
 *
 * The mirror only holds the English text as published when the corpus release
 * was built, so callers must use it only after the live source has failed, and
 * never for any other language.
 */
const MIRROR_LANG = 'ENG';

function createLawMirror({ dir } = {}) {
  const enabled = Boolean(dir)
    && (fs.existsSync(path.join(dir, 'laws')) || fs.existsSync(path.join(dir, 'laws-html')));

  function has(celex, variant) {
    return enabled && fs.existsSync(corpusPathForVariant(dir, celex, variant));
  }

  return {
    enabled,
    dir: enabled ? dir : null,
    lang: MIRROR_LANG,
    hasFmx: (celex) => has(celex, 'xml'),
    hasHtml: (celex) => has(celex, 'html'),
    readFmx: (celex) => (enabled ? readCorpusXml(dir, celex) : Promise.resolve(null)),
    readHtml: (celex) => (enabled ? readCorpusHtml(dir, celex) : Promise.resolve(null)),
  };
}

// 4xx statuses that say "blocked or throttled", not "no such law": EUR-Lex
// answers a WAF block with 403 and rate limiting with 429.
const TRANSIENT_CLIENT_STATUSES = new Set([403, 408, 425, 429]);

/**
 * True when `err` means the upstream source could not be reached or answered
 * badly (network failure, timeout, 5xx, WAF block, rate limit), as opposed to
 * a definite answer such as "this CELEX does not exist". Definite answers are
 * raised as `ClientError`s with a 4xx status and must not be masked by the
 * mirror.
 */
function isUpstreamFailure(err) {
  if (!err) return false;
  const status = err.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return TRANSIENT_CLIENT_STATUSES.has(status);
  }
  return true;
}

module.exports = {
  createLawMirror,
  isUpstreamFailure,
  MIRROR_LANG,
};
