"use strict";

// In-force status enrichment: fetches cdm:resource_legal_in-force,
// cdm:resource_legal_date_end-of-validity, and cdm:resource_legal_eea for records
// that don't already carry them, and writes them onto the records as `inForce` /
// `endOfValidity` / `eea`, which is where the server reads them from
// (legal-cache-store.js).
//
// Runs as the last step of *both* cache builders, alongside the EuroVoc pass and
// for the same reason: status is CELEX-keyed, so a sidecar generated against one
// cache and served alongside another silently strands every record it never saw.
// See eurovoc-enrich.js for the full version of that story — it is the same
// failure mode, and it is invisible when it happens.
//
// data/in-force.json is a resume journal only — gitignored, never read at
// runtime.
//
// Modelling notes, because the vocabulary here is narrower than it looks:
//
//   * `in-force` is a plain boolean ("0"/"1"). Cellar exposes no predicate for
//     *why* an act is out of force, so `false` means only "no longer in force" —
//     it does NOT mean "repealed". Plenty of acts simply expire on their own
//     terms (31970R0729 ran out in 1999 and was never repealed by anything).
//     Do not let a UI label upgrade this field into a claim it can't support;
//     EUR-Lex itself says "No longer in force" for exactly this reason.
//   * `9999-12-31` is Cellar's sentinel for "no end of validity", not a real
//     date. It is normalised to null here so callers never render the year 9999.
//   * `entry-into-force` IS fetched, as `entryIntoForce`, but it took removing
//     the server-side aggregation to make that safe. It is multi-valued — the
//     GDPR carries both 2016-05-24 and 2018-05-25, and 32026R1818 carries ten
//     dates staged out to 2036 — so joining it fans an act into one row per
//     date. Under the old `GROUP BY` that was a coin flip between them; now the
//     rows come back raw and reduceBindings() takes the earliest, which is the
//     date the act enters into force. The later ones stage individual
//     provisions and are not a property of the act as a whole.
//   * Why it is worth the fan-out: `false` does not mean "no longer in force".
//     Acts are harvested when published, normally *before* entry into force, so
//     a new act reads `false` and flips to `true` later (see in-force-recheck).
//     Without an entry date there is no way to tell a regulation that takes
//     effect next week from one that expired in 1994, and the UI was labelling
//     the former "No longer in force". `date` is the adoption date and cannot
//     answer this.

const fs = require("fs");
const path = require("path");
const { parseInForceLiteral } = require("../shared/law-queries");

const SPARQL_ENDPOINT = "https://publications.europa.eu/webapi/rdf/sparql";
const USER_AGENT = "LegalViz API in-force fetcher/0.1";
const DEFAULT_JOURNAL_PATH = path.join(__dirname, "data", "in-force.json");
const BATCH_SIZE = 100;
const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 5;

// Cellar's "no end of validity" sentinel, not a date anyone should see.
const NO_END_OF_VALIDITY = "9999-12-31";

// Entry-into-force carries placeholders as well as sentinels: 32026D1296 comes
// back as 1001-01-01. Nothing in the corpus predates the ECSC, so a date before
// this is data, not history, and is dropped rather than rendered.
const EARLIEST_PLAUSIBLE_ENTRY = "1950-01-01";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt) {
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
}

function readJournal(journalPath) {
  try {
    if (!fs.existsSync(journalPath)) return {};
    const parsed = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // A corrupt journal is only a lost optimisation — re-fetching is correct,
    // just slower. Never fail a long build over it.
    return {};
  }
}

