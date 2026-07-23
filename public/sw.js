// Deliberately cache-nothing service worker (tmux-web no-store stance):
// exists only to satisfy PWA installability. Every fetch goes to network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* passthrough — no respondWith */ });
