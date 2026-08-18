#!/usr/bin/env node
'use strict';

// Cross-platform detached launch for the one-shot Herdr plugin hook. Node's
// detached spawn creates a new process group on POSIX, including macOS where
// the `setsid` command is not installed by default.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const stateDir = process.argv[2];
if (!stateDir) {
  console.error('usage: daemon-start.js STATE_DIR');
  process.exit(2);
}

fs.mkdirSync(stateDir, { recursive: true });
const log = fs.openSync(path.join(stateDir, 'server.log'), 'a');
const child = spawn(process.execPath, [path.join(root, 'server.js')], {
  cwd: root,
  detached: true,
  env: process.env,
  stdio: ['ignore', log, log],
});
child.unref();
fs.closeSync(log);
process.stdout.write(String(child.pid));
