#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const PLUGIN_ID = 'hope7happiness.herdr-web';
const BASE_URL = process.env.HERDR_RC_BASE_URL || 'http://127.0.0.1:7930';
const HERDR_BIN = process.env.HERDR_RC_HERDR_BIN || 'herdr';
const SSH_BIN = process.env.HERDR_RC_SSH_BIN || 'ssh';
const AGENT_STATUSES = new Set(['idle', 'working', 'blocked', 'done', 'unknown']);
const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const WAIT_POLL_MS = 250;

function usage() {
  console.error('usage: herdr-rc.mjs {enable|status|connect <ssh-target>|list|disconnect <ssh-target>|wait <mirror-pane> [--until STATUS]... [--timeout MS]}');
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

function validatePane(raw) {
  const pane = String(raw || '').trim();
  if (!pane || pane.length > 255 || /[\x00-\x20\x7f]/.test(pane) || pane.startsWith('-')) {
    throw new Error('An exact mirror pane id is required, such as wC:p2.');
  }
  return pane;
}

export function parseWaitArgs(args) {
  const pane = validatePane(args[0]);
  const until = [];
  let timeoutMs = DEFAULT_WAIT_TIMEOUT_MS;
  for (let index = 1; index < args.length;) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === '--until') {
      if (!AGENT_STATUSES.has(value)) {
        throw new Error(`Invalid agent status: ${value || '(missing)'}.`);
      }
      until.push(value);
      index += 2;
    } else if (flag === '--timeout') {
      if (!/^(0|[1-9][0-9]*)$/.test(value || '')) {
        throw new Error('--timeout requires a non-negative integer in milliseconds.');
      }
      timeoutMs = Number(value);
      if (!Number.isSafeInteger(timeoutMs)) throw new Error('--timeout is too large.');
      index += 2;
    } else {
      throw new Error(`Unknown wait option: ${flag}.`);
    }
  }
  return { pane, until: new Set(until.length ? until : ['idle', 'done', 'blocked']), timeoutMs };
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

function isMirrorAgent(agent) {
  return [agent?.foreground_cwd, agent?.cwd]
    .some((cwd) => /(?:^|[\\/])\.mirror-pane[\\/]?$/.test(String(cwd || '')));
}

async function readAgent(pane) {
  const result = await run(HERDR_BIN, ['agent', 'get', pane], 10_000);
  let envelope;
  try { envelope = JSON.parse(result.stdout); } catch { throw new Error(`Herdr returned invalid agent JSON for ${pane}.`); }
  const agent = envelope?.result?.agent;
  if (!agent) throw new Error(`Herdr did not return an agent for ${pane}.`);
  return { envelope, agent };
}

export async function pollMirrorAgent({
  pane,
  until,
  timeoutMs,
  getAgent = () => readAgent(pane),
  sleep = delay,
  now = Date.now,
  pollMs = WAIT_POLL_MS,
}) {
  const deadline = now() + timeoutMs;
  let terminalId;
  while (true) {
    const current = await getAgent();
    const agent = current?.agent || current?.envelope?.result?.agent || current;
    if (!terminalId) {
      if (!isMirrorAgent(agent)) {
        throw new Error(`${pane} is not a mirror pane; use native "herdr agent wait" for local agents.`);
      }
      terminalId = agent.terminal_id;
    } else if (agent.terminal_id !== terminalId) {
      throw new Error(`The pane occupant changed while waiting for ${pane}.`);
    }
    if (until.has(agent.agent_status)) return current;

    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error(`Timed out waiting for ${pane}; current status is ${agent.agent_status || 'unknown'}.`);
    }
    await sleep(Math.min(pollMs, remaining));
  }
}

async function waitAgent(args) {
  const options = parseWaitArgs(args);
  const matched = await pollMirrorAgent(options);
  console.log(JSON.stringify(matched.envelope || { id: 'herdr-rc:wait', result: { agent: matched.agent || matched } }));
}

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
  const [command, ...args] = process.argv.slice(2);
  if (!command) return usage();
  if (command === 'wait') return waitAgent(args);
  if (args.length > 1) return usage();
  const rawTarget = args[0];
  if (command === 'enable' && !rawTarget) return enable();
  if (command === 'status' && !rawTarget) return status();
  if (command === 'list' && !rawTarget) return list();
  if (command === 'connect') return connect(validateTarget(rawTarget));
  if (command === 'disconnect') return disconnect(validateTarget(rawTarget));
  usage();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`herdr-rc: ${error.message}`);
    process.exitCode = 1;
  });
}
