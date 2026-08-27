#!/usr/bin/env node

/**
 * parse-fmx — published alias for `eurlex parse` (see backend/README.md).
 *
 * The parsing lives in bin/eurlex.js so there is exactly one implementation;
 * this file only keeps the `parse-fmx` bin name working. It does still reject
 * unknown options itself: eurlex's shared flag parser accepts any `--flag` and
 * swallows the next token as its value, so `parse-fmx --bogus law.xml` would
 * otherwise consume the filename and silently read stdin instead.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const KNOWN_OPTIONS = new Set(['-o', '--output', '-h', '--help']);

const args = process.argv.slice(2);
for (const arg of args) {
  if (arg === '--') break;
  if (arg.startsWith('-') && !KNOWN_OPTIONS.has(arg)) {
    process.stderr.write(`Unknown option: ${arg}\n`);
    process.exit(1);
  }
}

const child = spawnSync(
  process.execPath,
  [path.join(__dirname, 'eurlex.js'), 'parse', ...args],
  { stdio: 'inherit' },
);

// Terminate the same way the child did, so a Ctrl-C isn't reported as a plain
// failure to whatever invoked us.
if (child.signal) {
  process.kill(process.pid, child.signal);
}
process.exit(child.status ?? 1);
