'use strict';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function csv(name) {
  return new Set((process.env[name] || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean));
}

function hostnameOf(hostHeader) {
  if (!hostHeader || typeof hostHeader !== 'string') return null;
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

function isAllowedHost(hostHeader) {
  const hostname = hostnameOf(hostHeader);
  if (!hostname) return false;
  if (LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.ts.net')) return true;
  return csv('HERDR_WEB_ALLOWED_HOSTS').has(hostname);
}

function isAllowedOrigin(originHeader, hostHeader) {
  if (!originHeader || typeof originHeader !== 'string') return false;
  let origin;
  try { origin = new URL(originHeader); } catch { return false; }
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return false;

  // Browsers connecting directly, or through Tailscale Serve, use the same
  // authority for the page and WebSocket. This blocks cross-site WebSocket
  // hijacking without introducing an application password.
  if (origin.host.toLowerCase() === String(hostHeader || '').toLowerCase()) return true;
  return csv('HERDR_WEB_ALLOWED_ORIGINS').has(origin.origin.toLowerCase());
}

function validateWebSocketRequest(req) {
  if (!isAllowedHost(req.headers.host)) return { ok: false, reason: 'host-not-allowed' };
  if (!isAllowedOrigin(req.headers.origin, req.headers.host)) return { ok: false, reason: 'origin-not-allowed' };
  return { ok: true };
}

function hostGuard(req, res, next) {
  if (isAllowedHost(req.headers.host)) return next();
  res.status(421).type('text/plain').send('host not allowed');
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // Previewed development apps often require eval or external resources, so
  // only constrain the controller UI itself.
  if (!req.url.startsWith('/p/')) {
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self' ws: wss:",
      "frame-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join('; '));
  }
  next();
}

module.exports = {
  hostnameOf,
  isAllowedHost,
  isAllowedOrigin,
  validateWebSocketRequest,
  hostGuard,
  securityHeaders,
};
