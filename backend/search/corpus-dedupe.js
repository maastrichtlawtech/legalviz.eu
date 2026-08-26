// One-time repair pass for the raw FMX corpus: drop the duplicate act blocks
// that the harvest wrote before `findDownloadUrls` in search-build.js learned
// to deduplicate Cellar's manifestation URIs (issue #219).
//
// Cellar lists one physical `.fmx4.<lang>.xml` under several manifestation URIs
// (one per production system that minted an id for the act). The build copy of
// `findDownloadUrls` handed all of them back, `fetchCombinedFmxXml` fetched each
// and joined the results with "\n", and `writeCorpusXml` stored the act two or
// three times over in one file. 24,132 of 28,009 files (86.2%) carry more than
// one copy; three copies is the mode.
//
// Fixing the harvest does not fix the corpus: enrichment is corpus-first
// (`extractOfficialTitleAndExcerpt` reads the local file and only fetches on a
// miss), so every one of those files is read from disk and never refetched.
// This module is the sweep that avoids re-scraping 28,009 acts.
//
// WHAT IT IS NOT. Exact-block dedupe is a floor in principle, not a proof:
// Cellar can list the same act under two manifestations that differ in
// incidental markup, and no comparison of whole blocks catches that.
// `32016D0298` is exactly that shape — four ACT blocks, two of 8,412 bytes and
// two of 8,157 — so the repair leaves two of them and its recitals still parse
// twice. What makes that acceptable is that it is not a *repair* shortfall:
// `fmx-service.js` deduplicates on the same key and production
// `/api/laws/32016D0298/parsed` returns the same doubled recitals, so the
// repaired corpus agrees with what readers already see. It was the only act
// left with a repeated recital in a 250-act spread where 209 of the 250 had
// one before, and the repaired parse matched production field-for-field on
// every act checked. Only a re-harvest through the fixed `findDownloadUrls`
// verifies against Cellar itself; this recovers nearly all of it without
// re-scraping 28,009 acts.
//
// SAFETY. Multiple top-level blocks are legitimate in their own right: modern
// Formex ships an `<OJ>`/`<PUBLICATION>` wrapper *plus* a separate `<ACT>`
// document (the reason `wrapForParsing` exists at all), and 61 files are rooted
// at `GENERAL` or `ANNEX` rather than `ACT`. So this never assumes a root name
// and never drops a block that differs from the ones before it. Anything it
// cannot split with certainty — unbalanced tags, stray text between blocks — it
// leaves on disk untouched and reports.

const fs = require("fs");
const path = require("path");

const { listCorpusFiles } = require("./corpus-files");
const { readCorpusXml, writeCorpusXml } = require("./law-corpus-store");

const CORPUS_SUBDIR = "laws";
const CORPUS_EXTENSION = ".xml.gz";
const DEFAULT_JOURNAL_NAME = "corpus-dedupe-progress.json";
const JOURNAL_SCHEMA_VERSION = 1;
const JOURNAL_FLUSH_EVERY = 500;

// Finds the `>` that closes the tag opening at `start`, skipping any `>` that
// sits inside a quoted attribute value. Returns -1 when the tag never closes.
function findTagEnd(text, start) {
  let quote = null;
  for (let i = start + 1; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return i;
  }
  return -1;
}

/**
 * Splits a corpus blob into its top-level elements.
 *
 * Returns `null` — meaning "refuse to touch this file" — whenever the document
 * is anything other than a clean sequence of balanced top-level elements
 * separated by whitespace. That covers unbalanced tags, a stray closing tag,
 * and non-whitespace text outside any element. The repair treats a null as a
 * skip rather than guessing at the boundaries of an act.
 *
 * Formex uses processing instructions inline (`<?PAGE NO="2"?>`, `<?COL.PAGE?>`)
 * and the harvest strips only the first XML declaration per part, so PIs,
 * comments, CDATA and declarations are all skipped rather than counted as
 * elements.
 */