function writeJournal(journalPath, data) {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  const tempPath = `${journalPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 1));
  fs.renameSync(tempPath, journalPath);
}

function buildQuery(celexBatch) {
  // The ^^xsd:string typing on VALUES is load-bearing — see the long note in
  // eurovoc-enrich.js buildQuery(). Same endpoint, same join, same trap.
  //
  // Deliberately NOT aggregated. This query used to end in
  //
  //   SELECT ?celex (SAMPLE(?inForceValue) AS ?inForce) (MIN(?endValue) AS ?endOfValidity)
  //   ... GROUP BY ?celex
  //
  // which collapsed fan-out server-side, and mis-assigned values across groups
  // at batch scale. Reproduced against Cellar with a real 100-CELEX batch:
  // 32006R0988 genuinely carries end-of-validity 2020-12-31 and 32006R1066
  // carries the 9999-12-31 sentinel, yet the aggregated query returned
  // 2020-12-31 for *both*. Queried alone, or with this same batch unaggregated,
  // 32006R1066 correctly returns the sentinel. The wrong value is stable for a
  // given batch and changes when the batch composition changes, so it does not
  // look like a fluke and cannot be retried away — it silently writes another
  // act's expiry date onto a record.
  //
  // So: project the raw rows and collapse them in reduceBindings() below, where
  // the grouping is ours and deterministic. Both properties stay OPTIONAL so an
  // act with one but not the other still returns a row, and residual fan-out
  // (a handful of acts per batch) costs a few extra rows rather than a wrong
  // answer.
  const values = celexBatch.map((c) => `"${c}"^^xsd:string`).join(" ");
  return `
PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?celex ?inForceValue ?endValue ?entryValue ?eeaValue
WHERE {
  VALUES ?celex { ${values} }
  ?work cdm:resource_legal_id_celex ?celex .
  OPTIONAL { ?work cdm:resource_legal_in-force ?inForceValue }
  OPTIONAL { ?work cdm:resource_legal_date_end-of-validity ?endValue }
  OPTIONAL { ?work cdm:resource_legal_date_entry-into-force ?entryValue }
  OPTIONAL { ?work cdm:resource_legal_eea ?eeaValue }
}
`.trim();
}

// Collapses the unaggregated rows to one entry per CELEX — the job GROUP BY
// used to do, done where it can be trusted and unit-tested.
//
// `inForce` takes the first non-null value across the act's rows (it is
// single-valued in practice, so this is SAMPLE without the cross-group leak).
// `endOfValidity` takes the earliest real date, with the 9999-12-31 sentinel
// and unparseable values already filtered out by parseEndOfValidity — so an act
// whose only date is the sentinel correctly reduces to null rather than
// inheriting a neighbour's.
//
// `entryIntoForce` takes the earliest plausible date for the same reason it has
// to be reduced here at all: it is genuinely multi-valued, and the earliest is
// the one that answers "has this act entered into force yet". Later dates stage
// individual provisions — 32026R1818 carries ten, out to 2036 — and describe
// parts of the act rather than the act.
//
// `eea` is single-valued in practice, but is reduced the same way as `inForce`:
// the first non-null parsed value wins. Its internal null means Cellar returned
// no value; applyEntry converts that to the plain false boolean on the record.
function reduceBindings(bindings) {
  const byCelex = new Map();
  for (const binding of bindings || []) {
    const celex = binding.celex?.value;
    if (!celex) continue;

    let entry = byCelex.get(celex);
    if (!entry) {
      entry = { inForce: null, endOfValidity: null, entryIntoForce: null, eea: null };
      byCelex.set(celex, entry);
    }

    if (entry.inForce === null) {
      entry.inForce = parseInForceLiteral(binding.inForceValue?.value);
    }
    const end = parseEndOfValidity(binding.endValue?.value);
    if (end !== null && (entry.endOfValidity === null || end < entry.endOfValidity)) {
      entry.endOfValidity = end;
    }
    const start = parseEntryIntoForce(binding.entryValue?.value);
    if (start !== null && (entry.entryIntoForce === null || start < entry.entryIntoForce)) {
      entry.entryIntoForce = start;
    }
    const eea = parseInForceLiteral(binding.eeaValue?.value);
    if (entry.eea === null && eea !== null) {
      entry.eea = eea;
    }
  }
  return byCelex;
}

async function runQuery(query, log, attempt = 1) {
  const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&format=application%2Fsparql-results%2Bjson`;

  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/sparql-results+json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (attempt >= MAX_ATTEMPTS) throw new Error(`Request failed after ${attempt} attempts: ${error.message}`);
    const delay = backoffDelay(attempt);
    log(`${error.name === "TimeoutError" ? "timeout" : error.message}, retrying in ${delay}ms (attempt ${attempt})`);
    await sleep(delay);
    return runQuery(query, log, attempt + 1);
  }

  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) {
      if (attempt >= MAX_ATTEMPTS) throw new Error(`HTTP ${response.status} after ${attempt} attempts`);
      const delay = backoffDelay(attempt);
      log(`HTTP ${response.status}, retrying in ${delay}ms (attempt ${attempt})`);
      await sleep(delay);
      return runQuery(query, log, attempt + 1);
    }
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  return response.json();
}

