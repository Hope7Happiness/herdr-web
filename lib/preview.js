// Tier 1 — Preview: reverse-proxy a local dev server under this origin so the
// phone can open it as a real page (real DOM, real text, native gestures)
// instead of a pixel stream. Also gives plain-HTTP dev servers the bridge's
// HTTPS for free, and avoids exposing each port to the tailnet separately.
//
// Routing:
//   /p/<port>/<path>   explicit prefix
//   /<path>            fallback for root-absolute subresources, routed by the
//                      Referer's /p/<port>/ prefix (dev servers emit /assets/…
//                      links that no amount of HTML rewriting catches reliably)
'use strict';

const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const { execFile } = require('node:child_process');

const PREFIX = /^\/p\/(\d+)(\/.*)?$/;
const TITLE_BYTES = 64 * 1024;
const TITLE_TIMEOUT_MS = 700;
const TITLE_CACHE_MS = 15_000;
const titleCache = new Map();

function jlog(level, event, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, module: 'preview', event, ...extra }));
}

// Ports the user explicitly allowed to be proxied. Proxying arbitrary
// localhost ports widens what anyone reaching the bridge can touch, so it is
// opt-in per port (the UI allows a port when you pick it from the list).
const allowed = new Set();
function allow(port) { allowed.add(Number(port)); }
function isAllowed(port) { return allowed.has(Number(port)); }

// Injected into proxied HTML: keeps app-generated URLs inside the /p/<port>/
// namespace. Referer-routing covers static subresources; this covers the
// dynamic cases (WebSocket/HMR, history, fetch with root-absolute paths).
function shim(port) {
  return `<script>(function(){
  var P='/p/${port}';
  var LOOP=/^(localhost|127(?:\\.\\d+){3}|0\\.0\\.0\\.0|\\[?::1\\]?)$/i;
  function nav(u){
    try{
      var a=new URL(u, document.baseURI||location.href);
      var local=a.origin===location.origin;
      var upstream=LOOP.test(a.hostname)&&(!a.port||Number(a.port)===${port});
      if(!local&&!upstream) return null;
      if(local&&(a.pathname===P||a.pathname.startsWith(P+'/'))) return a.pathname+a.search+a.hash;
      return P+(a.pathname.startsWith('/')?'':'/')+a.pathname+a.search+a.hash;
    }catch(e){return null;}
  }
  function fix(u){
    try{
      if(typeof u!=='string') return u;
      if(u.startsWith(P+'/')) return u;
      if(u.startsWith('/')&&!u.startsWith('//')) return P+u;
      var n=nav(u);
      if(n&&/^(?:https?:)?\\/\\//i.test(u)) return n;
      return u;
    }catch(e){return u;}
  }
  var of=window.fetch;
  if(of) window.fetch=function(i,o){ return of.call(this, (typeof i==='string')?fix(i):i, o); };
  var ox=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){ arguments[1]=fix(u); return ox.apply(this,arguments); };
  var OW=window.WebSocket;
  window.WebSocket=function(u,p){
    try{
      var a=new URL(u, location.href);
      if(a.host===location.host && !a.pathname.startsWith(P+'/')) a.pathname=P+a.pathname;
      u=a.toString();
    }catch(e){}
    return p===undefined?new OW(u):new OW(u,p);
  };
  window.WebSocket.prototype=OW.prototype;
  ['pushState','replaceState'].forEach(function(k){
    var o=history[k];
    history[k]=function(s,t,u){ return o.call(this,s,t,(u===undefined||u===null)?u:fix(String(u))); };
  });
  var oo=window.open;
  window.open=function(u){
    if(typeof u==='string'){var n=nav(u);if(n) arguments[0]=n;}
    return oo.apply(this,arguments);
  };
  // Run after app bootstrap so framework routers get first refusal. If they
  // prevent the event, their pushState/replaceState path above stays in charge;
  // otherwise keep ordinary document navigation inside the preview prefix.
  setTimeout(function(){
    window.addEventListener('click',function(e){
      if(e.defaultPrevented||e.button!==0) return;
      var a=e.target&&e.target.closest&&e.target.closest('a[href]');
      if(!a||a.hasAttribute('download')) return;
      var raw=a.getAttribute('href')||'';
      if(!raw||raw[0]==='#'||/^(?:javascript|mailto|tel):/i.test(raw)) return;
      var n=nav(a.href);
      if(!n) return;
      e.preventDefault();
      var target=(a.getAttribute('target')||'_self').toLowerCase();
      if(target==='_self'&&!e.metaKey&&!e.ctrlKey&&!e.shiftKey&&!e.altKey) location.assign(n);
      else oo.call(window,n,target==='_self'?'_blank':target);
    });
    window.addEventListener('submit',function(e){
      if(e.defaultPrevented) return;
      var f=e.target;
      if(!f||String(f.tagName).toLowerCase()!=='form') return;
      var n=nav(f.action);
      if(n) f.action=n;
    });
  },0);
})();</script>`;
}

