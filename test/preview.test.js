'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { previewBase, rewriteLocation, shim } = require('../lib/preview');

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