function parseEndOfValidity(value) {
  const text = String(value ?? "").trim();
  if (!text || text.startsWith(NO_END_OF_VALIDITY)) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

// Same shape as parseEndOfValidity, plus a floor: the sentinel shows up here
// too, and so do placeholder years no act could have.
function parseEntryIntoForce(value) {
  const text = String(value ?? "").trim();
  if (!text || text.startsWith(NO_END_OF_VALIDITY)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  return text >= EARLIEST_PLAUSIBLE_ENTRY ? text : null;
}

// Mutates `records` in place, setting `inForce`, `endOfValidity`, `entryIntoForce`,
// and `eea` on every record that doesn't already have them. Records whose status
// is already known (from the journal, or carried over from a previous cache) cost
// nothing.
//
// Callers are builders, so failure policy mirrors eurovoc-enrich: the journal is
// flushed on the way out even when a batch throws, and the caller decides
// whether a SPARQL outage should fail the whole build or just ship without
// status.
// A journal entry from before entryIntoForce or eea existed is not wrong, just
// short, and re-fetching is the only way to fill it. Key presence rather than a
// null check: null is a real answer ("Cellar has no value") and must not be
// re-asked on every run.
function isCompleteEntry(journaled) {
  return Boolean(journaled)
    && typeof journaled === "object"
    && Object.prototype.hasOwnProperty.call(journaled, "entryIntoForce")
    && Object.prototype.hasOwnProperty.call(journaled, "eea");
}

async function enrichRecordsWithInForce(records, options = {}) {
  const {
    journalPath = DEFAULT_JOURNAL_PATH,
    saveEvery = 5,
    limit = 0,
    log = () => {},
    // The journal is a resume aid for builders, whose harvests run for hours
    // and must survive an interruption. A caller that writes its output once at
    // the end, all-or-nothing, has nothing to resume from and gains nothing but
    // a rewrite of a 30k-entry file every few batches — see
    // search/in-force-recheck.js, which passes false.
    useJournal = true,
    // Seam for tests: the SPARQL round-trip is the one part that can't be
    // exercised offline.
    runQueryFn = runQuery,
  } = options;

  const journal = useJournal ? readJournal(journalPath) : {};
  const saveJournal = () => {
    if (useJournal) writeJournal(journalPath, journal);
  };
  const stats = { targeted: 0, fromJournal: 0, fetched: 0, withStatus: 0, inForce: 0, alreadyPresent: 0 };

  const applyEntry = (record, entry) => {
    record.inForce = entry.inForce ?? null;
    record.endOfValidity = entry.endOfValidity ?? null;
    record.entryIntoForce = entry.entryIntoForce ?? null;
    record.eea = entry.eea === true;
    if (record.inForce !== null) {
      stats.withStatus += 1;
      if (record.inForce) stats.inForce += 1;
    }
  };

  const needsStatus = [];
  for (const record of records) {
    // All four fields, not just `inForce`: a record or journal entry written
    // before entryIntoForce or eea existed carries a partial answer, and
    // treating that as "already known" would leave the new field permanently
    // unfilled — it would only ever reach acts harvested after this change.
    if (record.inForce !== undefined
      && record.entryIntoForce !== undefined
      && record.eea !== undefined) {
      stats.alreadyPresent += 1;
      continue;
    }
    if (!record.celex) continue;
    stats.targeted += 1;

    const journaled = journal[record.celex];
    if (isCompleteEntry(journaled)) {
      applyEntry(record, journaled);
      stats.fromJournal += 1;
      continue;
    }
    needsStatus.push(record);
  }

  const targets = limit > 0 ? needsStatus.slice(0, limit) : needsStatus;
  log(`${stats.targeted} records need status — ${stats.fromJournal} from journal, ${targets.length} to fetch`);
  if (targets.length === 0) {
    return stats;
  }

  const byCelex = new Map(targets.map((record) => [record.celex, record]));
  let batches = 0;

  try {
    for (let offset = 0; offset < targets.length; offset += BATCH_SIZE) {
      const batch = targets.slice(offset, offset + BATCH_SIZE).map((record) => record.celex);
      const data = await runQueryFn(buildQuery(batch), log);

      const found = new Set();
      for (const [celex, entry] of reduceBindings(data?.results?.bindings)) {
        found.add(celex);
        journal[celex] = entry;
        const record = byCelex.get(celex);
        if (record) applyEntry(record, entry);
      }

      // An act Cellar has no status for is journaled as unknown so a rerun skips
      // it rather than re-asking for an answer it already gave. `null` is an
      // honest "we don't know", and the UI renders no badge for it.
      const unknown = { inForce: null, endOfValidity: null, entryIntoForce: null, eea: null };
      for (const celex of batch) {
        if (found.has(celex)) continue;
        journal[celex] = unknown;
        const record = byCelex.get(celex);
        if (record) applyEntry(record, unknown);
      }

      stats.fetched += batch.length;
      batches += 1;
      log(`batch ${batches} (${batch.length} records, ${found.size} with status) — ${Math.min(offset + batch.length, targets.length)}/${targets.length}`);

      if (batches % saveEvery === 0) saveJournal();
    }
  } finally {
    // Persist whatever the run gathered even if a batch threw, so the next
    // attempt resumes from here rather than from zero.
    saveJournal();
  }

  return stats;
}

module.exports = {
  DEFAULT_JOURNAL_PATH,
  EARLIEST_PLAUSIBLE_ENTRY,
  NO_END_OF_VALIDITY,
  buildQuery,
  enrichRecordsWithInForce,
  isCompleteEntry,
  parseEndOfValidity,
  parseEntryIntoForce,
  parseInForce: parseInForceLiteral,
  readJournal,
  reduceBindings,
};
