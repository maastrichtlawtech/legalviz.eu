"use strict";

const path = require("path");
const { Worker } = require("worker_threads");

const { parseFmxXml: defaultParseFmxXml } = require("./fmx-parser-node");
const { parseEurlexHtmlToCombined: defaultParseEurlexHtmlToCombined } = require("./eurlex-html-parser");
const { createWorkerPool } = require("./worker-pool");

// Two workers allow one large parse to proceed while another request is being
// handled, but keep the serving process well below the memory footprint of a
// broad build. The 640 MB per-worker cap matches the build-side default: a
// large act plus its jsdom tree needs headroom, while the cap still bounds a
// malformed or unexpectedly large request. Set PARSER_POOL_SIZE=0 to disable.
const DEFAULT_PARSER_POOL_SIZE = 2;
const DEFAULT_PARSER_WORKER_HEAP_MB = 640;
const MAX_CONSECUTIVE_POOL_FAILURES = 3;

function envInteger(name, fallback, { min = 0 } = {}) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(value) && value >= min ? value : fallback;
}

function createParserPool(options = {}) {
  const poolSize = options.poolSize === undefined
    ? envInteger("PARSER_POOL_SIZE", DEFAULT_PARSER_POOL_SIZE)
    : options.poolSize;
  const workerHeapMb = options.workerHeapMb === undefined
    ? envInteger("PARSER_WORKER_HEAP_MB", DEFAULT_PARSER_WORKER_HEAP_MB, { min: 1 })
    : options.workerHeapMb;
  const parseFmxXmlInline = options.parseFmxXml || defaultParseFmxXml;
  const parseEurlexHtmlToCombinedInline = options.parseEurlexHtmlToCombined || defaultParseEurlexHtmlToCombined;

  function parseInline(kind, input, lang) {
    return kind === "fmx"
      ? parseFmxXmlInline(input)
      : parseEurlexHtmlToCombinedInline(input, lang);
  }

  if (!Number.isInteger(poolSize) || poolSize < 0) {
    throw new Error(`Parser pool size must be a non-negative integer, got ${poolSize}`);
  }
  if (!Number.isInteger(workerHeapMb) || workerHeapMb < 1) {
    throw new Error(`Parser worker heap must be a positive integer, got ${workerHeapMb}`);
  }

  if (poolSize === 0) {
    return {
      enabled: false,
      parseFmxXml: (input) => parseInline("fmx", input),
      parseEurlexHtmlToCombined: (input, lang) => parseInline("html", input, lang),
      close: async () => {},
    };
  }

  const pool = createWorkerPool({
    poolSize,
    workerFactory: options.spawnWorker || (() => new Worker(path.join(__dirname, "parser-worker.js"), {
      resourceLimits: { maxOldGenerationSizeMb: workerHeapMb },
    })),
  });
  let consecutiveFailures = 0;
  let disabled = false;
  let closePromise = null;

  async function close() {
    if (!closePromise) closePromise = pool.close();
    await closePromise;
  }

  async function parse(kind, input, lang) {
    if (disabled) return parseInline(kind, input, lang);
    try {
      const reply = await pool.run({ kind, input, lang });
      if (!reply?.ok) {
        // A document-level parser error is not a worker failure. Let the
        // current inline path raise the same error the server raised before
        // the pool existed.
        return parseInline(kind, input, lang);
      }
      consecutiveFailures = 0;
      return reply.result;
    } catch {
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_POOL_FAILURES) {
        disabled = true;
        await close();
      }
      // Worker startup, structured-clone, and worker-death failures must not
      // turn a successful inline parse into a 500. The next request may try
      // the pool again unless repeated failures have disabled it.
      return parseInline(kind, input, lang);
    }
  }

  return {
    enabled: true,
    parseFmxXml: (input) => parse("fmx", input),
    parseEurlexHtmlToCombined: (input, lang = "ENG") => parse("html", input, lang),
    close,
  };
}

module.exports = {
  DEFAULT_PARSER_POOL_SIZE,
  DEFAULT_PARSER_WORKER_HEAP_MB,
  createParserPool,
};