function previewBase(port, requestPath) {
  let pathname = '/';
  try { pathname = new URL(requestPath, 'http://preview.invalid').pathname; } catch { /* root */ }
  const directory = pathname.endsWith('/') ? pathname : pathname.slice(0, pathname.lastIndexOf('/') + 1);
  return `/p/${port}${directory}`;
}

function rewriteLocation(headers, port, requestPath) {
  const location = headers.location;
  if (!location) return;
  try {
    const base = new URL(requestPath, `http://127.0.0.1:${port}`);
    const target = new URL(location, base);
    const loopback = /^(localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[?::1\]?)$/i.test(target.hostname);
    if (loopback && (!target.port || Number(target.port) === port)) {
      headers.location = `/p/${port}${target.pathname}${target.search}${target.hash}`;
    }
  } catch { /* preserve malformed upstream values */ }
}

function stripFramingHeaders(headers) {
  const out = { ...headers };
  delete out['x-frame-options'];
  delete out['cross-origin-opener-policy'];
  delete out['cross-origin-embedder-policy'];
  if (out['content-security-policy']) {
    // Keep the app's CSP but drop the directive that would block our iframe.
    out['content-security-policy'] = out['content-security-policy']
      .split(';').filter((d) => !/^\s*frame-ancestors/i.test(d)).join(';');
  }
  delete out['content-security-policy-report-only'];
  return out;
}

// Which port should serve this request? Explicit prefix wins; otherwise fall
// back to the referring preview.
function resolveTarget(req) {
  const m = PREFIX.exec(req.url);
  if (m) return { port: Number(m[1]), path: m[2] || '/' };
  const ref = req.headers.referer;
  if (ref) {
    try {
      const r = PREFIX.exec(new URL(ref).pathname);
      if (r) return { port: Number(r[1]), path: req.url };
    } catch { /* ignore */ }
  }
  return null;
}

function handle(req, res) {
  const t = resolveTarget(req);
  if (!t) return false;
  if (!isAllowed(t.port)) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end(`port ${t.port} is not enabled for preview`);
    return true;
  }

  const headers = { ...req.headers, host: `127.0.0.1:${t.port}` };
  delete headers['accept-encoding']; // so HTML can be rewritten without gunzip
  const up = http.request({ host: '127.0.0.1', port: t.port, method: req.method, path: t.path, headers }, (r) => {
    const isHtml = /text\/html/i.test(r.headers['content-type'] || '');
    const out = stripFramingHeaders(r.headers);
    rewriteLocation(out, t.port, t.path);
    if (!isHtml) {
      res.writeHead(r.statusCode, out);
      r.pipe(res);
      return;
    }
    const chunks = [];
    r.on('data', (c) => chunks.push(c));
    r.on('end', () => {
      let html = Buffer.concat(chunks).toString('utf8');
      const inject = `<base href="${previewBase(t.port, t.path)}">${shim(t.port)}`;
      html = /<head[^>]*>/i.test(html)
        ? html.replace(/<head[^>]*>/i, (h) => h + inject)
        : inject + html;
      delete out['content-length'];
      res.writeHead(r.statusCode, out);
      res.end(html);
    });
  });
  up.on('error', (e) => {
    jlog('warn', 'upstream-error', { port: t.port, path: t.path, error: e.message });
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`preview: cannot reach 127.0.0.1:${t.port} (${e.message})`);
  });
  req.pipe(up);
  return true;
}

// WebSocket upgrades for proxied apps (Vite HMR and friends). The injected
// shim rewrites their URLs into /p/<port>/… so they land here.
function handleUpgrade(req, socket, head) {
  const m = PREFIX.exec(req.url);
  if (!m || !isAllowed(Number(m[1]))) return false;
  const port = Number(m[1]);
  const path = m[2] || '/';
  const up = net.connect(port, '127.0.0.1', () => {
    const headers = { ...req.headers, host: `127.0.0.1:${port}` };
    up.write(`${req.method} ${path} HTTP/1.1\r\n`
      + Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
  return true;
}

// Infrastructure that is never a web preview target.
const NOISE = /^(adb|sshd?|cupsd|dnsmasq|systemd-resolve|tailscaled?|containerd|dockerd|postgres|mysqld|redis-server|mongod|Google|Adobe.*|Creative.*|cloudflar.*)$/i;
const DEV_PROC = /^(node|python3?|ruby|php|deno|bun|go|next-server|vite|rails|gunicorn|uvicorn|flask|http-server)/i;

function devScore(p) {
  let s = 0;
  if (DEV_PROC.test(p.process || '')) s += 3;
  if (p.port >= 3000 && p.port <= 9999) s += 2;
  if ([3000, 4200, 5173, 5174, 8000, 8080, 8081].includes(p.port)) s += 2;
  return s;
}

function decodeHtmlText(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, entity) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? all;
    const hex = entity[1]?.toLowerCase() === 'x';
    const value = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    try { return Number.isFinite(value) ? String.fromCodePoint(value) : all; } catch { return all; }
  });
}

