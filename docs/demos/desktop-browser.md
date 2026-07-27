# Desktop: agent and the real page, side by side

The whole argument for herdr-web in 40 seconds.

https://github.com/user-attachments/assets/19caaa1d-49de-4ec8-9549-90af1956c0bb

A terminal multiplexer can only show a web page as *pixels* — that is why
terminal browser plugins stream JPEG frames into kitty-graphics or convert
them to ANSI symbols. herdr-web is already a browser, so it does not have to.

What happens in the clip:

1. **A localhost URL in agent output is a tap target.** The dev server prints
   `http://localhost:5177/`; one click opens it. No modifier key, no typing a
   port, no separate tunnel.
2. **Split view opens** — the agent keeps its pane on the left, the app it is
   building renders on the right, and the prompt box stays usable.
3. **It is the live page, not a picture of one.** Clicking the button runs the
   app's JavaScript; double-clicking the heading selects real text. Nothing
   here is a frame stream: the browser fetches the app's own assets through a
   same-origin reverse proxy.
4. **The agent restyles the app and the page reloads itself.** The prompt asks
   for a colour change; the agent edits `styles.css`; the dev server's
   live-reload stream (SSE, proxied through the bridge) repaints the right
   pane green. Edit-to-visible-result without touching the browser.
5. **Cast mode** takes over the same pane for anything the proxy cannot frame —
   a real Chrome, streamed and drivable.

Why it is better than a terminal screencast: crisp native text instead of
quantised cells, real scroll/zoom/selection/keyboard, the app's own bandwidth
instead of a video stream, and — because the proxy runs under the bridge's
origin — a plain-HTTP dev server inherits HTTPS with no extra tunnel.

---

[← All demos](../demos.md) · [README](../../README.md)
