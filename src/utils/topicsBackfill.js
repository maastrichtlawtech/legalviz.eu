import { fetchTopicsForCelexes, getAllLawMeta, upsertLawMeta } from "./formexApi.js";

const BACKFILL_VERSION_KEY = "legalviz-topics-backfill-version";
const CURRENT_BACKFILL_VERSION = "v1";
// The /api/topics endpoint caps each request at 200 CELEX ids.
const MAX_CELEX_PER_REQUEST = 200;

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function isVersionCurrent() {
  try {
    return window.localStorage.getItem(BACKFILL_VERSION_KEY) === CURRENT_BACKFILL_VERSION;
  } catch {
    return false;
  }
}

function markVersionCurrent() {
  try {
    window.localStorage.setItem(BACKFILL_VERSION_KEY, CURRENT_BACKFILL_VERSION);
  } catch {
    // ignore — a failure here just means the backfill retries next load.
  }
}

function dispatchLibraryUpdate() {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent("legalviz-library-updated"));
  } catch {
    // ignore
  }
}

/**
 * One-time, non-destructive backfill of EuroVoc topics onto library laws that
 * were opened before topics were persisted. Guarded by its own localStorage
 * version key (separate from the reset migration in resetApp.js) so it runs at
 * most once per client. Writes merge into existing meta records via
 * upsertLawMeta — nothing is wiped.
 *
 * Returns true if it wrote any topics, false otherwise.
 */
export async function runOneTimeTopicsBackfill() {
  if (typeof window === "undefined") return false;
  if (isVersionCurrent()) return false;

  let metaEntries;
  try {
    metaEntries = await getAllLawMeta();
  } catch {
    // Can't read the library — retry on a later load rather than mark done.
    return false;
  }

  // Only laws that lack topics need backfilling; ones saved from search already
  // carry them.
  const celexesNeedingTopics = metaEntries
    .filter((entry) => entry?.celex && !(Array.isArray(entry.topics) && entry.topics.length > 0))
    .map((entry) => entry.celex);

  if (celexesNeedingTopics.length === 0) {
    // Nothing to do now — treat the backfill as complete.
    markVersionCurrent();
    return false;
  }

  let wroteAny = false;
  try {
    for (const batch of chunk(celexesNeedingTopics, MAX_CELEX_PER_REQUEST)) {
      const topicsByCelex = await fetchTopicsForCelexes(batch);
      for (const [celex, topics] of Object.entries(topicsByCelex)) {
        if (!Array.isArray(topics) || topics.length === 0) continue;
        await upsertLawMeta(celex, { topics });
        wroteAny = true;
      }
    }
  } catch {
    // Network / cache-unavailable error: don't mark done, so it retries later.
    // Any topics already written this run stay — upsertLawMeta merges.
    if (wroteAny) dispatchLibraryUpdate();
    return wroteAny;
  }

  markVersionCurrent();
  if (wroteAny) dispatchLibraryUpdate();
  return wroteAny;
}
