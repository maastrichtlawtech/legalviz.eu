const fs = require("fs");
const path = require("path");

const {
  DEFAULT_SEARCH_CACHE_PATH,
  extractOfficialTitleWithFallback
} = require("./search-build");

function parseArgs(argv) {
  const options = {
    cachePath: DEFAULT_SEARCH_CACHE_PATH,
    primaryActsOnly: true,
    onlyMissingTitles: true,
    limit: 0,
    saveEvery: 5,
    concurrency: 10,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }

  options.limit = Number.parseInt(String(options.limit || "0"), 10) || 0;
  options.saveEvery = Math.max(1, Number.parseInt(String(options.saveEvery || "5"), 10) || 5);
  options.concurrency = Math.max(1, Number.parseInt(String(options.concurrency || "10"), 10) || 10);
  options.primaryActsOnly = options.primaryActsOnly !== "false";
  options.onlyMissingTitles = options.onlyMissingTitles !== "false";
  return options;
}

function readCache(cachePath) {
  return JSON.parse(fs.readFileSync(cachePath, "utf8"));
}

function writeCache(cachePath, payload) {
  const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, cachePath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // The write may have failed before creating the temporary file.
    }
    throw error;
  }
}

function isEligible(record, options) {
  if (options.primaryActsOnly && !record.isPrimaryAct) return false;
  if (options.onlyMissingTitles && record.title) return false;
  return true;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const cachePath = path.resolve(options.cachePath);
  const payload = readCache(cachePath);
  const recordsByCelex = new Map(payload.records.map((record) => [record.celex, record]));
  const targets = payload.records.filter((record) => isEligible(record, options));
  const selected = options.limit > 0 ? targets.slice(0, options.limit) : targets;

  console.log(`[reenrich] cache=${cachePath}`);
  console.log(`[reenrich] eligible=${targets.length} selected=${selected.length} concurrency=${options.concurrency}`);

  let completed = 0;
  let updated = 0;
  let failed = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < selected.length) {
      const target = selected[cursor];
      cursor += 1;

      try {
        const result = await extractOfficialTitleWithFallback(target.celex);
        if (result.title) {
          const record = recordsByCelex.get(target.celex);
          if (record) {
            record.title = result.title;
            record.fmxAvailable = result.source === "fmx";
            record.fmxUnavailable = Boolean(result.fmxError)
              && String(result.fmxError.message || result.fmxError).includes("No FMX URI found");
            record.enrichError = result.source === "html"
              ? (result.fmxError?.message || null)
              : null;
          }
          updated += 1;
          completed += 1;
          console.log(`[ok ${completed}/${selected.length}] ${target.celex} [${result.source}] ${result.title}`);
        } else {
          failed += 1;
          completed += 1;
          console.log(`[miss ${completed}/${selected.length}] ${target.celex} no title`);
        }
      } catch (error) {
        failed += 1;
        completed += 1;
        console.log(`[fail ${completed}/${selected.length}] ${target.celex} ${error.message}`);
      }

      if (completed % options.saveEvery === 0) {
        writeCache(cachePath, payload);
        console.log(`[save] completed=${completed} updated=${updated} failed=${failed}`);
      }
    }
  }

  await Promise.all(Array.from({ length: options.concurrency }, () => worker()));

  writeCache(cachePath, payload);
  console.log(`[done] completed=${completed} updated=${updated} failed=${failed}`);
}

main().catch((error) => {
  console.error(`[fatal] ${error.message}`);
  process.exitCode = 1;
});
