import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWaitArgs, pollMirrorAgent } from '../skills/herdr-rc-remote/scripts/herdr-rc.mjs';

function sampleAgent(status, cwd = '/state/.mirror-pane') {
  return {
    terminal_id: 'term_mirror',
    agent: 'codex',
    agent_status: status,
    cwd,
  };
}

test('mirror wait parses bounded status options', () => {
  const parsed = parseWaitArgs(['wC:p2', '--until', 'idle', '--timeout', '30000']);
  assert.equal(parsed.pane, 'wC:p2');
  assert.deepEqual([...parsed.until], ['idle']);
  assert.equal(parsed.timeoutMs, 30000);
});

test('mirror wait rechecks level after a missing event edge', async () => {
  let index = 0;
  let clock = 0;
  const statuses = ['working', 'idle'];
  const result = await pollMirrorAgent({
    pane: 'wC:p2',
    until: new Set(['idle']),
    timeoutMs: 1000,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    getAgent: async () => ({ agent: sampleAgent(statuses[Math.min(index++, statuses.length - 1)]) }),
  });
  assert.equal(result.agent.agent_status, 'idle');
  assert.equal(clock, 250);
});

test('mirror wait refuses a non-mirror pane', async () => {
  await assert.rejects(
    pollMirrorAgent({
      pane: 'wA:p1',
      until: new Set(['idle']),
      timeoutMs: 1000,
      getAgent: async () => ({ agent: sampleAgent('working', '/Users/abaka/herdr-rc') }),
    }),
    /not a mirror pane/,
  );
});
