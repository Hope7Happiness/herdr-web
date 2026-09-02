#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { parseWaitArgs, pollMirrorAgent } from './herdr-rc.mjs';

const execFileAsync = promisify(execFile);
const HERDR_BIN = process.env.HERDR_RC_HERDR_BIN || 'herdr';
const RC_CLI = new URL('./herdr-rc.mjs', import.meta.url);
const PROMPT_ECHO_TIMEOUT_MS = 15_000;
const PROMPT_START_TIMEOUT_MS = 5_000;
const PROMPT_POLL_MS = 100;
const PROMPT_CONFIRM_CHARS = 160;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  try {
    const result = await run(HERDR_BIN, ['agent', 'get', pane], 10_000);
    let envelope;
    try { envelope = JSON.parse(result.stdout); } catch { throw new Error(`Herdr returned invalid agent JSON for ${pane}.`); }
    const agent = envelope?.result?.agent;
    if (!agent) throw new Error(`Herdr did not return an agent for ${pane}.`);
    return { envelope, agent, source: 'agent' };
  } catch (agentError) {
    // A mirror can display an ordinary shell or another unrecognized process.
    // It is still a real pane. Use pane.get as the authority for its identity
    // and synthesize the minimum agent-shaped record needed by the wait/guard
    // code; reads and key sends are routed to the pane surface below.
    let result;
    try {
      result = await run(HERDR_BIN, ['pane', 'get', pane], 10_000);
    } catch {
      throw agentError;
    }
    let envelope;
    try { envelope = JSON.parse(result.stdout); } catch { throw agentError; }
    const info = envelope?.result?.pane;
    if (!info) throw agentError;
    const agent = {
      pane_id: info.pane_id,
      terminal_id: info.terminal_id,
      workspace_id: info.workspace_id,
      tab_id: info.tab_id,
      cwd: info.cwd,
      foreground_cwd: info.foreground_cwd,
      agent_status: info.agent_status || 'unknown',
      display_agent: 'terminal',
      title: info.terminal_title_stripped || null,
    };
    return {
      envelope: { id: 'herdr-remote:pane:get', result: { agent, pane: info }, type: 'agent_info' },
      agent,
      source: 'pane',
    };
  }
}

async function requireMirror(pane) {
  const current = await readAgent(pane);
  if (!isMirrorAgent(current.agent)) {
    throw new Error(`${pane} is not a mirror pane; use native Herdr commands for local agents.`);
  }
  return current;
}

function normalizedText(value) {
  return String(value || '').replace(/\s+/gu, ' ').trim();
}

function occurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) !== -1) {
    count++;
    offset += needle.length;
  }
  return count;
}

function promptNeedle(text) {
  return normalizedText(text).slice(-PROMPT_CONFIRM_CHARS);
}

function pastePlaceholderCount(text) {
  return (String(text || '').match(/\[Pasted Content \d+ chars\]/g) || []).length;
}

async function readPaneText(pane) {
  const result = await run(HERDR_BIN, [
    'pane', 'read', pane,
    '--source', 'recent-unwrapped',
    '--lines', '2000',
  ], 10_000);
  return result.stdout;
}

function stateChanged(before, after) {
  if (before.agent_status !== after.agent_status) return true;
  if (before.state_change_seq != null && after.state_change_seq != null) {
    return before.state_change_seq !== after.state_change_seq;
  }
  return false;
}

async function waitForPromptStart({
  pane,
  before,
  terminalId,
  resolveMirror,
  sleep,
  now,
  timeoutMs,
  pollMs,
}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
    const current = await resolveMirror(pane);
    if (current.agent.terminal_id !== terminalId) {
      throw new Error(`The pane occupant changed after the prompt was submitted in ${pane}.`);
    }
    if (stateChanged(before.agent, current.agent)) return true;
  }
  return false;
}

