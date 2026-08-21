"use strict";

// In-force status enrichment: fetches cdm:resource_legal_in-force and
// cdm:resource_legal_date_end-of-validity for records that don't already carry
// them, and writes them onto the records as `inForce` / `endOfValidity`, which
// is where the server reads them from (legal-cache-store.js).
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
//   * `entry-into-force` is deliberately NOT fetched: it is multi-valued (the
//     GDPR carries both 2016-05-24 and 2018-05-25), so joining it fans every act
//     out into duplicate rows. The aggregate below would hide that, but the
//     field would still be a coin flip between the two. `date` already covers
//     the adoption date the UI shows.

const fs = require("fs");
const path = require("path");

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
SELECT ?celex ?inForceValue ?endValue
WHERE {
  VALUES ?celex { ${values} }
  ?work cdm:resource_legal_id_celex ?celex .
  OPTIONAL { ?work cdm:resource_legal_in-force ?inForceValue }
  OPTIONAL { ?work cdm:resource_legal_date_end-of-validity ?endValue }
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
function reduceBindings(bindings) {
  const byCelex = new Map();
  for (const binding of bindings || []) {
    const celex = binding.celex?.value;
    if (!celex) continue;

    let entry = byCelex.get(celex);
    if (!entry) {
      entry = { inForce: null, endOfValidity: null };
      byCelex.set(celex, entry);
    }

    if (entry.inForce === null) {
      entry.inForce = parseInForce(binding.inForceValue?.value);
    }
    const end = parseEndOfValidity(binding.endValue?.value);
    if (end !== null && (entry.endOfValidity === null || end < entry.endOfValidity)) {
      entry.endOfValidity = end;
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

// Cellar returns the boolean as the literal "1"/"0". Anything else is a shape
// change upstream, and guessing would be worse than admitting we don't know.
function parseInForce(value) {
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return null;
}

function parseEndOfValidity(value) {
  const text = String(value ?? "").trim();
  if (!text || text.startsWith(NO_END_OF_VALIDITY)) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

// Mutates `records` in place, setting `inForce` and `endOfValidity` on every
// record that doesn't already have them. Records whose status is already known
// (from the journal, or carried over from a previous cache) cost nothing.
//
// Callers are builders, so failure policy mirrors eurovoc-enrich: the journal is
// flushed on the way out even when a batch throws, and the caller decides
// whether a SPARQL outage should fail the whole build or just ship without
// status.
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
    if (record.inForce !== null) {
      stats.withStatus += 1;
      if (record.inForce) stats.inForce += 1;
    }
  };

  const needsStatus = [];
  for (const record of records) {
    if (record.inForce !== undefined) {
      stats.alreadyPresent += 1;
      continue;
    }
    if (!record.celex) continue;
    stats.targeted += 1;

    const journaled = journal[record.celex];
    if (journaled && typeof journaled === "object") {
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
      const unknown = { inForce: null, endOfValidity: null };
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
  NO_END_OF_VALIDITY,
  buildQuery,
  enrichRecordsWithInForce,
  parseEndOfValidity,
  parseInForce,
  readJournal,
  reduceBindings,
};
