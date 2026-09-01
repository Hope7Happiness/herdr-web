import test from 'node:test';
import assert from 'node:assert/strict';
import { submitMirrorPrompt } from '../skills/herdr-rc-remote/scripts/herdr-remote.mjs';

function mirror(terminalId = 'term-1') {
  return { agent: { pane_id: 'w1:p2', terminal_id: terminalId } };
}

test('remote prompt sends ordered text and Enter without reading screen output', async () => {
  const calls = [];
  const result = await submitMirrorPrompt({
    pane: 'w1:p2',
    text: 'a long prompt that may wrap',
    resolveMirror: async () => { calls.push(['resolve']); return mirror(); },
    sendText: async (pane, text) => { calls.push(['text', pane, text]); },
    sendEnter: async (pane) => { calls.push(['enter', pane]); return { stdout: 'ok\n' }; },
    sleep: async (ms) => { calls.push(['sleep', ms]); },
  });

  assert.equal(result.stdout, 'ok\n');
  assert.deepEqual(calls, [
    ['resolve'],
    ['text', 'w1:p2', 'a long prompt that may wrap'],
    ['sleep', 250],
    ['resolve'],
    ['enter', 'w1:p2'],
  ]);
});

test('remote prompt refuses Enter if the terminal identity changed', async () => {
  const calls = [];
  let reads = 0;
  await assert.rejects(
    submitMirrorPrompt({
      pane: 'w1:p2',
      text: 'hello',
      resolveMirror: async () => mirror(++reads === 1 ? 'term-1' : 'term-2'),
      sendText: async () => { calls.push('text'); },
      sendEnter: async () => { calls.push('enter'); },
      sleep: async () => {},
    }),
    /occupant changed/,
  );
  assert.deepEqual(calls, ['text']);
});
