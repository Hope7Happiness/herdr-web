// Tier 2 — Cast: attach to a Chrome DevTools Protocol endpoint and stream a
// page into the phone as JPEG frames, forwarding real input back.
//
// Same source as terminal-based browser plugins (Page.startScreencast), but
// the sink here is a browser: frames land in an <img>, so there is no cell
// quantization, no ANSI-symbol fallback, and pointer/keyboard events map
// straight onto page pixels. Point it at the CDP port your agent drives and
// you can watch the agent browse from your phone.
'use strict';

const WebSocket = require('ws');

const CDP_PORT = Number(process.env.HERDR_WEB_CDP_PORT || 9222);

function jlog(level, event, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, module: 'cast', event, ...extra }));
}

async function cdpFetch(path) {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}${path}`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`CDP ${path}: HTTP ${res.status}`);
  return res.json();
}

async function listTargets() {
  const all = await cdpFetch('/json');
  return all
    .filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
    .map((t) => ({ id: t.id, title: t.title, url: t.url, ws: t.webSocketDebuggerUrl }));
}

// One attached session: browser client <-> this <-> Chrome target.
class CastSession {
  constructor(ws, targetWsUrl) {
    this.client = ws;
    this.cdp = new WebSocket(targetWsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    this.msgId = 0;
    this.pending = new Map();
    this.closed = false;
    this.wire();
  }

  send(method, params = {}) {
    if (this.cdp.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    const id = ++this.msgId;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.cdp.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.delete(id)) resolve(null); }, 10000);
    });
  }

  wire() {
    this.cdp.on('open', async () => {
      await this.send('Page.enable');
      await this.send('Runtime.enable');
      await this.startCast();
      const { frameTree } = (await this.send('Page.getFrameTree')) || {};
      this.toClient({ type: 'meta', url: frameTree?.frame?.url || '' });
      jlog('info', 'attached', {});
    });

    this.cdp.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg.result);
        this.pending.delete(msg.id);
        return;
      }
      if (msg.method === 'Page.screencastFrame') {
        // Ack immediately or Chrome stops sending frames.
        this.send('Page.screencastFrameAck', { sessionId: msg.params.sessionId });
        this.toClient({
          type: 'frame',
          data: msg.params.data,
          w: msg.params.metadata.deviceWidth,
          h: msg.params.metadata.deviceHeight,
          scrollY: msg.params.metadata.scrollOffsetY,
        });
      } else if (msg.method === 'Page.frameNavigated' && !msg.params.frame.parentId) {
        this.toClient({ type: 'meta', url: msg.params.frame.url });
      }
    });

    this.cdp.on('close', () => { this.toClient({ type: 'detached' }); this.close(); });
    this.cdp.on('error', (e) => { jlog('error', 'cdp-error', { error: e.message }); this.close(); });

    this.client.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      this.onClient(m).catch((e) => jlog('error', 'client-cmd-failed', { t: m.type, error: e.message }));
    });
    this.client.on('close', () => this.close());
  }

  startCast(everyNthFrame = 1) {
    return this.send('Page.startScreencast', {
      format: 'jpeg', quality: 65, maxWidth: 1200, maxHeight: 2200, everyNthFrame,
    });
  }

  async onClient(m) {
    switch (m.type) {
      case 'mouse': // click / move: page pixels computed client-side
        if (m.action === 'click') {
          await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: m.x, y: m.y, button: 'left', clickCount: 1 });
          await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: m.x, y: m.y, button: 'left', clickCount: 1 });
        } else {
          await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: m.x, y: m.y });
        }
        break;
      case 'scroll':
        await this.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel', x: m.x, y: m.y, deltaX: m.dx || 0, deltaY: m.dy || 0,
        });
        break;
      case 'text':
        for (const ch of m.text) await this.send('Input.dispatchKeyEvent', { type: 'char', text: ch });
        break;
      case 'key': {
        const map = {
          Enter: { windowsVirtualKeyCode: 13, key: 'Enter', text: '\r' },
          Backspace: { windowsVirtualKeyCode: 8, key: 'Backspace' },
          Tab: { windowsVirtualKeyCode: 9, key: 'Tab' },
          Escape: { windowsVirtualKeyCode: 27, key: 'Escape' },
          ArrowUp: { windowsVirtualKeyCode: 38, key: 'ArrowUp' },
          ArrowDown: { windowsVirtualKeyCode: 40, key: 'ArrowDown' },
        }[m.key];
        if (map) {
          await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...map });
          await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...map });
        }
        break;
      }
      case 'viewport': {
        // Reflow the cast page to the phone instead of letterboxing a desktop
        // layout. Always reverted on detach so an agent's own browser is not
        // left resized behind our back.
        if (m.fit) {
          this.overrode = true;
          await this.send('Emulation.setDeviceMetricsOverride', {
            width: Math.round(m.w), height: Math.round(m.h),
            deviceScaleFactor: m.dpr || 2, mobile: true,
          });
          await this.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
        } else if (this.overrode) {
          this.overrode = false;
          await this.send('Emulation.clearDeviceMetricsOverride');
          await this.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        }
        await this.send('Page.stopScreencast');
        await this.startCast();
        break;
      }
      case 'navigate':
        await this.send('Page.navigate', { url: m.url });
        break;
      case 'back': await this.history(-1); break;
      case 'forward': await this.history(1); break;
      case 'reload': await this.send('Page.reload', {}); break;
      default: jlog('warn', 'unknown-client-cmd', { t: m.type });
    }
  }

  async history(delta) {
    const h = await this.send('Page.getNavigationHistory');
    if (!h) return;
    const idx = h.currentIndex + delta;
    if (idx >= 0 && idx < h.entries.length) {
      await this.send('Page.navigateToHistoryEntry', { entryId: h.entries[idx].id });
    }
  }

  toClient(obj) {
    if (this.client.readyState === this.client.OPEN) this.client.send(JSON.stringify(obj));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.overrode) {
        this.send('Emulation.clearDeviceMetricsOverride');
        this.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      }
    } catch { /* ignore */ }
    try { this.send('Page.stopScreencast'); } catch { /* ignore */ }
    try { this.cdp.close(); } catch { /* ignore */ }
    try { this.client.close(); } catch { /* ignore */ }
  }
}

async function attach(ws, targetId) {
  const targets = await listTargets();
  const t = targetId ? targets.find((x) => x.id === targetId) : targets[0];
  if (!t) {
    ws.send(JSON.stringify({ type: 'error', error: 'no CDP page target found' }));
    ws.close();
    return null;
  }
  jlog('info', 'attaching', { title: t.title?.slice(0, 40), url: t.url?.slice(0, 60) });
  return new CastSession(ws, t.ws);
}

module.exports = { listTargets, attach, CDP_PORT };
