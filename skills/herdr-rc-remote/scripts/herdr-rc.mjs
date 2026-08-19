#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PLUGIN_ID = 'hope7happiness.herdr-web';
const BASE_URL = process.env.HERDR_RC_BASE_URL || 'http://127.0.0.1:7930';
const HERDR_BIN = process.env.HERDR_RC_HERDR_BIN || 'herdr';
const SSH_BIN = process.env.HERDR_RC_SSH_BIN || 'ssh';

function usage() {
  console.error('usage: herdr-rc.mjs {enable|status|connect <ssh-target>|list|disconnect <ssh-target>}');
  process.exitCode = 2;
}

function assertManagedPane() {
  if (process.env.HERDR_ENV !== '1') {
    throw new Error('This command must run inside a Herdr-managed agent pane (HERDR_ENV=1).');
  }
}

function validateTarget(raw) {
  const target = String(raw || '').trim();
  if (!target) throw new Error('An explicit Tailscale/SSH target is required.');
  if (target.length > 255 || /[\x00-\x20\x7f]/.test(target) || target.startsWith('-')) {
    throw new Error('Use one SSH target without spaces, such as host, user@host, or an SSH config alias.');
  }
  return target;
}

async function run(file, args, timeout = 20_000) {
  try {
    return await execFileAsync(file, args, { timeout, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message).trim();
    throw new Error(detail || `${file} failed`);
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pluginAction(action, timeout = 45_000) {
  const invoked = await run(HERDR_BIN, ['plugin', 'action', 'invoke', action, '--plugin', PLUGIN_ID]);
  let logId;
  try { logId = JSON.parse(invoked.stdout)?.result?.log?.log_id; } catch { /* handled below */ }
  if (!logId) throw new Error(`Herdr did not return a log id for plugin action ${action}.`);

  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await run(HERDR_BIN, ['plugin', 'log', 'list', '--plugin', PLUGIN_ID, '--limit', '30']);
    let log;
    try { log = JSON.parse(result.stdout)?.result?.logs?.find((item) => item.log_id === logId); } catch { /* retry */ }
    if (log?.status === 'succeeded') return String(log.stdout || '').trim();
    if (log?.status === 'failed') throw new Error(String(log.stderr || log.stdout || `${action} failed`).trim());
    await delay(250);
  }
  throw new Error(`Timed out waiting for Herdr plugin action ${action}.`);
}

async function request(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(options.timeout || 120_000),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`RC returned invalid JSON (${response.status}).`); }
  if (!response.ok || data.error) throw new Error(data.error || `RC request failed (${response.status}).`);
  return data;
}

async function ensureBridge() {
  try {
    await request('/api/settings', { timeout: 1500 });
    return;
  } catch { /* start below */ }
  await pluginAction('start');
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      await request('/api/settings', { timeout: 1000 });
      return;
    } catch { await delay(250); }
  }
  throw new Error('Herdr RC bridge did not become ready on 127.0.0.1:7930.');
}

async function verifyRemote(target) {
  let result;
  const remoteStatus = [
    'for candidate in "$(command -v herdr 2>/dev/null)"',
    '"$HOME/.local/bin/herdr"',
    '"$HOME/.cargo/bin/herdr"',
    '/opt/homebrew/bin/herdr',
    '/usr/local/bin/herdr',
    '/usr/bin/herdr; do',
    'if [ -n "$candidate" ] && [ -x "$candidate" ]; then exec "$candidate" status server --json; fi;',
    'done;',
    'echo "herdr executable not found in the non-interactive PATH or common install locations" >&2; exit 127',
  ].join(' ');
  try {
    result = await run(SSH_BIN, [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=8',
      target,
      remoteStatus,
    ], 15_000);
  } catch (error) {
    throw new Error(`SSH/Herdr preflight failed for ${target}: ${error.message}\nRun "ssh ${target}" yourself if authentication or host-key approval is required.`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Remote command on ${target} did not return Herdr status JSON. Ensure Herdr is installed and available in the non-interactive SSH PATH.`);
  }
}

async function saveHosts(hosts, rollbackHosts) {
  const data = await request('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ remoteHosts: hosts }),
  });
  if (data.remoteSetup?.ok === false) {
    if (rollbackHosts) {
      try {
        await request('/api/settings', {
          method: 'PUT',
          body: JSON.stringify({ remoteHosts: rollbackHosts }),
        });
      } catch { /* retain the original actionable failure */ }
    }
    throw new Error(data.remoteSetup.error || 'Mirror configuration failed.');
  }
  return data;
}

async function enable() {
  const output = await pluginAction('tailscale-serve', 60_000);
  console.log(output || 'Herdr phone remote control enabled.');
}

async function status() {
  console.log(await pluginAction('tailscale-status') || 'No RC status was returned.');
}

async function connect(target) {
  const remote = await verifyRemote(target);
  await ensureBridge();
  const current = await request('/api/settings');
  const previous = current.remoteHosts || [];
  const hosts = [...new Set([...previous, target])];
  const saved = await saveHosts(hosts, previous);
  console.log(`Remote Herdr verified: ${target}`);
  if (remote.version) console.log(`Remote Herdr version: ${remote.version}`);
  console.log(saved.remoteSetup?.message || `Mirror configured for ${hosts.length} remote host(s).`);
  console.log('The remote workspaces and agents will appear in the ordinary RC agent list.');
}

async function list() {
  await ensureBridge();
  const current = await request('/api/settings');
  const hosts = current.remoteHosts || [];
  if (!hosts.length) return console.log('No remote Herdr hosts configured.');
  for (const host of hosts) console.log(host);
}

async function disconnect(target) {
  await ensureBridge();
  const current = await request('/api/settings');
  const previous = current.remoteHosts || [];
  const hosts = previous.filter((host) => host !== target);
  if (hosts.length === previous.length) {
    return console.log(`Remote host was not configured: ${target}`);
  }
  const saved = await saveHosts(hosts, previous);
  console.log(`Disconnected remote Herdr host: ${target}`);
  console.log(saved.remoteSetup?.message || 'Mirror configuration updated.');
}

async function main() {
  assertManagedPane();
  const [command, rawTarget, ...extra] = process.argv.slice(2);
  if (!command || extra.length) return usage();
  if (command === 'enable') return enable();
  if (command === 'status') return status();
  if (command === 'list') return list();
  if (command === 'connect') return connect(validateTarget(rawTarget));
  if (command === 'disconnect') return disconnect(validateTarget(rawTarget));
  usage();
}

main().catch((error) => {
  console.error(`herdr-rc: ${error.message}`);
  process.exitCode = 1;
});
