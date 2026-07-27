# Cast: drive a real Chrome from the phone

For pages the proxy cannot frame — and for watching your agent browse.

https://github.com/user-attachments/assets/68a40e3c-c076-47a1-9070-e2a370f8f0b7

herdr-web attaches to a Chrome DevTools endpoint (`HERDR_WEB_CDP_PORT`,
default 9222 — the browser your agent automates) and streams
`Page.startScreencast` frames.

In the clip the page is scrolled by dragging and then driven somewhere else by
typing a URL: real `Input` events dispatched at exact page pixels, not a
recording.

Because the sink is a browser rather than a terminal:

- frames land in an `<img>` — no cell quantisation, no ANSI-symbol fallback;
- the cast page is **reflowed to the phone** via a device-metrics override, so
  you get a mobile layout instead of a letterboxed desktop one — and the
  override is reverted on detach, so an agent's browser is never left resized;
- the chip shows the **live URL**, which a target title stops reflecting the
  moment you navigate.

---

[← All demos](../demos.md) · [README](../../README.md)
