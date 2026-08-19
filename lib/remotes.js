'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const MANAGED_HEADER = '# Managed by hope7happiness.herdr-web';
const MIRROR_REPO = 'nikok6/herdr-mirror';
// Pin a published, checksum-verified release. Installing the repository's
// moving default branch pulled v0.3.0, whose darwin-aarch64 binary hangs before
// main on macOS 15. The release contains native builds for all four supported
// local OS/CPU pairs; remote machines never run this binary.
const MIRROR_REF = 'v0.2.2';
const MIRROR_VERSION = '0.2.2';

function normalizeTargets(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(/[\n,]/);
  const seen = new Set();
  const targets = [];
  for (const raw of values) {
    const target = String(raw).trim();
    if (!target || seen.has(target)) continue;
    if (target.length > 255 || /[\x00-\x20\x7f]/.test(target)) {
      throw new Error(`invalid remote host: ${target.slice(0, 80)}`);
    }
    seen.add(target);
    targets.push(target);
  }
  if (targets.length > 32) throw new Error('at most 32 remote hosts are supported');
  return targets;
}

function tomlString(value) {
  return `"${String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')}"`;
}

function hostKey(target, index, used) {
  const hostname = target
    .replace(/^ssh:\/\//, '')
    .replace(/^[^@/]+@/, '')
    .replace(/:\d+$/, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || `remote-${index + 1}`;
  let key = hostname;
  let suffix = 2;
  while (used.has(key)) key = `${hostname}-${suffix++}`;
  used.add(key);
  return key;
}

function renderManagedConfig(targets) {
  const used = new Set();
  const entries = targets.map((target, index) => ({ target, key: hostKey(target, index, used) }));
  const lines = [
    MANAGED_HEADER,
    '# Edit remote hosts in the phone RC settings, not in this file.',
    'autostart = true',
    'always_control = false',
    'close_remote_on_local_close = false',
    `default_host = ${tomlString(entries[0].key)}`,
  ];
  for (const entry of entries) {
    lines.push('', `[hosts.${tomlString(entry.key)}]`, `target = ${tomlString(entry.target)}`, 'api_transport = "auto"', 'always_control = false');
  }
  return `${lines.join('\n')}\n`;
}

function defaultConfigFile() {
  // This is one of herdr-mirror's unconditional search paths and the path
  // returned by `herdr plugin config-dir mirror`.
  return path.join(os.homedir(), '.config', 'herdr', 'plugins', 'config', 'mirror', 'hosts.toml');
}

function configFiles(managedFile) {
  const files = [
    managedFile,
    path.join(os.homedir(), '.config', 'herdr-mirror', 'hosts.toml'),
  ];
  return [...new Set(files)];
}

async function runHerdr(args) {
  const bin = process.env.HERDR_BIN_PATH || 'herdr';
  return execFileAsync(bin, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
}

async function mirrorInstalled(run) {
  try {
    const { stdout } = await run(['plugin', 'list', '--json']);
    const line = stdout.trim().split('\n').filter(Boolean).at(-1);
    const plugins = JSON.parse(line)?.result?.plugins || [];
    return plugins.some((plugin) => plugin.plugin_id === 'mirror'
      && plugin.enabled !== false
      && plugin.version === MIRROR_VERSION);
  } catch {
    return false;
  }
}

async function ensureMirror(run) {
  if (await mirrorInstalled(run)) return false;
  await run(['plugin', 'install', MIRROR_REPO, '--ref', MIRROR_REF, '--yes']);
  return true;
}

function lastJsonLine(output) {
  const lines = String(output || '').trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* keep looking */ }
  }
  return null;
}

async function invokeMirror(action, run) {
  const invoked = await run(['plugin', 'action', 'invoke', action, '--plugin', 'mirror']);
  const logId = lastJsonLine(invoked.stdout)?.result?.log?.log_id;
  if (!logId) return;
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const listed = await run(['plugin', 'log', 'list', '--plugin', 'mirror', '--limit', '20']);
    const logs = lastJsonLine(listed.stdout)?.result?.logs || [];
    const log = logs.find((item) => item.log_id === logId);
    if (log?.status === 'succeeded') return;
    if (log?.status === 'failed') {
      const detail = `${log.stderr || ''}${log.stdout || ''}`.trim();
      throw new Error(`mirror ${action} failed${detail ? `: ${detail}` : ''}`);
    }
  }
  throw new Error(`mirror ${action} is still running; inspect its plugin log`);
}

async function configureNow(value, options = {}) {
  const targets = normalizeTargets(value);
  const file = options.configFile || defaultConfigFile();
  const run = options.run || runHerdr;
  const candidates = options.configFiles || (options.configFile ? [file] : configFiles(file));
  const existing = [];
  for (const candidate of candidates) {
    try {
      existing.push({ file: candidate, text: fs.readFileSync(candidate, 'utf8') });
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  const primary = existing.find((item) => item.file === file);
  const managed = primary?.text.startsWith(MANAGED_HEADER) || false;
  const foreign = existing.find((item) => item.file !== file || !item.text.startsWith(MANAGED_HEADER));

  if (!targets.length) {
    if (managed) {
      fs.unlinkSync(file);
      if (existing.some((item) => item.file !== file)) {
        return { ok: true, active: true, managed: false, hosts: 0, message: 'RC mirror config removed; existing mirror config left unchanged' };
      }
      await invokeMirror('pause', run);
      return { ok: true, active: false, hosts: 0, message: 'Remote mirror disabled' };
    }
    if (existing.length) {
      return { ok: true, active: true, managed: false, hosts: 0, message: 'Existing mirror config left unchanged' };
    }
    return { ok: true, active: false, hosts: 0, message: 'No remote hosts configured' };
  }

  if (foreign) {
    throw new Error(`${foreign.file} already exists and is not managed by RC; it was left unchanged`);
  }

  const installed = await ensureMirror(run);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, renderManagedConfig(targets), { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  await invokeMirror('start', run);
  return {
    ok: true,
    active: true,
    hosts: targets.length,
    installed,
    message: `Mirror started for ${targets.length} remote host${targets.length === 1 ? '' : 's'}`,
  };
}

let queue = Promise.resolve();
function configure(value, options) {
  const next = queue.then(() => configureNow(value, options));
  queue = next.catch(() => {});
  return next;
}

module.exports = {
  MANAGED_HEADER,
  MIRROR_REPO,
  MIRROR_REF,
  MIRROR_VERSION,
  normalizeTargets,
  renderManagedConfig,
  configure,
  configureNow,
  defaultConfigFile,
};
