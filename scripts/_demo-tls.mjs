#!/usr/bin/env node
// TLS front for demo recordings: terminates TLS for the demo hostname and
// pipes raw bytes to the herdr-web bridge. Raw piping (not an HTTP proxy)
// means HTTP and the WebSocket upgrade both pass through untouched.
//
// Cert/key come from `tailscale cert` (real Let's Encrypt, valid padlock) or
// a self-signed pair for plumbing tests.
import tls from 'node:tls';
import net from 'node:net';
import fs from 'node:fs';

const PORT = Number(process.env.DEMO_TLS_PORT || 8443);
const APP = Number(process.env.DEMO_APP_HTTP || 7930);
const CERT = process.env.DEMO_CERT || `${process.env.HOME}/.config/herdr-web-demo/cert.pem`;
const KEY = process.env.DEMO_KEY || `${process.env.HOME}/.config/herdr-web-demo/key.pem`;

const log = (event, extra = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), module: 'demo-tls', event, ...extra }));

const server = tls.createServer(
  { cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) },
  (tlsSocket) => {
    const up = net.connect(APP, '127.0.0.1', () => {
      tlsSocket.pipe(up);
      up.pipe(tlsSocket);
    });
    up.on('error', (e) => { log('upstream-error', { error: e.message }); tlsSocket.destroy(); });
    tlsSocket.on('error', () => up.destroy());
  }
);
server.on('tlsClientError', (e) => log('tls-client-error', { error: e.message }));
process.on('uncaughtException', (e) => log('uncaught', { error: e.message }));
server.listen(PORT, '127.0.0.1', () => log('listening', { port: PORT, app: APP, cert: CERT }));
