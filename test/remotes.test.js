'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  MANAGED_HEADER,
  normalizeTargets,
  renderManagedConfig,
  configureNow,
} = require('../lib/remotes');

test('normalizes comma/newline-separated hosts and removes duplicates', () => {
  assert.deepEqual(normalizeTargets('rtx5090, work-mac\nrtx5090'), ['rtx5090', 'work-mac']);
  assert.throws(() => normalizeTargets('work mac'), /invalid remote host/);
});

test('renders conservative mirror defaults and unique TOML host keys', () => {
  const config = renderManagedConfig(['alice@work:22', 'bob@work:22']);
  assert.match(config, new RegExp(`^${MANAGED_HEADER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(config, /always_control = false/);
  assert.match(config, /close_remote_on_local_close = false/);
  assert.match(config, /\[hosts\."work"\]/);
  assert.match(config, /\[hosts\."work-2"\]/);
  assert.match(config, /target = "alice@work:22"/);
});

test('configures and starts mirror without reinstalling an enabled plugin', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-rc-remotes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'hosts.toml');
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === 'plugin' && args[1] === 'list') {
      return { stdout: JSON.stringify({ result: { plugins: [{ plugin_id: 'mirror', enabled: true, version: '0.2.2' }] } }) };
    }
    return { stdout: '' };
  };

  const result = await configureNow(['rtx5090'], { configFile: file, run });
  assert.equal(result.hosts, 1);
  assert.equal(result.installed, false);
  assert.match(fs.readFileSync(file, 'utf8'), /target = "rtx5090"/);
  assert.deepEqual(calls.at(-1), ['plugin', 'action', 'invoke', 'start', '--plugin', 'mirror']);
  assert.equal(calls.some((args) => args[1] === 'install'), false);
});

test('replaces an unverified mirror build with the pinned cross-platform release', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-rc-remotes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === 'plugin' && args[1] === 'list') {
      return { stdout: JSON.stringify({ result: { plugins: [{ plugin_id: 'mirror', enabled: false, version: '0.3.0' }] } }) };
    }
    return { stdout: '' };
  };

  const result = await configureNow(['linux-x86'], { configFile: path.join(dir, 'hosts.toml'), run });
  assert.equal(result.installed, true);
  assert.deepEqual(calls[1], ['plugin', 'install', 'nikok6/herdr-mirror', '--ref', 'v0.2.2', '--yes']);
});

test('never overwrites a user-managed mirror config', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-rc-remotes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'hosts.toml');
  fs.writeFileSync(file, '[hosts.mine]\ntarget = "mine"\n');

  await assert.rejects(
    configureNow(['rtx5090'], { configFile: file, run: async () => ({ stdout: '' }) }),
    /not managed by RC/,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), '[hosts.mine]\ntarget = "mine"\n');
});

test('does not shadow a mirror config from another search path', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-rc-remotes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const managedFile = path.join(dir, 'plugin', 'hosts.toml');
  const existingFile = path.join(dir, 'standalone', 'hosts.toml');
  fs.mkdirSync(path.dirname(existingFile), { recursive: true });
  fs.writeFileSync(existingFile, '[hosts.mine]\ntarget = "mine"\n');

  await assert.rejects(
    configureNow(['rtx5090'], {
      configFile: managedFile,
      configFiles: [managedFile, existingFile],
      run: async () => ({ stdout: '' }),
    }),
    new RegExp(existingFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  assert.equal(fs.existsSync(managedFile), false);
});

test('clearing RC-managed hosts removes config and pauses mirror', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-rc-remotes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'hosts.toml');
  fs.writeFileSync(file, `${MANAGED_HEADER}\n`);
  const calls = [];

  const result = await configureNow([], {
    configFile: file,
    run: async (args) => { calls.push(args); return { stdout: '' }; },
  });
  assert.equal(result.active, false);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(calls, [['plugin', 'action', 'invoke', 'pause', '--plugin', 'mirror']]);
});