function splitTopLevelBlocks(xml) {
  const text = String(xml || "");
  const blocks = [];
  let depth = 0;
  let blockStart = -1;
  let cursor = 0;
  let index = 0;

  while (index < text.length) {
    const open = text.indexOf("<", index);
    if (open === -1) break;

    // Anything between the previous markup and this `<` is character data.
    // Inside an element that is the act's own text; at the top level it is
    // content we have no block to attach it to, so we decline the whole file.
    if (depth === 0 && text.slice(cursor, open).trim()) return null;

    const marker = text[open + 1];

    if (marker === "?") {
      const end = text.indexOf("?>", open + 2);
      if (end === -1) return null;
      index = end + 2;
      cursor = index;
      continue;
    }

    if (marker === "!") {
      if (text.startsWith("<!--", open)) {
        const end = text.indexOf("-->", open + 4);
        if (end === -1) return null;
        index = end + 3;
      } else if (text.startsWith("<![CDATA[", open)) {
        const end = text.indexOf("]]>", open + 9);
        if (end === -1) return null;
        index = end + 3;
      } else {
        const end = findTagEnd(text, open);
        if (end === -1) return null;
        index = end + 1;
      }
      cursor = index;
      continue;
    }

    const tagEnd = findTagEnd(text, open);
    if (tagEnd === -1) return null;
    const tag = text.slice(open, tagEnd + 1);
    index = tagEnd + 1;
    cursor = index;

    if (marker === "/") {
      depth -= 1;
      if (depth < 0) return null;
      if (depth === 0) {
        blocks.push({
          name: tag.slice(2, tagEnd - open).trim().replace(/[\s/>].*$/s, ""),
          text: text.slice(blockStart, tagEnd + 1).trim(),
        });
        blockStart = -1;
      }
      continue;
    }

    const name = tag.slice(1).trim().replace(/[\s/>].*$/s, "");
    if (!name) return null;

    if (/\/\s*>$/.test(tag)) {
      // Self-closing. At the top level it is a block of its own; nested it
      // changes nothing.
      if (depth === 0) blocks.push({ name, text: tag.trim() });
      continue;
    }

    if (depth === 0) blockStart = open;
    depth += 1;
  }

  if (depth !== 0) return null;
  if (text.slice(cursor).trim()) return null;
  return blocks;
}

/**
 * Removes byte-identical repeats of a top-level block, keeping the first
 * occurrence of each and the original order.
 *
 * Blocks are compared after trimming: the harvest trimmed each fetched part and
 * joined them with "\n", so the repeats differ only in trailing whitespace.
 * Distinct blocks are all kept — a `<PUBLICATION>` wrapper followed by its
 * `<ACT>`, or an act split across several data files, is not a defect.
 *
 * Returns `{ xml, blocks, unique, changed, skipped }`. `skipped` is true when
 * the document could not be split safely, in which case `xml` is the input
 * unchanged and `changed` is false.
 */
function dedupeXmlBlocks(xml) {
  const text = String(xml || "");
  const blocks = splitTopLevelBlocks(text);
  if (!blocks) return { xml: text, blocks: 0, unique: 0, changed: false, skipped: true };

  const seen = new Set();
  const kept = [];
  for (const block of blocks) {
    if (seen.has(block.text)) continue;
    seen.add(block.text);
    kept.push(block.text);
  }

  if (kept.length === blocks.length) {
    return { xml: text, blocks: blocks.length, unique: kept.length, changed: false, skipped: false };
  }

  // Rejoin exactly the way `fetchCombinedFmxXml` and `extractXmlFromZip` do, so
  // a repaired file is byte-identical to what the fixed harvest would write.
  return { xml: kept.join("\n"), blocks: blocks.length, unique: kept.length, changed: true, skipped: false };
}

function journalPathFor(dataDir, journalPath) {
  return journalPath || path.join(dataDir, DEFAULT_JOURNAL_NAME);
}

// The journal is a resume cursor, not a correctness mechanism: the repair is
// idempotent (deduping already-unique blocks is a no-op), so a lost or deleted
// journal costs a re-scan and nothing else.
function readJournal(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed?.schemaVersion !== JOURNAL_SCHEMA_VERSION) return new Set();
    return new Set(Array.isArray(parsed.done) ? parsed.done : []);
  } catch {
    return new Set();
  }
}

function writeJournal(file, done) {
  const payload = { schemaVersion: JOURNAL_SCHEMA_VERSION, done: [...done].sort() };
  const tempPath = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tempPath, `${JSON.stringify(payload)}\n`);
  fs.renameSync(tempPath, file);
}

/**
 * Repairs one act in place. Reads and writes through law-corpus-store, so the
 * write is atomic (temp file + rename) and an interrupted run never leaves a
 * truncated law behind.
 */
async function repairCorpusAct(dataDir, celex, { dryRun = false } = {}) {
  const xml = await readCorpusXml(dataDir, celex);
  if (!xml) return { celex, status: "unreadable" };

  const result = dedupeXmlBlocks(xml);
  if (result.skipped) return { celex, status: "unsplittable", blocks: result.blocks };
  if (!result.changed) return { celex, status: "clean", blocks: result.blocks, unique: result.unique };

  if (!dryRun) await writeCorpusXml(dataDir, celex, result.xml);
  return {
    celex,
    status: "repaired",
    blocks: result.blocks,
    unique: result.unique,
    removed: result.blocks - result.unique,
    bytesBefore: Buffer.byteLength(xml, "utf8"),
    bytesAfter: Buffer.byteLength(result.xml, "utf8"),
  };
}

