#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { parseWaitArgs, pollMirrorAgent } from './herdr-rc.mjs';

const execFileAsync = promisify(execFile);
const HERDR_BIN = process.env.HERDR_RC_HERDR_BIN || 'herdr';
const RC_CLI = new URL('./herdr-rc.mjs', import.meta.url);

function usage() {
  console.error([
    'usage:',
    '  herdr-remote {enable|status|connect SSH_TARGET|list|disconnect SSH_TARGET}',
    '  herdr-remote agent {list|get|read|wait|send-keys|prompt} ...',
    '  herdr-remote pane {read|send-text|send-keys|wait-output} ...',
  ].join('\n'));
  process.exitCode = 2;
}

function assertManagedPane() {
  if (process.env.HERDR_ENV !== '1') {
    throw new Error('This command must run inside a Herdr-managed agent pane (HERDR_ENV=1).');
  }
}

function validatePane(raw) {
  const pane = String(raw || '').trim();
  if (!pane || pane.length > 255 || /[\x00-\x20\x7f]/.test(pane) || pane.startsWith('-')) {
    throw new Error('An exact mirror pane id is required, such as wC:p2.');
  }
  return pane;
}

async function run(file, args, timeout = 20_000) {
  try {
    return await execFileAsync(file, args, { timeout, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message).trim();
    throw new Error(detail || `${file} failed`);
  }
}

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

async function requireMirror(pane) {
  const current = await readAgent(pane);
  if (!isMirrorAgent(current.agent)) {
    throw new Error(`${pane} is not a mirror pane; use native Herdr commands for local agents.`);
  }
  return current;
}

async function writeCommand(group, subcommand, args) {
  const pane = validatePane(args[0]);
  await requireMirror(pane);
  const result = await run(HERDR_BIN, [group, subcommand, pane, ...args.slice(1)]);
  if (result.stdout) process.stdout.write(result.stdout);
}

async function listAgents() {
  const result = await run(HERDR_BIN, ['agent', 'list']);
  let envelope;
  try { envelope = JSON.parse(result.stdout); } catch { throw new Error('Herdr returned invalid agent list JSON.'); }
  const agents = (envelope?.result?.agents || []).filter(isMirrorAgent);
  console.log(JSON.stringify({ ...envelope, result: { ...envelope.result, agents } }));
}

async function waitAgent(args) {
  const options = parseWaitArgs(args);
  const matched = await pollMirrorAgent(options);
  console.log(JSON.stringify(matched.envelope || { id: 'herdr-remote:wait', result: { agent: matched.agent || matched } }));
}

async function promptAgent(args) {
  const pane = validatePane(args[0]);
  const text = args.slice(1).join(' ').trim();
  if (!text) throw new Error('agent prompt requires a message.');
  await requireMirror(pane);
  await run(HERDR_BIN, ['pane', 'send-text', pane, text]);
  await run(HERDR_BIN, [
    'pane', 'wait-output', pane,
    '--match', text,
    '--source', 'recent',
    '--lines', '2000',
    '--timeout', '5000',
  ], 10_000);
  const result = await run(HERDR_BIN, ['pane', 'send-keys', pane, 'enter']);
  if (result.stdout) process.stdout.write(result.stdout);
}

async function delegateToRc(args) {
  const result = await run(process.execPath, [RC_CLI.pathname, ...args]);
  if (result.stdout) process.stdout.write(result.stdout);
}

async function main() {
  assertManagedPane();
  const [command, ...args] = process.argv.slice(2);
  if (!command) return usage();
  if (['enable', 'status', 'connect', 'list', 'disconnect'].includes(command)) {
    return delegateToRc([command, ...args]);
  }
  if (command === 'wait') return waitAgent(args);
  if (command === 'agent') {
    const [subcommand, ...subargs] = args;
    if (subcommand === 'list' && !subargs.length) return listAgents();
    if (subcommand === 'wait') return waitAgent(subargs);
    if (subcommand === 'prompt') return promptAgent(subargs);
    if (['get', 'read', 'send-keys'].includes(subcommand)) {
      return writeCommand('agent', subcommand, subargs);
    }
    return usage();
  }
  if (command === 'pane') {
    const [subcommand, ...subargs] = args;
    if (['read', 'send-text', 'send-keys', 'wait-output'].includes(subcommand)) {
      return writeCommand('pane', subcommand, subargs);
    }
    return usage();
  }
  usage();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`herdr-remote: ${error.message}`);
    process.exitCode = 1;
  });
}
