'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { previewBase, rewriteLocation, shim, extractTitle } = require('../lib/preview');
const http = require('node:http');
const preview = require('../lib/preview');
const { securityHeaders } = require('../lib/security');

test('preview HTML permits same-origin referrer routing for root-relative images', async (t) => {
  const upstream = http.createServer((req, res) => {
    if (req.url === '/asset?image=1') res.writeHead(200, { 'content-type': 'image/png' }).end('image-bytes');
    else res.writeHead(200, { 'content-type': 'text/html' }).end('<head></head><img src="/asset?image=1">');
  });
  const proxy = http.createServer((req, res) => securityHeaders(req, res, () => {
    if (!preview.handle(req, res)) res.writeHead(404).end();
  }));
  t.after(() => { proxy.closeAllConnections(); proxy.close(); upstream.closeAllConnections(); upstream.close(); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const port = upstream.address().port;
  preview.allow(port);
  const origin = `http://127.0.0.1:${proxy.address().port}`;
  const pageURL = `${origin}/p/${port}/`;
  const page = await fetch(pageURL);
  assert.equal(page.headers.get('referrer-policy'), 'same-origin');
  await page.text();
  const asset = await fetch(`${origin}/asset?image=1`, { headers: { referer: pageURL } });
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('content-type'), 'image/png');
  assert.equal(await asset.text(), 'image-bytes');
});

test('uses the upstream document directory for relative preview navigation', () => {
  assert.equal(previewBase(5173, '/'), '/p/5173/');
  assert.equal(previewBase(5173, '/docs/page?mode=1'), '/p/5173/docs/');
  assert.equal(previewBase(5173, '/docs/'), '/p/5173/docs/');
});

test('rewrites local upstream redirects and preserves external redirects', () => {
  const relative = { location: '../login?next=%2F' };
  rewriteLocation(relative, 5173, '/account/profile');
  assert.equal(relative.location, '/p/5173/login?next=%2F');

  const absolute = { location: 'http://localhost:5173/dashboard#ready' };
  rewriteLocation(absolute, 5173, '/account');
  assert.equal(absolute.location, '/p/5173/dashboard#ready');

  const external = { location: 'https://example.com/login' };
  rewriteLocation(external, 5173, '/account');
  assert.equal(external.location, 'https://example.com/login');
});

test('preview shim handles document navigation in addition to API calls', () => {
  const script = shim(5173);
  assert.match(script, /closest\('a\[href\]'\)/);
  assert.match(script, /addEventListener\('submit'/);
  assert.match(script, /location\.assign\(n\)/);
  assert.match(script, /window\.open=function/);
});

test('extracts a compact human-facing title from preview HTML', () => {
  assert.equal(extractTitle('<html><head><title>  HerdR &amp; Codex  </title></head></html>'), 'HerdR & Codex');
  assert.equal(extractTitle('<html><body>no title</body></html>'), null);
});
