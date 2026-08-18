'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hostnameOf,
  isAllowedHost,
  isAllowedOrigin,
  validateWebSocketRequest,
} = require('../lib/security');

test('parses hostnames with ports and IPv6 brackets', () => {
  assert.equal(hostnameOf('localhost:7930'), 'localhost');
  assert.equal(hostnameOf('[::1]:7930'), '::1');
});

test('allows loopback and Tailscale Serve hosts', () => {
  assert.equal(isAllowedHost('127.0.0.1:7930'), true);
  assert.equal(isAllowedHost('[::1]:7930'), true);
  assert.equal(isAllowedHost('phone-control.example-tailnet.ts.net:17930'), true);
  assert.equal(isAllowedHost('attacker.example'), false);
  assert.equal(isAllowedHost('example.ts.net.attacker.example'), false);
});

test('allows same-origin WebSockets and rejects cross-site origins', () => {
  assert.equal(isAllowedOrigin('https://host.tailnet.ts.net:17930', 'host.tailnet.ts.net:17930'), true);
  assert.equal(isAllowedOrigin('https://evil.example', '127.0.0.1:7930'), false);
  assert.equal(isAllowedOrigin(undefined, '127.0.0.1:7930'), false);
});

test('validates host and origin together', () => {
  assert.deepEqual(validateWebSocketRequest({ headers: {
    host: 'host.tailnet.ts.net', origin: 'https://host.tailnet.ts.net',
  } }), { ok: true });
  assert.deepEqual(validateWebSocketRequest({ headers: {
    host: 'attacker.example', origin: 'https://attacker.example',
  } }), { ok: false, reason: 'host-not-allowed' });
});