// The mirror may spend about 200ms switching from observe to control. Delaying
// between two local CLI calls does not prove that a long paste has crossed that
// boundary: queued text and Enter can still be flushed back-to-back. Confirm a
// normalized tail of the paste in the rendered composer before Enter, then
// require a lifecycle edge so this command cannot report success for text that
// is still sitting unsubmitted in Codex.
export async function submitMirrorPrompt({
  pane,
  text,
  resolveMirror = requireMirror,
  sendText = (target, value) => run(HERDR_BIN, ['pane', 'send-text', target, value]),
  sendEnter = (target) => run(HERDR_BIN, ['pane', 'send-keys', target, 'enter']),
  readText = readPaneText,
  sleep = delay,
  now = Date.now,
  echoTimeoutMs = PROMPT_ECHO_TIMEOUT_MS,
  startTimeoutMs = PROMPT_START_TIMEOUT_MS,
  pollMs = PROMPT_POLL_MS,
}) {
  const before = await resolveMirror(pane);
  const terminalId = before.agent.terminal_id;
  if (before.agent.agent_status === 'blocked') {
    throw new Error(`${pane} is blocked; inspect it before sending a prompt.`);
  }

  const needle = promptNeedle(text);
  const baselineScreen = await readText(pane);
  const baseline = occurrences(normalizedText(baselineScreen), needle);
  const baselinePastePlaceholders = pastePlaceholderCount(baselineScreen);
  await sendText(pane, text);

  const echoDeadline = now() + echoTimeoutMs;
  let echoed = false;
  let sawNewPastePlaceholder = false;
  while (now() < echoDeadline) {
    await sleep(Math.min(pollMs, Math.max(0, echoDeadline - now())));
    const current = await resolveMirror(pane);
    if (current.agent.terminal_id !== terminalId) {
      throw new Error(`The pane occupant changed after text was entered in ${pane}; Enter was not sent.`);
    }
    const screen = await readText(pane);
    if (pastePlaceholderCount(screen) > baselinePastePlaceholders) {
      sawNewPastePlaceholder = true;
    }
    if (occurrences(normalizedText(screen), needle) > baseline || sawNewPastePlaceholder) {
      echoed = true;
      break;
    }
  }
  if (!echoed) {
    throw new Error(`Timed out confirming prompt delivery in ${pane}; Enter was not sent.`);
  }

  const result = await sendEnter(pane);
  // Ordinary shell mirrors do not have an agent lifecycle to acknowledge.
  if (before.source !== 'agent' || !['idle', 'done'].includes(before.agent.agent_status)) {
    return result;
  }

  if (await waitForPromptStart({
    pane, before, terminalId, resolveMirror, sleep, now,
    timeoutMs: startTimeoutMs,
    pollMs,
  })) return result;

  // Codex represents large bracketed pastes as `[Pasted Content N chars]`.
  // In that state the first Enter can accept/expand the paste instead of
  // submitting it. Retry exactly once only when this invocation introduced
  // such a placeholder and the first Enter produced no lifecycle edge.
  if (sawNewPastePlaceholder) {
    await sendEnter(pane);
    if (await waitForPromptStart({
      pane, before, terminalId, resolveMirror, sleep, now,
      timeoutMs: startTimeoutMs,
      pollMs,
    })) return result;
  }
  throw new Error(`agent_prompt_stalled: ${pane} showed no lifecycle change after Enter; inspect before retrying.`);
}

async function writeCommand(group, subcommand, args) {
  const pane = validatePane(args[0]);
  const current = await requireMirror(pane);
  if (group === 'agent' && subcommand === 'get' && current.source === 'pane') {
    process.stdout.write(`${JSON.stringify(current.envelope)}\n`);
    return;
  }
  // Mirror agent records are projections owned by the streamer, not named
  // local agents. Herdr's agent send-keys path therefore rejects a valid
  // mirror pane as "not an active named agent"; route control input through
  // the pane surface, which also performs the takeover handshake.
  const actualGroup = group === 'agent' &&
    (current.source === 'pane' || subcommand === 'send-keys') ? 'pane' : group;
  const result = await run(HERDR_BIN, [actualGroup, subcommand, pane, ...args.slice(1)]);
  if (result.stdout) process.stdout.write(result.stdout);
}

async function readMirrorPanes() {
  const workspacesResult = await run(HERDR_BIN, ['workspace', 'list']);
  let workspaces;
  try { workspaces = JSON.parse(workspacesResult.stdout)?.result?.workspaces || []; } catch { return []; }
  const panes = [];
  for (const workspace of workspaces) {
    try {
      const result = await run(HERDR_BIN, ['pane', 'list', '--workspace', workspace.workspace_id]);
      const listed = JSON.parse(result.stdout)?.result?.panes || [];
      panes.push(...listed.filter(isMirrorAgent));
    } catch { /* a workspace can disappear while the mirror refreshes */ }
  }
  return panes;
}

async function listAgents() {
  const result = await run(HERDR_BIN, ['agent', 'list']);
  let envelope;
  try { envelope = JSON.parse(result.stdout); } catch { throw new Error('Herdr returned invalid agent list JSON.'); }
  const agents = (envelope?.result?.agents || []).filter(isMirrorAgent);
  const seen = new Set(agents.map((agent) => agent.pane_id));
  // Keep ordinary mirror panes visible too. Herdr's agent list intentionally
  // omits panes without recognized agent metadata, but RC controls panes, not
  // only agents, so a terminal pane must not disappear from the remote list.
  for (const pane of await readMirrorPanes()) {
    if (seen.has(pane.pane_id)) continue;
    seen.add(pane.pane_id);
    agents.push({
      pane_id: pane.pane_id,
      terminal_id: pane.terminal_id,
      workspace_id: pane.workspace_id,
      tab_id: pane.tab_id,
      cwd: pane.cwd,
      foreground_cwd: pane.foreground_cwd,
      agent_status: pane.agent_status || 'unknown',
      display_agent: 'terminal',
      title: pane.terminal_title_stripped || null,
    });
  }
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
  const result = await submitMirrorPrompt({ pane, text });
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
