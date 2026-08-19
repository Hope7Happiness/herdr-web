'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isMirrorPane, submitPane } = require('../lib/input');

function recordingClient(failAgent = false) {
  const calls = [];
  return {
    calls,
    async request(method, params) {
      calls.push([method, params]);
      if (failAgent && method === 'agent.prompt') throw new Error('not an agent');
      return {};
    },
  };
}

test('recognizes mirror panes by their stable cwd marker', () => {
  const snapshot = { panes: [
    { pane_id: 'local', cwd: '/work/project' },
    { pane_id: 'remote', foreground_cwd: '/state/herdr-mirror/.mirror-pane' },
  ] };
  assert.equal(isMirrorPane(snapshot, 'local'), false);
  assert.equal(isMirrorPane(snapshot, 'remote'), true);
});

test('submits to a mirror as ordered text then Enter', async () => {
  const calls = [];
  let reads = 0;
  const client = {
    calls,
    async request(method, params) {
      calls.push([method, params]);
      if (method === 'pane.read') {
        reads++;
        return { read: { text: reads === 1 ? '' : 'hello' } };
      }
      return {};
    },
  };
  const sleeps = [];
  const snapshot = { panes: [{ pane_id: 'remote', cwd: '/state/.mirror-pane' }] };

  const result = await submitPane(client, snapshot, 'remote', 'hello', {
    sleep: async (ms) => { sleeps.push(ms); },
  });

  assert.deepEqual(result, { transport: 'mirror', echoConfirmed: true });
  assert.deepEqual(sleeps, [100]);
  assert.deepEqual(client.calls, [
    ['pane.read', { pane_id: 'remote', source: 'recent', format: 'text', lines: 2000 }],
    ['pane.send_text', { pane_id: 'remote', text: 'hello' }],
    ['pane.read', { pane_id: 'remote', source: 'recent', format: 'text', lines: 2000 }],
    ['pane.send_keys', { pane_id: 'remote', keys: ['enter'] }],
  ]);
});

test('waits for a new echo when the same mirror prompt already exists', async () => {
  let reads = 0;
  const client = {
    async request(method) {
      if (method !== 'pane.read') return {};
      reads++;
      return { read: { text: reads < 3 ? 'again' : 'again ... again' } };
    },
  };
  const snapshot = { panes: [{ pane_id: 'remote', cwd: '/state/.mirror-pane' }] };
  const result = await submitPane(client, snapshot, 'remote', 'again', { sleep: async () => {} });
  assert.deepEqual(result, { transport: 'mirror', echoConfirmed: true });
  assert.equal(reads, 3);
});

test('uses agent prompt locally and keeps the plain-pane fallback', async () => {
  const snapshot = { panes: [{ pane_id: 'local', cwd: '/work/project' }] };
  const agent = recordingClient();
  assert.deepEqual(await submitPane(agent, snapshot, 'local', 'hello'), { transport: 'agent' });
  assert.deepEqual(agent.calls, [
    ['agent.prompt', { target: 'local', text: 'hello' }],
  ]);

  const shell = recordingClient(true);
  assert.deepEqual(await submitPane(shell, snapshot, 'local', 'pwd'), { transport: 'pane' });
  assert.deepEqual(shell.calls, [
    ['agent.prompt', { target: 'local', text: 'pwd' }],
    ['pane.send_input', { pane_id: 'local', text: 'pwd', keys: ['enter'] }],
  ]);
});
