// Drives the herdr runtime size. The JSON socket API cannot resize the
// headless runtime (fixed 80x24) — but the runtime follows the foreground
// attached client's terminal size. So we keep a real `herdr` TUI client
// alive inside a node-pty and resize that pty to what the web UI wants.
// Calibration (herdr 0.7.5, sidebar hidden): pane = (cols-1) x (rows-2).
'use strict';

const pty = require('node-pty');

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
    const cols = Math.max(40, Math.min(140, paneCols + CHROME_COLS));
    const rows = Math.max(15, Math.min(70, paneRows + CHROME_ROWS));
    if (cols === this.cols && rows === this.rows && this.proc) return;
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
      this.proc = pty.spawn('herdr', [], {
        name: 'xterm-256color', cols: this.cols, rows: this.rows,
        env: { ...process.env, TERM: 'xterm-256color' },
      });
    } catch (e) {
      jlog('error', 'spawn-failed', { error: e.message });
      this.proc = null;
      return;
    }
    jlog('info', 'spawned', { cols: this.cols, rows: this.rows, pid: this.proc.pid });
    this.proc.onData(() => {}); // discard rendered frames
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
