// herdr-web — thin bridge: herdr JSON socket API -> HTTP/WS for the browser.
// See PLAN.md and docs/socket-api-notes.md.
'use strict';

const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { WebSocketServer } = require('ws');
const herdr = require('./lib/herdr-client');
const { parseAnsiScreen } = require('./lib/ansi');

// Deliberately NOT process.env.PORT — that leaks from parent shells (bit us:
// inherited PORT=7681 = tmux-web's port).
const PORT = Number(process.env.HERDR_WEB_PORT || 7930);
const POLL_MS = 300;

function jlog(level, event, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, module: 'server', event, ...extra }));
}

// ---------------------------------------------------------------------------
// Session/agent state cache + event fan-out
// ---------------------------------------------------------------------------

const state = {
  snapshot: null,          // last session.snapshot result
  webClients: new Set(),   // ws connections
  eventSub: null,          // herdr subscription handle
  paneIds: [],             // pane ids covered by current subscription
  refreshTimer: null,
};

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of state.webClients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

async function refreshSnapshot(reason) {
  try {
    const res = await herdr.request('session.snapshot');
    state.snapshot = res.snapshot;
    broadcast({ type: 'sessions', sessions: sessionList() });
    const ids = (state.snapshot.panes || []).map((p) => p.pane_id).sort();
    if (ids.join(',') !== state.paneIds.join(',')) resubscribe(ids);
  } catch (e) {
    jlog('error', 'snapshot-failed', { reason, error: e.message });
  }
}

// Debounced snapshot refresh — lifecycle events often arrive in bursts.
function scheduleRefresh(reason) {
  if (state.refreshTimer) return;
  state.refreshTimer = setTimeout(() => {
    state.refreshTimer = null;
    refreshSnapshot(reason);
  }, 150);
}

function sessionList() {
  const snap = state.snapshot;
  if (!snap) return [];
  const agentsByPane = new Map((snap.agents || []).map((a) => [a.pane_id, a]));
  return (snap.workspaces || []).map((w) => ({
    workspace_id: w.workspace_id,
    label: w.label,
    focused: w.focused,
    agent_status: w.agent_status,
    panes: (snap.panes || [])
      .filter((p) => p.workspace_id === w.workspace_id)
      .map((p) => {
        const agent = agentsByPane.get(p.pane_id);
        return {
          pane_id: p.pane_id,
          tab_id: p.tab_id,
          focused: p.focused,
          agent_status: p.agent_status,
          agent: agent?.agent || null,
          title: agent?.terminal_title_stripped || p.terminal_title_stripped || null,
          cwd: p.foreground_cwd || p.cwd,
        };
      }),
  }));
}

function resubscribe(paneIds) {
  state.paneIds = paneIds;
  state.eventSub?.close();
  const subs = [
    { type: 'workspace.created' }, { type: 'workspace.closed' }, { type: 'workspace.renamed' },
    { type: 'tab.created' }, { type: 'tab.closed' },
    { type: 'pane.created' }, { type: 'pane.closed' }, { type: 'pane.updated' },
    { type: 'pane.exited' }, { type: 'pane.agent_detected' },
    ...paneIds.flatMap((id) => [
      { type: 'pane.agent_status_changed', pane_id: id },
      { type: 'pane.scroll_changed', pane_id: id },
    ]),
  ];
  state.eventSub = herdr.subscribe(subs, {
    onEvent(msg) {
      const { event, data } = msg;
      if (event === 'pane.agent_status_changed') {
        broadcast({ type: 'agent_status', ...data });
        scheduleRefresh(event);
      } else if (event === 'pane.scroll_changed') {
        pokeWatcher(data.pane_id);
      } else {
        scheduleRefresh(event);
      }
    },
    onClose() {
      // herdr restarted or connection dropped; retry with backoff.
      setTimeout(() => {
        herdr.ensureServer().then(() => refreshSnapshot('resubscribe')).catch((e) => jlog('error', 'herdr-recover-failed', { error: e.message }));
      }, 1000);
    },
  });
  jlog('info', 'subscribed', { panes: paneIds.length });
}

// ---------------------------------------------------------------------------
// Pane watchers — poll `pane.read visible/ansi`, push on change
// ---------------------------------------------------------------------------

const watchers = new Map(); // pane_id -> {clients:Set<ws>, timer, lastText, inFlight}

function pokeWatcher(paneId) {
  const w = watchers.get(paneId);
  if (w) pollPane(paneId, w);
}

