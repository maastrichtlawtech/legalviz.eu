#!/usr/bin/env node

/**
 * eurlex — CLI for downloading, parsing, and searching EU legislation.
 *
 * Wraps the same services used by the backend server so everything
 * works locally without running the API.
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Shared bootstrap (services, parser, search index)
// ---------------------------------------------------------------------------

const DEFAULT_FMX_DIR = process.env.CACHE_DIR || process.env.FMX_DIR || path.join(__dirname, '..', 'law-cache');
const CELLAR_BASE = 'https://publications.europa.eu/resource';
const EURLEX_BASE = 'https://eur-lex.europa.eu';
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS) || 30_000;
const STORAGE_LIMIT_MB = parseInt(process.env.STORAGE_LIMIT_MB) || 500;
const RESOLUTION_CACHE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RECITAL_TITLE_MODEL = process.env.RECITAL_TITLE_MODEL || process.env.ARTICLE_QA_PLANNER_MODEL || process.env.ARTICLE_QA_MODEL || 'google/gemini-2.5-pro';

function getRecitalTitleApiKey() {
  return process.env.RECITAL_TITLE_OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY;
}

function bootServices() {
  const { JsonLegalCacheStore, DEFAULT_SEARCH_CACHE_PATH } = require('../search/search-index');
  const {
    cacheGet,
    cacheSet,
    toSearchLang,
    validateLang,
  } = require('../shared/api-utils');
  const {
    createReferenceResolver,
    parseReferenceText,
    parseStructuredReference,
    validateCelex,
  } = require('../shared/reference-utils');

  if (!fs.existsSync(DEFAULT_FMX_DIR)) {
    fs.mkdirSync(DEFAULT_FMX_DIR, { recursive: true });
  }

  const resolutionCache = new Map();
  const legalCacheStore = new JsonLegalCacheStore(process.env.SEARCH_CACHE_PATH || DEFAULT_SEARCH_CACHE_PATH);
  legalCacheStore.load();
  const refResolver = createReferenceResolver({
    EURLEX_BASE,
    RESOLUTION_CACHE_MS,
    TIMEOUT_MS,
    cacheGet,
    cacheSet,
    legalCacheStore,
    resolutionCache,
    toSearchLang,
  });

  // Lazy-load FMX service (requires adm-zip) — only needed by fetch/get commands
  let _fmxService;
  function getFmxService() {
    if (!_fmxService) {
      const { createFmxService } = require('../shared/fmx-service');
      _fmxService = createFmxService({
        CELLAR_BASE,
        FMX_DIR: DEFAULT_FMX_DIR,
        STORAGE_LIMIT_MB,
        TIMEOUT_MS,
      });
    }
    return _fmxService;
  }

  return {
    get prepareLawPayload() { return getFmxService().prepareLawPayload; },
    get findFmx4Uri() { return getFmxService().findFmx4Uri; },
    get findDownloadUrls() { return getFmxService().findDownloadUrls; },
    get sendLawResponse() { return getFmxService().sendLawResponse; },
    ...refResolver,
    parseReferenceText,
    parseStructuredReference,
    validateCelex,
    validateLang,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonOut(data, outputPath) {
  const json = JSON.stringify(data, null, 2);
  if (outputPath) {
    fs.writeFileSync(path.resolve(outputPath), json, 'utf8');
    process.stderr.write(`Written to ${outputPath}\n`);
  } else {
    process.stdout.write(json + '\n');
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function die(message) {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

function parseFlags(args, positionalNames = []) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') { positional.push(...args.slice(i + 1)); break; }
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        flags[key] = args[++i];
      } else {
        flags[key] = true;
      }
    } else if (args[i].startsWith('-') && args[i].length === 2) {
      const key = args[i].slice(1);
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        flags[key] = args[++i];
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(args[i]);
    }
  }
  for (let j = 0; j < positionalNames.length; j++) {
    if (positional[j] !== undefined) flags[positionalNames[j]] = positional[j];
  }
  return flags;
}

async function parseLawByCelex(svc, celex, lang) {
  const { parseFmxXml } = require('../shared/fmx-parser-node');
  const { servePath } = await svc.prepareLawPayload(celex, lang);
  const xmlText = fs.readFileSync(servePath, 'utf8');
  const parsed = await parseFmxXml(xmlText);
  return { celex, lang, ...parsed };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const COMMANDS = {};

// --- fetch -----------------------------------------------------------------

COMMANDS.fetch = {
  summary: 'Download raw Formex XML for a law by CELEX number',
  usage: 'eurlex fetch <celex> [--lang ENG] [-o output.xml]',
  async run(args) {
    const flags = parseFlags(args, ['celex']);
    if (!flags.celex) die('CELEX number required.  Usage: eurlex fetch <celex>');
    const svc = bootServices();
    if (!svc.validateCelex(flags.celex)) die(`Invalid CELEX format: ${flags.celex}`);
    const lang = svc.validateLang(flags.lang || 'ENG');
    if (!lang) die(`Invalid language code: ${flags.lang}`);

    const { servePath } = await svc.prepareLawPayload(flags.celex, lang);
    const xml = fs.readFileSync(servePath, 'utf8');

    if (flags.o || flags.output) {
      const dest = flags.o || flags.output;
      fs.writeFileSync(path.resolve(dest), xml, 'utf8');
      process.stderr.write(`Written to ${dest}\n`);
    } else {
      process.stdout.write(xml);
    }
  },
};

// --- parse -----------------------------------------------------------------

COMMANDS.parse = {
  summary: 'Parse a local Formex XML file to structured JSON',
  usage: 'eurlex parse <input.xml> [-o output.json]\n         cat input.xml | eurlex parse',
  async run(args) {
    const flags = parseFlags(args, ['input']);
    const { parseFmxXml } = require('../shared/fmx-parser-node');

    let xmlText;
    if (flags.input) {
      const resolved = path.resolve(flags.input);
      if (!fs.existsSync(resolved)) die(`File not found: ${resolved}`);
      xmlText = fs.readFileSync(resolved, 'utf8');
    } else if (!process.stdin.isTTY) {
      xmlText = await readStdin();
    } else {
      die('No input. Pass a file path or pipe XML via stdin.');
    }

    const result = await parseFmxXml(xmlText);
    jsonOut(result, flags.o || flags.output);
  },
};

// --- get (fetch + parse) ---------------------------------------------------

COMMANDS.get = {
  summary: 'Download a law by CELEX and output parsed JSON',
  usage: 'eurlex get <celex> [--lang ENG] [-o output.json]',
  async run(args) {
    const flags = parseFlags(args, ['celex']);
    if (!flags.celex) die('CELEX number required.  Usage: eurlex get <celex>');
    const svc = bootServices();
    if (!svc.validateCelex(flags.celex)) die(`Invalid CELEX format: ${flags.celex}`);
    const lang = svc.validateLang(flags.lang || 'ENG');
    if (!lang) die(`Invalid language code: ${flags.lang}`);

    const parsed = await parseLawByCelex(svc, flags.celex, lang);
    jsonOut(parsed, flags.o || flags.output);
  },
};

// --- recital-titles --------------------------------------------------------

COMMANDS['recital-titles'] = {
  summary: 'Generate or read cached AI titles for a law\'s recitals',
  usage: 'eurlex recital-titles <celex> [--lang ENG] [-o output.json]',
  async run(args) {
    const flags = parseFlags(args, ['celex']);
    if (!flags.celex) die('CELEX number required.  Usage: eurlex recital-titles <celex>');
    const svc = bootServices();
    if (!svc.validateCelex(flags.celex)) die(`Invalid CELEX format: ${flags.celex}`);
    const lang = svc.validateLang(flags.lang || 'ENG');
    if (!lang) die(`Invalid language code: ${flags.lang}`);
    const apiKey = getRecitalTitleApiKey();
    if (!apiKey) die('RECITAL_TITLE_OPENROUTER_API_KEY or OPENROUTER_API_KEY is required for recital-titles.');

    const { ensureRecitalTitles } = require('../shared/recital-title-service');
    const parsed = await parseLawByCelex(svc, flags.celex, lang);
    const result = await ensureRecitalTitles({
      celex: flags.celex,
      lang,
      recitals: parsed.recitals || [],
      cacheDir: DEFAULT_FMX_DIR,
      apiKey,
      model: flags.model || DEFAULT_RECITAL_TITLE_MODEL,
    });

    jsonOut({
      celex: flags.celex,
      lang,
      model: result.model,
      cached: result.cached,
      titles: result.titles,
    }, flags.o || flags.output);
  },
};

// --- metadata --------------------------------------------------------------

COMMANDS.metadata = {
  summary: 'Fetch SPARQL metadata for a law (entry into force, ELI, etc.)',
  usage: 'eurlex metadata <celex> [-o output.json]',
  async run(args) {
    const flags = parseFlags(args, ['celex']);
    if (!flags.celex) die('CELEX number required.');
    const svc = bootServices();
    if (!svc.validateCelex(flags.celex)) die(`Invalid CELEX: ${flags.celex}`);

    const { fetchMetadata } = require('../shared/law-queries');
    const payload = await fetchMetadata(flags.celex, svc.runSparqlQuery);
    jsonOut(payload, flags.o || flags.output);
  },
};

// --- amendments ------------------------------------------------------------

COMMANDS.amendments = {
  summary: 'List amendments and corrigenda for a law',
  usage: 'eurlex amendments <celex> [-o output.json]',
  async run(args) {
    const flags = parseFlags(args, ['celex']);
    if (!flags.celex) die('CELEX number required.');
    const svc = bootServices();
    if (!svc.validateCelex(flags.celex)) die(`Invalid CELEX: ${flags.celex}`);

    const { fetchAmendments } = require('../shared/law-queries');
    const payload = await fetchAmendments(flags.celex, svc.runSparqlQuery);
    jsonOut(payload, flags.o || flags.output);
  },
};

// --- implementing ----------------------------------------------------------

COMMANDS.implementing = {
  summary: 'List implementing/delegated acts for a law',
  usage: 'eurlex implementing <celex> [-o output.json]',
  async run(args) {
    const flags = parseFlags(args, ['celex']);
    if (!flags.celex) die('CELEX number required.');
    const svc = bootServices();
    if (!svc.validateCelex(flags.celex)) die(`Invalid CELEX: ${flags.celex}`);

    const { fetchImplementing } = require('../shared/law-queries');
    const payload = await fetchImplementing(flags.celex, svc.runSparqlQuery);
    jsonOut(payload, flags.o || flags.output);
  },
};

// --- case-law --------------------------------------------------------------

COMMANDS['case-law'] = {
  summary: 'List CJEU judgments that interpret a law',
  usage: 'eurlex case-law <celex> [-o output.json]',
  async run(args) {
    const flags = parseFlags(args, ['celex']);
    if (!flags.celex) die('CELEX number required.');
    const svc = bootServices();
    if (!svc.validateCelex(flags.celex)) die(`Invalid CELEX: ${flags.celex}`);

    const { fetchCaseLaw } = require('../shared/law-queries');
    const payload = await fetchCaseLaw(flags.celex, svc.runSparqlQuery, { cacheDir: DEFAULT_FMX_DIR });
    jsonOut(payload, flags.o || flags.output);
  },
};

// --- search ----------------------------------------------------------------

COMMANDS.search = {
  summary: 'Search the local law metadata cache',
  usage: 'eurlex search <query> [--limit 10] [-o output.json]',
  async run(args) {
    const flags = parseFlags(args, ['query']);
    if (!flags.query) die('Search query required.  Usage: eurlex search <query>');

    const { JsonLegalCacheStore, DEFAULT_SEARCH_CACHE_PATH } = require('../search/search-index');
    const legalCacheStore = new JsonLegalCacheStore(process.env.SEARCH_CACHE_PATH || DEFAULT_SEARCH_CACHE_PATH);
    if (!legalCacheStore.load()) {
      die(`Search cache not available: ${legalCacheStore.loadError}\nRun "npm run build:search-cache" in backend/ first.`);
    }

    const results = legalCacheStore.searchLaws(flags.query, {
      limit: flags.limit,
    });

    jsonOut({ query: flags.query, count: results.length, results }, flags.o || flags.output);
  },
};

// --- resolve ---------------------------------------------------------------

COMMANDS.resolve = {
  summary: 'Resolve a legal reference to a CELEX number',
  usage: 'eurlex resolve <text>                  e.g. "Regulation 2016/679"\n         eurlex resolve --actType regulation --year 2016 --number 679',
  async run(args) {
    const flags = parseFlags(args, ['text']);
    const svc = bootServices();
    const lang = svc.validateLang(flags.lang || 'ENG') || 'ENG';

    let reference;
    if (flags.actType || flags.year || flags.number) {
      reference = svc.parseStructuredReference(flags);
    } else if (flags.text) {
      reference = svc.parseReferenceText(flags.text);
    } else {
      die('Provide reference text or --actType/--year/--number flags.');
    }

    if (!reference.year || !reference.number) {
      die(`Could not parse reference: ${JSON.stringify(reference)}`);
    }

    const resolution = await svc.resolveReference(reference, lang);
    jsonOut({
      query: reference.raw || null,
      parsed: reference,
      resolved: resolution.resolved,
      tried: resolution.tried,
      fallback: resolution.fallback,
    }, flags.o || flags.output);
  },
};

// --- resolve-url -----------------------------------------------------------

COMMANDS['resolve-url'] = {
  summary: 'Resolve a EUR-Lex URL to a CELEX number',
  usage: 'eurlex resolve-url <url> [--lang ENG]',
  async run(args) {
    const flags = parseFlags(args, ['url']);
    if (!flags.url) die('URL required.  Usage: eurlex resolve-url <url>');
    const svc = bootServices();
    const lang = svc.validateLang(flags.lang || 'ENG') || 'ENG';

    const payload = await svc.resolveEurlexUrl(flags.url, lang);
    jsonOut(payload, flags.o || flags.output);
  },
};

// --- list ------------------------------------------------------------------

COMMANDS.list = {
  summary: 'List locally cached FMX files',
  usage: 'eurlex list',
  async run(args) {
    const flags = parseFlags(args);
    let files = [];
    if (fs.existsSync(DEFAULT_FMX_DIR)) {
      files = fs.readdirSync(DEFAULT_FMX_DIR)
        .filter((f) => f.endsWith('.xml') || f.endsWith('.zip'));
    }
    jsonOut({ cacheDir: DEFAULT_FMX_DIR, laws: files }, flags.o || flags.output);
  },
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`eurlex — CLI for EU legislation (Formex)

Usage:  eurlex <command> [options]

Commands:`);

  const maxLen = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(maxLen + 2)}${cmd.summary}`);
  }

  console.log(`
Global options:
  --lang <CODE>     EUR-Lex language code (default: ENG)
  -o, --output <f>  Write JSON output to file instead of stdout
  --help, -h        Show help for a command

Environment variables:
  CACHE_DIR         Cache directory for downloaded FMX files and derived artifacts
  FMX_DIR           Legacy alias for CACHE_DIR
  STORAGE_LIMIT_MB  Max cache size in MB (default: 500)
  TIMEOUT_MS        HTTP timeout in ms (default: 30000)

Examples:
  eurlex get 32016R0679                      # Download & parse GDPR as JSON
  eurlex get 32024R1689 --lang DEU -o ai.json  # AI Act in German
  eurlex fetch 32022R2065 -o dsa.xml         # Download raw DSA XML
  eurlex parse dsa.xml                       # Parse local XML to JSON
  eurlex metadata 32016R0679                 # Entry-into-force, ELI, etc.
  eurlex amendments 32016R0679               # List GDPR amendments
  eurlex case-law 32016R0679                 # CJEU judgments citing GDPR
  eurlex recital-titles 32016R0679           # AI-generated recital titles
  eurlex search "artificial intelligence"    # Search law metadata
  eurlex resolve "Regulation 2016/679"       # Resolve reference to CELEX
  eurlex resolve-url "https://eur-lex.europa.eu/eli/reg/2016/679/oj"
  eurlex list                                # Show cached files`);
}

async function main() {
  const args = process.argv.slice(2);
  const commandName = args[0];

  if (!commandName || commandName === '--help' || commandName === '-h') {
    printHelp();
    process.exit(0);
  }

  const command = COMMANDS[commandName];
  if (!command) {
    console.error(`Unknown command: ${commandName}`);
    console.error(`Run "eurlex --help" for available commands.`);
    process.exit(1);
  }

  const commandArgs = args.slice(1);
  if (commandArgs.includes('--help') || commandArgs.includes('-h')) {
    console.log(`${command.summary}\n\nUsage:\n  ${command.usage}`);
    process.exit(0);
  }

  await command.run(commandArgs);
}

main().catch((err) => {
  const message = err.statusCode ? `${err.message} (${err.code || err.statusCode})` : err.message;
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
});
