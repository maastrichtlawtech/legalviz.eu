// Enumerate the CJEU / General Court judgments that INTERPRET a legal act — the
// set the viewer surfaces as "cases citing this article" — and write their CELEX
// ids to a targets file for the case-law harvest.
//
// This is deliberately narrower than "every judgment": ~8.8k judgments carry a
// formal `cdm:case-law_interpretes_resource_legal` link, versus ~31k judgment
// CELEX ids overall. The rest (procedure, staff cases, competition orders) never
// produce an article citation for the app, so harvesting them adds hours and
// hundreds of MB for no viewer value.
//
// Paged SPARQL over CELLAR; low request count (~5 pages of 2000). The query is
// deterministic (DISTINCT + ORDER BY on the unique CELEX), so OFFSET paging is
// stable. Idempotent: rewrites the targets file each run.

const fs = require("fs");
const path = require("path");

const { runSparql } = require("./search-build.js");

const DEFAULT_TARGETS_PATH = path.join(__dirname, "data", "case-law-targets.txt");
const PAGE_SIZE = 2000;

function buildPageQuery(limit, offset) {
  return `
PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
SELECT DISTINCT ?c WHERE {
  ?w cdm:case-law_interpretes_resource_legal ?law .
  ?w cdm:resource_legal_id_celex ?c .
  FILTER(REGEX(STR(?c), "^6[0-9]{4}(CJ|TJ)[0-9]"))
}
ORDER BY ?c
LIMIT ${limit} OFFSET ${offset}`;
}

async function discoverCaseLawTargets({
  outPath = DEFAULT_TARGETS_PATH,
  pageSize = PAGE_SIZE,
  max = 0,
  runSparqlQuery = runSparql,
  log = (m) => console.log(`[case-law-discover] ${m}`),
} = {}) {
  const seen = new Set();
  for (let offset = 0; ; offset += pageSize) {
    const data = await runSparqlQuery(buildPageQuery(pageSize, offset));
    const rows = data.results?.bindings || [];
    for (const b of rows) {
      const celex = b.c?.value;
      if (celex) seen.add(celex);
    }
    log(`offset ${offset}: +${rows.length} rows (distinct total ${seen.size})`);
    if (rows.length < pageSize) break;
    if (max && seen.size >= max) break;
  }
  const ids = [...seen].sort();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${ids.join("\n")}\n`, "utf8");
  log(`wrote ${ids.length} judgment CELEX ids to ${outPath}`);
  return ids;
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith("--")) { options[key] = true; }
    else { options[key] = next; i += 1; }
  }
  await discoverCaseLawTargets({
    outPath: options.out || DEFAULT_TARGETS_PATH,
    pageSize: options.pageSize ? Number.parseInt(options.pageSize, 10) : PAGE_SIZE,
    max: options.max ? Number.parseInt(options.max, 10) : 0,
  });
}

if (require.main === module) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { discoverCaseLawTargets, buildPageQuery, DEFAULT_TARGETS_PATH };
