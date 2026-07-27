# Preview: tap a localhost URL, get the real page

Phone. Dev server output → one tap → a live, interactive app.

https://github.com/user-attachments/assets/b5357178-5ac0-458d-b57f-7483ff7d6f05

The agent's dev server prints its URL; tapping it opens the app right next to
the agent that is building it.

The counter climbing 0 → 3 is the point: those taps run the app's own
JavaScript. This is an iframe over a same-origin reverse proxy, so text is
selectable, pinch-zoom is the browser's own, and forms and file pickers work
like they do in any tab.

Details worth noticing:

- The **port chip strip** is discovered from listening sockets (`ss`), ranked
  dev-server-first, and the port you are viewing leads the strip.
- Each port is **opt-in** before it can be proxied — proxying arbitrary
  loopback ports would widen what anything reaching the bridge can touch.
- Root-absolute subresources (`/assets/app.js`) are routed by `Referer`, and an
  injected shim keeps `fetch`/XHR/WebSocket/history inside the `/p/<port>/`
  namespace, so hot-reload sockets survive the hop.

---

[← All demos](../demos.md) · [README](../../README.md)
