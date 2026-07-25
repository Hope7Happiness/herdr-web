#!/usr/bin/env node
// Demo-recording proxy: makes the emulator show a neutral Tailscale hostname
// in the URL bar without exposing the operator's own tailnet.
//
// The emulator is launched with `-http-proxy http://127.0.0.1:3128`, so all
// its traffic comes here. Requests for DEMO_HOST are mapped to the local
// herdr-web bridge (plain HTTP) or to the local TLS front (CONNECT/https),
// everything else is proxied normally so the device keeps working.
import net from 'node:net';
import http from 'node:http';

const PORT = Number(process.env.DEMO_PROXY_PORT || 3128);
const DEMO_HOST = process.env.DEMO_HOST || 'herdr-demo.taildf4693.ts.net';
const APP_HTTP = Number(process.env.DEMO_APP_HTTP || 7930);   // bridge, plain
const APP_TLS = Number(process.env.DEMO_APP_TLS || 8443);     // TLS front

const log = (event, extra = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), module: 'demo-proxy', event, ...extra }));

const server = http.createServer((req, res) => {
  let target;
  try { target = new URL(req.url.startsWith('http') ? req.url : `http://${req.headers.host}${req.url}`); }
  catch { res.writeHead(400).end('bad request'); return; }

  const isDemo = target.hostname === DEMO_HOST;
  const opts = {
    host: isDemo ? '127.0.0.1' : target.hostname,
    port: isDemo ? APP_HTTP : Number(target.port || 80),
    method: req.method,
    path: target.pathname + target.search,
    headers: req.headers,
  };
  if (isDemo) log('http-map', { path: opts.path });
  const up = http.request(opts, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', (e) => { log('http-error', { host: opts.host, error: e.message }); res.writeHead(502).end('proxy error'); });
  req.pipe(up);
});

// HTTPS (and the WebSocket upgrade over TLS) arrives as CONNECT.
server.on('connect', (req, socket, head) => {
  // Split on the LAST colon — IPv6 targets are [2607:f8b0::1]:443.
  const i = req.url.lastIndexOf(':');
  const host = (i > 0 ? req.url.slice(0, i) : req.url).replace(/^\[|\]$/g, '');
  const parsed = i > 0 ? Number(req.url.slice(i + 1)) : NaN;
  const isDemo = host === DEMO_HOST;
  const reqPort = Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : 443;
  // Chrome tunnels WebSockets through CONNECT too — even plain ws:// (port
  // 80). Map by requested port: 443 → TLS front, anything else → bridge.
  const port = isDemo ? (reqPort === 443 ? APP_TLS : APP_HTTP) : reqPort;
  const dest = isDemo ? '127.0.0.1' : host;
  if (isDemo) log('connect-map', { host, port });
  const up = net.connect(port, dest, () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', (e) => { log('connect-error', { host, error: e.message }); socket.destroy(); });
  socket.on('error', () => up.destroy());
});

// Plain-HTTP WebSocket upgrade (ws://) for the demo host.
server.on('upgrade', (req, socket, head) => {
  const host = (req.headers.host || '').split(':')[0];
  const isDemo = host === DEMO_HOST;
  // Proxied upgrades arrive in absolute-URI form (ws://host/ws); upstream
  // ws servers match on the PATH, so rewrite before forwarding.
  let path = req.url;
  if (/^(ws|http)s?:\/\//.test(path)) {
    const u = new URL(path);
    path = u.pathname + u.search;
  }
  log('upgrade-map', { host, path, demo: isDemo });
  const up = net.connect(isDemo ? APP_HTTP : 80, isDemo ? '127.0.0.1' : host, () => {
    up.write(`${req.method} ${path} HTTP/1.1\r\n` +
      Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

// A recording helper must never die mid-take on one bad upstream.
process.on('uncaughtException', (e) => log('uncaught', { error: e.message }));

server.listen(PORT, '127.0.0.1', () => log('listening', { port: PORT, demoHost: DEMO_HOST }));
