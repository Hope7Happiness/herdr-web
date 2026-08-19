'use strict';

const path = require('node:path');

const MIRROR_CWD_MARKER = '.mirror-pane';

function isMirrorPane(snapshot, paneId) {
  const pane = (snapshot?.panes || []).find((item) => item.pane_id === paneId);
  if (!pane) return false;
  return [pane.foreground_cwd, pane.cwd]
    .filter(Boolean)
    .some((cwd) => path.basename(cwd) === MIRROR_CWD_MARKER);
}

function occurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(needle, offset)) !== -1) {
    count++;
    offset += needle.length;
  }
  return count;
}

async function readEchoCount(client, paneId, text) {
  const result = await client.request('pane.read', {
    pane_id: paneId,
    source: 'recent',
    format: 'text',
    lines: 2000,
  });
  return occurrences(result?.read?.text || '', text);
}

async function submitPane(client, snapshot, paneId, text, options = {}) {
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  // A mirror pane's foreground process is the relay, not the displayed remote
  // agent, so agent.prompt correctly rejects it. Keep text and Enter as two
  // ordered requests: pane.send_input can deliver the text while losing its
  // coalesced Enter when a read-only mirror takes control of the remote PTY.
  if (isMirrorPane(snapshot, paneId)) {
    let before = null;
    try { before = await readEchoCount(client, paneId, text); } catch (_) { /* delay fallback below */ }
    await client.request('pane.send_text', { pane_id: paneId, text });
    let confirmed = false;
    const attempts = options.mirrorEchoAttempts ?? 50;
    const interval = options.mirrorEchoIntervalMs ?? 100;
    if (before !== null) {
      for (let attempt = 0; attempt < attempts; attempt++) {
        await sleep(interval);
        try {
          if (await readEchoCount(client, paneId, text) > before) {
            confirmed = true;
            break;
          }
        } catch (_) { /* keep polling until the bounded fallback */ }
      }
    }
    if (!confirmed) await sleep(options.mirrorFallbackDelayMs ?? 1000);
    await client.request('pane.send_keys', { pane_id: paneId, keys: ['enter'] });
    return { transport: 'mirror', echoConfirmed: confirmed };
  }

  try {
    await client.request('agent.prompt', { target: paneId, text });
    return { transport: 'agent' };
  } catch (_) {
    await client.request('pane.send_input', { pane_id: paneId, text, keys: ['enter'] });
    return { transport: 'pane' };
  }
}

module.exports = { MIRROR_CWD_MARKER, isMirrorPane, submitPane };
