#!/usr/bin/env node

const { spawnSync } = require('child_process');
const path = require('path');
const child = spawnSync(
  process.execPath,
  [path.join(__dirname, 'eurlex.js'), 'parse', ...process.argv.slice(2)],
  { stdio: 'inherit' },
);

process.exit(child.status ?? 1);
