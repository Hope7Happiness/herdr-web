'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractCodexResume, restartCodex } = require('../lib/restart');

test('extracts only a safe codex resume command', () => {
  assert.deepEqual(extractCodexResume('To resume this session, run `codex resume 019abcde-1234-5678-9abc-def012345678`.'), {
    sessionId: '019abcde-1234-5678-9abc-def012345678',
    command: 'codex resume 019abcde-1234-5678-9abc-def012345678',
  });
  assert.equal(extractCodexResume('resume this session with rm -rf /'), null);
});

test('restarts Codex with Ctrl-C, then the new resume command', async () => {
  const calls = [];
  let reads = 0;
  const client = {
    async request(method, params) {
      calls.push([method, params]);
      if (method !== 'pane.read') return {};
      reads++;
      return { read: { text: reads === 1 ? 'working\n' : 'Interrupted\nTo resume this session, run codex resume 019abcde-1234-5678-9abc-def012345678\n' } };
    },
  };
  const result = await restartCodex(client, { panes: [{ pane_id: 'w1:p1', agent: 'codex' }] }, 'w1:p1', { sleep: async () => {} });
  assert.equal(result.sessionId, '019abcde-1234-5678-9abc-def012345678');
  assert.deepEqual(calls, [
    ['pane.read', { pane_id: 'w1:p1', source: 'recent', format: 'text', lines: 2000 }],
    ['pane.send_keys', { pane_id: 'w1:p1', keys: ['ctrl+c'] }],
    ['pane.read', { pane_id: 'w1:p1', source: 'recent', format: 'text', lines: 2000 }],
    ['pane.send_text', { pane_id: 'w1:p1', text: 'codex resume 019abcde-1234-5678-9abc-def012345678' }],
    ['pane.send_keys', { pane_id: 'w1:p1', keys: ['enter'] }],
  ]);
});

test('does not reuse a stale resume id after an unrelated redraw', async () => {
  let reads = 0;
  const client = {
    async request(method) {
      if (method === 'pane.read') {
        reads++;
        return { read: { text: reads === 1 ? 'old: codex resume 019abcde-1234-5678-9abc-def012345678' : 'old: codex resume 019abcde-1234-5678-9abc-def012345678\nnew output' } };
      }
      return {};
    },
  };
  await assert.rejects(
    restartCodex(client, { panes: [{ pane_id: 'w1:p1', agent: 'codex' }] }, 'w1:p1', { sleep: async () => {}, timeoutMs: 0 }),
    /did not print a resumable session id/,
  );
});