function extractTitle(html) {
  const match = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (!match) return null;
  const title = decodeHtmlText(match[1].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  return title ? title.slice(0, 160) : null;
}

// Ask each loopback HTTP service for its human-facing page title. The request
// is deliberately small and short-lived: one unresponsive listener should not
// make the phone's port picker feel stuck.
function probeTitle(port, path = '/', redirects = 0) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value || null);
    };
    const req = http.get({
      host: '127.0.0.1', port, path,
      headers: { accept: 'text/html,application/xhtml+xml', 'accept-encoding': 'identity', 'user-agent': 'herdr-rc-title/1' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 2) {
        let target;
        try { target = new URL(res.headers.location, `http://127.0.0.1:${port}${path}`); } catch { /* ignore */ }
        res.resume();
        if (target && /^(localhost|127\.0\.0\.1|\[?::1\]?)$/i.test(target.hostname)
            && Number(target.port || 80) === port) {
          probeTitle(port, target.pathname + target.search, redirects + 1).then(finish);
          return;
        }
        finish(null);
        return;
      }
      if (!/html|xhtml/i.test(res.headers['content-type'] || '')) {
        res.resume();
        finish(null);
        return;
      }
      const chunks = [];
      let bytes = 0;
      res.on('data', (chunk) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes <= TITLE_BYTES) chunks.push(chunk);
        const title = extractTitle(Buffer.concat(chunks).toString('utf8'));
        if (title) {
          finish(title);
          req.destroy();
        } else if (bytes > TITLE_BYTES) {
          finish(null);
          req.destroy();
        }
      });
      res.on('end', () => finish(extractTitle(Buffer.concat(chunks).toString('utf8'))));
      res.on('error', () => finish(null));
    });
    req.setTimeout(TITLE_TIMEOUT_MS, () => { req.destroy(); finish(null); });
    req.on('error', () => finish(null));
  });
}

async function cachedTitle(port) {
  const cached = titleCache.get(port);
  if (cached && Date.now() - cached.at < TITLE_CACHE_MS) return cached.title;
  const title = await probeTitle(port);
  titleCache.set(port, { at: Date.now(), title });
  return title;
}

// Listening TCP ports on loopback, with the owning process name — this is what
// turns "preview" into one tap instead of typing a URL.
function listPorts(selfPort) {
  return new Promise((resolve) => {
    const mac = os.platform() === 'darwin';
    const cmd = mac ? 'lsof' : 'ss';
    const args = mac ? ['-nP', '-iTCP', '-sTCP:LISTEN'] : ['-ltnpH'];
    execFile(cmd, args, { timeout: 4000 }, (err, stdout) => {
      if (err) return resolve([]);
      const seen = new Map();
      for (const line of stdout.split('\n')) {
        const addr = mac
          ? /TCP\s+(\S+):(\d+)\s+\(LISTEN\)/.exec(line)
          : /\s(\S+):(\d+)\s+\S+\s/.exec(line);
        if (!addr) continue;
        const host = addr[1];
        const port = Number(addr[2]);
        if (!/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\*|\[::\]|\[::1\])$/.test(host)) continue;
        if (port === selfPort || port < 1024 || port > 65535) continue;
        const proc = mac ? /^(\S+)/.exec(line) : /users:\(\("([^"]+)"/.exec(line);
        const name = proc ? proc[1] : null;
        if (NOISE.test(name || '')) continue;
        if (!seen.has(port)) seen.set(port, { port, process: name });
      }
      // Rank dev servers above infrastructure — the list is a tap target, not
      // an inventory.
      const list = [...seen.values()].map((p) => ({ ...p, score: devScore(p) }));
      list.sort((a, b) => b.score - a.score || a.port - b.port);
      Promise.all(list.map(async ({ score, ...p }) => ({ ...p, title: await cachedTitle(p.port) })))
        .then(resolve, () => resolve(list.map(({ score, ...p }) => ({ ...p, title: null }))));
    });
  });
}

module.exports = {
  handle,
  handleUpgrade,
  listPorts,
  allow,
  isAllowed,
  previewBase,
  rewriteLocation,
  shim,
  extractTitle,
  probeTitle,
};
