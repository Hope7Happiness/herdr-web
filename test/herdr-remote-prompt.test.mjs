import test from 'node:test';
import assert from 'node:assert/strict';
import { submitMirrorPrompt } from '../skills/herdr-rc-remote/scripts/herdr-remote.mjs';

function mirror({ terminalId = 'term-1', status = 'idle', seq = 10, source = 'agent' } = {}) {
  return {
    source,
    agent: {
      pane_id: 'w1:p2',
      terminal_id: terminalId,
      agent_status: status,
      state_change_seq: seq,
    },
  };
}

function fakeClock() {
  let value = 0;
  return {
    now: () => value,
    sleep: async (ms) => { value += ms; },
  };
}

test('remote prompt waits for a normalized long-paste echo before Enter and a lifecycle edge after it', async () => {
  const calls = [];
  const clock = fakeClock();
  let reads = 0;
  let resolves = 0;
  const text = `Implement the remote task with a deliberately long body that wraps.\n\n${'detail '.repeat(30)}final requirement`;

  const result = await submitMirrorPrompt({
    pane: 'w1:p2',
    text,
    resolveMirror: async () => {
      resolves++;
      calls.push(['resolve']);
      return mirror(resolves >= 3 ? { status: 'working', seq: 11 } : {});
    },
    readText: async () => {
      reads++;
      calls.push(['read']);
      return reads === 1 ? 'old transcript' : `... ${'detail '.repeat(22)}final   requirement`;
    },
    sendText: async (pane, value) => { calls.push(['text', pane, value]); },
    sendEnter: async (pane) => { calls.push(['enter', pane]); return { stdout: 'ok\n' }; },
    sleep: clock.sleep,
    now: clock.now,
  });

  assert.equal(result.stdout, 'ok\n');
  assert.equal(calls.filter(([kind]) => kind === 'enter').length, 1);
  assert.ok(calls.findIndex(([kind]) => kind === 'read') < calls.findIndex(([kind]) => kind === 'text'));
  assert.ok(calls.findLastIndex(([kind]) => kind === 'read') < calls.findIndex(([kind]) => kind === 'enter'));
  assert.ok(calls.findLastIndex(([kind]) => kind === 'enter') < calls.findLastIndex(([kind]) => kind === 'resolve'));
});

test('remote prompt refuses Enter if the terminal identity changes while confirming text', async () => {
  const calls = [];
  const clock = fakeClock();
  let resolves = 0;
  await assert.rejects(
    submitMirrorPrompt({
      pane: 'w1:p2',
      text: 'hello',
      resolveMirror: async () => mirror({ terminalId: ++resolves === 1 ? 'term-1' : 'term-2' }),
      readText: async () => '',
      sendText: async () => { calls.push('text'); },
      sendEnter: async () => { calls.push('enter'); },
      sleep: clock.sleep,
      now: clock.now,
    }),
    /occupant changed/,
  );
  assert.deepEqual(calls, ['text']);
});

test('remote prompt does not claim success without a post-Enter lifecycle edge', async () => {
  const calls = [];
  const clock = fakeClock();
  let reads = 0;
  await assert.rejects(
    submitMirrorPrompt({
      pane: 'w1:p2',
      text: 'hello',
      resolveMirror: async () => mirror(),
      readText: async () => (++reads === 1 ? '' : 'hello'),
      sendText: async () => { calls.push('text'); },
      sendEnter: async () => { calls.push('enter'); return {}; },
      sleep: clock.sleep,
      now: clock.now,
      startTimeoutMs: 300,
      pollMs: 100,
    }),
    /agent_prompt_stalled/,
  );
  assert.deepEqual(calls, ['text', 'enter']);
});

test('remote Codex paste placeholder gets one guarded second Enter', async () => {
  const calls = [];
  const clock = fakeClock();
  let reads = 0;
  let enters = 0;
  const result = await submitMirrorPrompt({
    pane: 'w1:p2',
    text: 'a prompt too large for inline rendering',
    resolveMirror: async () => mirror(enters >= 2 ? { status: 'working', seq: 11 } : {}),
    readText: async () => (++reads === 1 ? '' : '› [Pasted Content 1024 chars]'),
    sendText: async () => { calls.push('text'); },
    sendEnter: async () => { enters++; calls.push('enter'); return {}; },
    sleep: clock.sleep,
    now: clock.now,
    startTimeoutMs: 300,
    pollMs: 100,
  });
  assert.deepEqual(result, {});
  assert.deepEqual(calls, ['text', 'enter', 'enter']);
});

test('remote shell prompt confirms its echo but does not require an agent lifecycle', async () => {
  const clock = fakeClock();
  let reads = 0;
  const result = await submitMirrorPrompt({
    pane: 'w1:p2',
    text: 'printf ok',
    resolveMirror: async () => mirror({ status: 'unknown', source: 'pane' }),
    readText: async () => (++reads === 1 ? '$ ' : '$ printf ok'),
    sendText: async () => {},
    sendEnter: async () => ({ stdout: 'sent\n' }),
    sleep: clock.sleep,
    now: clock.now,
  });
  assert.equal(result.stdout, 'sent\n');
});
