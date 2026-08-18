// Drives the herdr runtime size. The JSON socket API cannot resize the
// headless runtime (fixed 80x24) — but the runtime follows the foreground
// attached client's terminal size. So we keep a real `herdr` TUI client
// alive inside a node-pty and resize that pty to what the web UI wants.
// Calibration (herdr 0.7.5, sidebar hidden): pane = (cols-1) x (rows-2).
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// node-pty 1.1.0's macOS npm prebuild ships spawn-helper without its execute
// bit (microsoft/node-pty#850). Repair that packaging defect before loading
// the native module; otherwise require() succeeds but every spawn fails with
// the unhelpful `posix_spawnp failed` error.
function repairMacSpawnHelper() {
  if (process.platform !== 'darwin') return;
  try {
    const root = path.dirname(require.resolve('node-pty/package.json'));
    const helper = path.join(root, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper');
    const mode = fs.statSync(helper).mode;
    if ((mode & 0o111) === 0) fs.chmodSync(helper, mode | 0o111);
  } catch (e) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', module: 'size-driver', event: 'spawn-helper-repair-failed', error: e.message }));
  }
}

repairMacSpawnHelper();

// node-pty is optional (native build): without it the herdr runtime stays at
// its 80x24 headless default instead of following the phone's viewport.
let pty = null;
try { pty = require('node-pty'); } catch (e) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', module: 'size-driver', event: 'node-pty-unavailable', detail: 'runtime size fixed at 80x24', error: e.message }));
}

const CHROME_COLS = 1;
const CHROME_ROWS = 2;

function jlog(level, event, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, module: 'size-driver', event, ...extra }));
}

class SizeDriver {
  constructor() {
    this.proc = null;
    this.cols = 0;
    this.rows = 0;
    this.stopped = false;
  }

  // Desired PANE size; chrome offsets are added here.
  setPaneSize(paneCols, paneRows) {
    if (!pty) return;
    const cols = Math.max(40, Math.min(140, paneCols + CHROME_COLS));
    const rows = Math.max(15, Math.min(70, paneRows + CHROME_ROWS));
    if (cols === this.cols && rows === this.rows && this.proc) {
      // Reassert even when unchanged. Another attached desktop client may
      // have become the runtime's latest size authority since the browser's
      // previous ResizeObserver event.
      try {
        this.proc.resize(Math.min(141, cols + 1), rows);
        this.proc.resize(cols, rows);
        jlog('info', 'size-reasserted', { cols, rows });
      }
      catch (e) { jlog('error', 'resize-failed', { error: e.message }); this._respawn(); }
      return;
    }
    this.cols = cols;
    this.rows = rows;
    if (!this.proc) this._spawn();
    else {
      try { this.proc.resize(cols, rows); jlog('info', 'resized', { cols, rows }); }
      catch (e) { jlog('error', 'resize-failed', { error: e.message }); this._respawn(); }
    }
  }

  _spawn() {
    if (this.stopped || !this.cols) return;
    try {
      const env = { ...process.env, TERM: 'xterm-256color' };
      // The bridge is commonly launched by a Herdr plugin hook and therefore
      // inherits pane identity. A child `herdr` with HERDR_ENV=1 is rejected
      // as a nested session. Keep HERDR_SOCKET_PATH so it attaches to the same
      // daemon, but make this phantom UI client independent of the host pane.
      for (const key of [
        'HERDR_ENV', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'HERDR_PANE_ID',
        'HERDR_PLUGIN_ID', 'HERDR_PLUGIN_ROOT', 'HERDR_PLUGIN_CONFIG_DIR',
        'HERDR_PLUGIN_STATE_DIR', 'HERDR_PLUGIN_ENTRYPOINT_ID',
        'HERDR_PLUGIN_CONTEXT_JSON',
      ]) delete env[key];
      this.proc = pty.spawn('herdr', [], {
        name: 'xterm-256color', cols: this.cols, rows: this.rows,
        env,
      });
    } catch (e) {
      jlog('error', 'spawn-failed', { error: e.message });
      this.proc = null;
      return;
    }
    jlog('info', 'spawned', { cols: this.cols, rows: this.rows, pid: this.proc.pid });
    this.proc.onData(() => {}); // discard rendered frames
    // Herdr may still be processing another attached client's last frame when
    // this phantom client starts. A second, real size transition after attach
    // makes phone width deterministic instead of timing-dependent.
    const proc = this.proc;
    setTimeout(() => {
      if (this.proc !== proc) return;
      try {
        proc.resize(Math.min(141, this.cols + 1), this.rows);
        proc.resize(this.cols, this.rows);
        jlog('info', 'initial-size-reasserted', { cols: this.cols, rows: this.rows });
      } catch (e) {
        jlog('error', 'resize-failed', { error: e.message });
      }
    }, 500).unref();
    this.proc.onExit(({ exitCode }) => {
      jlog('warn', 'client-exited', { exitCode });
      this.proc = null;
      this._respawn();
    });
  }

  _respawn() {
    if (this.stopped || this._respawnTimer) return;
    this._respawnTimer = setTimeout(() => {
      this._respawnTimer = null;
      if (!this.proc) this._spawn();
    }, 2000);
  }

  stop() {
    this.stopped = true;
    if (this._respawnTimer) clearTimeout(this._respawnTimer);
    this.proc?.kill();
    this.proc = null;
  }
}

module.exports = { SizeDriver };