async function pollPane(paneId, w) {
  if (w.inFlight) { w.pending = true; return; }
  w.inFlight = true;
  try {
    const res = await herdr.request('pane.read', {
      pane_id: paneId, source: 'visible', format: 'ansi',
    }, { timeoutMs: 5000 });
    const text = res.read.text;
    if (text !== w.lastText) {
      w.lastText = text;
      const rows = parseAnsiScreen(text);
      const data = JSON.stringify({ type: 'screen', pane: paneId, rows });
      for (const ws of w.clients) if (ws.readyState === ws.OPEN) ws.send(data);
    }
  } catch (e) {
    if (e.code === 'not_found') {
      stopWatcher(paneId);
      const data = JSON.stringify({ type: 'pane_gone', pane: paneId });
      for (const ws of w.clients) if (ws.readyState === ws.OPEN) ws.send(data);
    } else {
      jlog('error', 'poll-failed', { pane: paneId, error: e.message });
    }
  } finally {
    w.inFlight = false;
    if (w.pending) { w.pending = false; pollPane(paneId, w); }
  }
}

function watchPane(paneId, ws) {
  let w = watchers.get(paneId);
  if (!w) {
    w = { clients: new Set(), timer: null, lastText: null, inFlight: false, pending: false };
    watchers.set(paneId, w);
    w.timer = setInterval(() => pollPane(paneId, w), POLL_MS);
  }
  w.clients.add(ws);
  w.lastText = null; // force full send to the new client via next poll
  pollPane(paneId, w);
}

function unwatchPane(paneId, ws) {
  const w = watchers.get(paneId);
  if (!w) return;
  w.clients.delete(ws);
  if (w.clients.size === 0) stopWatcher(paneId);
}

function stopWatcher(paneId) {
  const w = watchers.get(paneId);
  if (!w) return;
  clearInterval(w.timer);
  watchers.delete(paneId);
}

// ---------------------------------------------------------------------------
// HTTP + WS
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

app.get('/api/sessions', async (_req, res) => {
  await refreshSnapshot('api-sessions');
  res.json({ sessions: sessionList() });
});

app.post('/api/workspaces', async (req, res) => {
  const { cwd, label, command } = req.body || {};
  try {
    const created = await herdr.request('workspace.create', { cwd, label });
    if (command) {
      await herdr.request('pane.send_text', { pane_id: created.root_pane.pane_id, text: `${command}\n` });
    }
    scheduleRefresh('workspace-created-api');
    res.json(created);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/workspaces/:id', async (req, res) => {
  try {
    await herdr.request('workspace.close', { workspace_id: req.params.id });
    scheduleRefresh('workspace-closed-api');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// index.html must never be cached (PWA staleness trap — tmux-web lesson).
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html') || filePath.endsWith('sw.js') || filePath.endsWith('.webmanifest')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  },
}));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  state.webClients.add(ws);
  let watched = null;
  jlog('info', 'ws-open', { clients: state.webClients.size });
  ws.send(JSON.stringify({ type: 'sessions', sessions: sessionList() }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    try {
      switch (msg.type) {
        case 'watch': {
          if (watched) unwatchPane(watched, ws);
          watched = msg.pane;
          if (watched) watchPane(watched, ws);
          break;
        }
        case 'input': { // literal text
          await herdr.request('pane.send_text', { pane_id: msg.pane, text: msg.text });
          break;
        }
        case 'key': { // named keys, e.g. ["enter"], ["ctrl+c"]
          await herdr.request('pane.send_keys', { pane_id: msg.pane, keys: msg.keys });
          break;
        }
        case 'scrollback': {
          const res = await herdr.request('pane.read', {
            pane_id: msg.pane, source: 'recent', format: 'ansi', lines: Math.min(msg.lines || 300, 2000),
          });
          ws.send(JSON.stringify({ type: 'scrollback', pane: msg.pane, rows: parseAnsiScreen(res.read.text) }));
          break;
        }
        default:
          jlog('warn', 'ws-unknown-type', { t: msg.type });
      }
    } catch (e) {
      jlog('error', 'ws-handler-failed', { t: msg.type, error: e.message });
      ws.send(JSON.stringify({ type: 'error', for: msg.type, error: e.message }));
    }
  });

  ws.on('close', () => {
    state.webClients.delete(ws);
    if (watched) unwatchPane(watched, ws);
    jlog('info', 'ws-close', { clients: state.webClients.size });
  });
});

// ---------------------------------------------------------------------------

(async () => {
  const pong = await herdr.ensureServer();
  jlog('info', 'herdr-ready', { version: pong.version, protocol: pong.protocol });
  await refreshSnapshot('startup');
  server.listen(PORT, () => jlog('info', 'listening', { port: PORT }));
})().catch((e) => {
  jlog('error', 'startup-failed', { error: e.message });
  process.exit(1);
});
