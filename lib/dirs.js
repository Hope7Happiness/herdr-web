// Directory picker source: typing a path on a phone is the friction this app
// exists to remove, so directories come from what you already use —
// zoxide's frecency database, git repos under your projects tree, and the
// working directories of panes that are already open.
'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const HOME = os.homedir();
const SCAN_ROOTS = (process.env.HERDR_WEB_DIR_ROOTS
  || [path.join(HOME, 'projects'), path.join(HOME, 'work')].join(':')
).split(':').filter(Boolean);

let repoCache = { at: 0, dirs: [] };

function run(cmd, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 << 20 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

async function zoxideDirs() {
  const out = await run('zoxide', ['query', '-l', '-s']);
  const dirs = [];
  for (const line of out.split('\n')) {
    const m = /^\s*([\d.]+)\s+(\/.*)$/.exec(line);
    if (m) dirs.push({ path: m[2], score: Number(m[1]), source: 'recent' });
  }
  return dirs;
}

// Git repos are the directories you actually want to be in; find(1) with a
// depth bound is fast enough to cache for a minute.
async function repoDirs() {
  if (Date.now() - repoCache.at < 60000) return repoCache.dirs;
  const dirs = [];
  for (const root of SCAN_ROOTS) {
    if (!fs.existsSync(root)) continue;
    const out = await run('find', [root, '-maxdepth', '5', '-name', '.git', '-prune'], 8000);
    for (const line of out.split('\n')) {
      if (line.endsWith('/.git')) dirs.push({ path: line.slice(0, -5), score: 1, source: 'repo' });
    }
  }
  repoCache = { at: Date.now(), dirs };
  return dirs;
}

function score(entry, q) {
  if (!q) return entry.score;
  const p = entry.path.toLowerCase();
  const base = path.basename(entry.path).toLowerCase();
  let s = entry.score;
  if (base === q) s += 1000;
  else if (base.startsWith(q)) s += 500;
  else if (base.includes(q)) s += 250;
  else if (p.includes(q)) s += 100;
  else {
    // subsequence match, so "hw" still finds "herdr-web"
    let i = 0;
    for (const ch of p) if (ch === q[i]) i++;
    if (i < q.length) return -1;
    s += 10;
  }
  return s;
}

async function list(query, paneCwds = []) {
  const q = (query || '').trim().toLowerCase();
  const merged = new Map();
  const add = (e) => {
    const prev = merged.get(e.path);
    if (!prev || e.score > prev.score) merged.set(e.path, { ...prev, ...e, score: Math.max(prev?.score || 0, e.score) });
  };
  for (const e of await zoxideDirs()) add(e);
  for (const e of await repoDirs()) add(e);
  // An open pane's cwd is the most likely place you mean.
  for (const p of paneCwds) if (p) add({ path: p, score: 400, source: 'open' });

  return [...merged.values()]
    .map((e) => ({ ...e, rank: score(e, q) }))
    .filter((e) => e.rank >= 0)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 40)
    .map((e) => ({
      path: e.path,
      display: e.path.startsWith(HOME) ? '~' + e.path.slice(HOME.length) : e.path,
      source: e.source,
    }));
}

module.exports = { list };
