'use strict';

const RESUME_COMMAND = /\bcodex\s+resume\s+([A-Za-z0-9][A-Za-z0-9._:-]{7,})\b/gi;

function resumeMatches(text) {
  const matches = [];
  RESUME_COMMAND.lastIndex = 0;
  let match;
  while ((match = RESUME_COMMAND.exec(String(text || '')))) {
    matches.push({ sessionId: match[1], command: `codex resume ${match[1]}` });
  }
  return matches;
}

function extractCodexResume(text) {
  const matches = resumeMatches(text);
  return matches.length ? matches[matches.length - 1] : null;
}

function paneFromSnapshot(snapshot, paneId) {
  return (snapshot?.panes || []).find((pane) => pane.pane_id === paneId) || null;
}

async function readRecent(client, paneId) {
  const result = await client.request('pane.read', {
    pane_id: paneId,
    source: 'recent',
    format: 'text',
    lines: 2000,
  });
  return String(result?.read?.text || '');
}

/** Interrupt Codex and resume only the session id it prints afterwards. */
async function restartCodex(client, snapshot, paneId, options = {}) {
  const pane = paneFromSnapshot(snapshot, paneId);
  if (!pane) throw new Error('Pane is no longer available.');
  if (String(pane.agent || '').toLowerCase() !== 'codex') {
    throw new Error('Restart is currently available for Codex panes only.');
  }

  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? 8_000;
  const pollMs = options.pollMs ?? 160;
  const before = await readRecent(client, paneId);
  const beforeMatches = resumeMatches(before);
  const beforeCount = beforeMatches.length;
  const beforeSessionId = beforeMatches.at(-1)?.sessionId;

  await client.request('pane.send_keys', { pane_id: paneId, keys: ['ctrl+c'] });

  const deadline = Date.now() + timeoutMs;
  let transcript = before;
  let resume = null;
  while (Date.now() <= deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    transcript = await readRecent(client, paneId);
    const matches = resumeMatches(transcript);
    if (matches.length > beforeCount || (transcript !== before && matches.length && matches.at(-1).sessionId !== beforeSessionId)) {
      resume = matches[matches.length - 1];
      break;
    }
  }
  if (!resume) throw new Error('Codex did not print a resumable session id after Ctrl-C.');

  await client.request('pane.send_text', { pane_id: paneId, text: resume.command });
  await client.request('pane.send_keys', { pane_id: paneId, keys: ['enter'] });
  return { ...resume, transcript };
}

module.exports = { extractCodexResume, resumeMatches, restartCodex };
