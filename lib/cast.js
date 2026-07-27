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
// Builds a stable-ish selector for a picked element, evaluated in the page.
const SELECTOR_FN = `function () {
  const el = this;
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);
  const one = (n) => {
    if (n.id) return '#' + esc(n.id);
    const tid = n.getAttribute && (n.getAttribute('data-testid') || n.getAttribute('data-test'));
    if (tid) return n.tagName.toLowerCase() + '[data-testid="' + tid + '"]';
    let s = n.tagName ? n.tagName.toLowerCase() : 'node';
    const cls = (n.className && typeof n.className === 'string')
      ? n.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2) : [];
    if (cls.length) s += '.' + cls.map(esc).join('.');
    const p = n.parentElement;
    if (p) {
      const sibs = [...p.children].filter((c) => c.tagName === n.tagName);
      if (sibs.length > 1) s += ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')';
    }
    return s;
  };
  const parts = [];
  let n = el;
  for (let i = 0; n && n.nodeType === 1 && i < 4; i++) {
    const tag = n.tagName.toLowerCase();
    if (tag === 'html' || tag === 'body') break; // noise in a prompt
    parts.unshift(one(n));
    if (n.id) break;
    n = n.parentElement;
  }
  const text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
  // A tap that lands on <body> would otherwise yield an empty selector.
  if (!parts.length) parts.push(el.tagName ? el.tagName.toLowerCase() : 'element');
  return JSON.stringify({
    selector: parts.join(' > '),
    tag: el.tagName ? el.tagName.toLowerCase() : '?',
    text,
  });
}`;

class CastSession {
  constructor(ws, targetWsUrl) {
    this.client = ws;
    this.cdp = new WebSocket(targetWsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    this.msgId = 0;
    this.pending = new Map();
    this.closed = false;
    // Default to watching: a phone in your pocket should not be dispatching
    // clicks into a browser an agent is driving. Input needs an explicit
    // takeover (which cannot lock the agent out — CDP allows many clients —
    // but keeps OUR input off the page and makes the state visible).
    this.mode = 'watch';
    this.errors = [];
    this.wire();
  }

  noteError(e) {
    const key = `${e.kind}|${e.text}`.slice(0, 240);
    if (this.errors.some((x) => `${x.kind}|${x.text}`.slice(0, 240) === key)) return;
    this.errors.push(e);
    if (this.errors.length > 20) this.errors.shift();
    this.toClient({ type: 'errors', errors: this.errors });
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
      await this.send('DOM.enable');   // for the element picker
      await this.send('Log.enable');   // network/resource errors land here
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
        this.errors = [];
        this.toClient({ type: 'errors', errors: [] });
        this.toClient({ type: 'meta', url: msg.params.frame.url });
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.noteError({
          kind: 'exception',
          text: d.exception?.description?.split('\n')[0] || d.text || 'exception',
          where: d.url ? `${d.url}:${(d.lineNumber ?? 0) + 1}` : '',
        });
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.noteError({
          kind: 'console.error',
          text: msg.params.args.map((a) => a.description || a.value || a.type).join(' ').slice(0, 300),
          where: msg.params.stackTrace?.callFrames?.[0]
            ? `${msg.params.stackTrace.callFrames[0].url}:${msg.params.stackTrace.callFrames[0].lineNumber + 1}` : '',
        });
      } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        const e = msg.params.entry;
        this.noteError({ kind: e.source || 'log', text: (e.text || '').slice(0, 300), where: e.url || '' });
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
    // Everything that touches the page is gated on takeover; picking and
    // reading are safe while watching.
    const WRITES = new Set(['mouse', 'scroll', 'text', 'key', 'navigate', 'back', 'forward', 'reload']);
    if (WRITES.has(m.type) && this.mode !== 'control') {
      this.toClient({ type: 'blocked', reason: 'watching' });
      return;
    }
    switch (m.type) {
      case 'mode':
        this.mode = m.mode === 'control' ? 'control' : 'watch';
        jlog('info', 'mode', { mode: this.mode });
        this.toClient({ type: 'mode', mode: this.mode });
        break;
      case 'pick': {
        // Tap → element. DOM.getNodeForLocation works on the page's own
        // coordinates, which is exactly what the cast already gives us.
        const loc = await this.send('DOM.getNodeForLocation', {
          x: Math.round(m.x), y: Math.round(m.y), includeUserAgentShadowDOM: false,
        });
        if (!loc?.backendNodeId) { this.toClient({ type: 'picked', error: 'nothing there' }); break; }
        const resolved = await this.send('DOM.resolveNode', { backendNodeId: loc.backendNodeId });
        if (!resolved?.object?.objectId) { this.toClient({ type: 'picked', error: 'could not resolve' }); break; }
        const r = await this.send('Runtime.callFunctionOn', {
          objectId: resolved.object.objectId,
          functionDeclaration: SELECTOR_FN,
          returnByValue: true,
        });
        try {
          this.toClient({ type: 'picked', ...JSON.parse(r.result.value) });
        } catch {
          this.toClient({ type: 'picked', error: 'could not describe element' });
        }
        break;
      }
      case 'pause':
        await this.send('Page.stopScreencast');
        break;
      case 'resume':
        await this.startCast();
        break;
      case 'clearErrors':
        this.errors = [];
        this.toClient({ type: 'errors', errors: [] });
        break;
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