/**
 * Sweeps the whole FMX corpus. Resumable via the journal, and idempotent with
 * or without one.
 *
 * The walk goes through `listCorpusFiles` and nothing else: the corpus trees
 * carry AppleDouble sidecars (`._<CELEX>.xml.gz`) that are Finder metadata, not
 * gzip streams, and filtering on extension alone would feed them to gunzip.
 */
async function repairCorpus({
  dataDir,
  limit,
  dryRun = false,
  resume = true,
  journalPath,
  log = () => {},
} = {}) {
  const root = path.join(dataDir, CORPUS_SUBDIR);
  const files = listCorpusFiles({ root, extension: CORPUS_EXTENSION });
  const journal = journalPathFor(dataDir, journalPath);
  const done = resume && !dryRun ? readJournal(journal) : new Set();

  const stats = {
    total: files.length,
    scanned: 0,
    skipped: 0,
    clean: 0,
    repaired: 0,
    unreadable: 0,
    unsplittable: 0,
    blocksRemoved: 0,
    bytesSaved: 0,
  };
  const unsplittable = [];
  let sinceFlush = 0;

  for (const entry of files) {
    if (Number.isFinite(limit) && stats.scanned >= limit) break;
    if (done.has(entry.celex)) {
      stats.skipped += 1;
      continue;
    }

    stats.scanned += 1;
    const result = await repairCorpusAct(dataDir, entry.celex, { dryRun });

    if (result.status === "repaired") {
      stats.repaired += 1;
      stats.blocksRemoved += result.removed;
      stats.bytesSaved += result.bytesBefore - result.bytesAfter;
    } else if (result.status === "clean") {
      stats.clean += 1;
    } else if (result.status === "unreadable") {
      stats.unreadable += 1;
    } else {
      stats.unsplittable += 1;
      if (unsplittable.length < 100) unsplittable.push(entry.celex);
    }

    // Journal only after the atomic rename has landed, so a crash between the
    // two re-does the act rather than skipping a still-duplicated file.
    done.add(entry.celex);
    sinceFlush += 1;
    if (!dryRun && resume && sinceFlush >= JOURNAL_FLUSH_EVERY) {
      writeJournal(journal, done);
      sinceFlush = 0;
      log(`${stats.scanned}/${files.length} scanned · ${stats.repaired} repaired · ${stats.clean} already clean`);
    }
  }

  if (!dryRun && resume) writeJournal(journal, done);
  return { ...stats, unsplittableCelex: unsplittable, journalPath: journal };
}

async function main() {
  const args = process.argv.slice(2);
  const readValue = (flag) => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  const dataDir = readValue("--data-dir") || path.join(__dirname, "data");
  const limitRaw = readValue("--limit");
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  const dryRun = args.includes("--dry-run");
  const resume = !args.includes("--no-resume");

  if (limitRaw !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error(`--limit must be a positive number, got ${limitRaw}`);
  }
  if (!fs.existsSync(path.join(dataDir, CORPUS_SUBDIR))) {
    throw new Error(`No FMX corpus at ${path.join(dataDir, CORPUS_SUBDIR)}`);
  }

  console.log(`[corpus-dedupe] ${dryRun ? "dry run over" : "repairing"} ${dataDir}`);
  const stats = await repairCorpus({
    dataDir,
    limit,
    dryRun,
    resume,
    log: (message) => console.log(`[corpus-dedupe] ${message}`),
  });

  console.log(
    `[corpus-dedupe] ${stats.scanned} scanned (${stats.skipped} already journalled of ${stats.total} on disk)`,
  );
  console.log(
    `[corpus-dedupe] ${stats.repaired} repaired · ${stats.clean} already clean`
    + ` · ${stats.unsplittable} left alone (unsplittable) · ${stats.unreadable} unreadable`,
  );
  console.log(
    `[corpus-dedupe] removed ${stats.blocksRemoved} duplicate blocks,`
    + ` ${(stats.bytesSaved / 1024 / 1024).toFixed(1)} MB of uncompressed XML`,
  );
  if (stats.unsplittableCelex.length) {
    console.log(`[corpus-dedupe] unsplittable sample: ${stats.unsplittableCelex.slice(0, 10).join(", ")}`);
  }
  console.log(
    "[corpus-dedupe] exact-block dedupe is a floor: some acts repeat under blocks that are not"
    + " byte-identical, and only a re-harvest through the fixed findDownloadUrls clears those.",
  );
  console.log("[corpus-dedupe] next: rebuild the full-text index and the derived caches from the repaired corpus.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error("[corpus-dedupe] fatal:", error.message);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_JOURNAL_NAME,
  JOURNAL_SCHEMA_VERSION,
  dedupeXmlBlocks,
  readJournal,
  repairCorpus,
  repairCorpusAct,
  splitTopLevelBlocks,
};
