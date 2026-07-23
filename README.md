# herdr-web

Mobile-first web UI for the [herdr](https://herdr.dev) agent multiplexer —
view and drive coding-agent sessions (Claude Code first) from a phone
browser, backed by herdr's persistent PTY sessions and its semantic agent
state (idle / working / blocked / done).

Exploration sibling of tmux-web: herdr replaces tmux as the backend, so
there's no `tmux -C` bridge and no xterm emulation anywhere in the stack —
herdr's socket API serves the screen matrix as SGR-styled text and the
server parses it into styled row spans for native-DOM rendering.

## Run

```bash
node server.js          # port 7930 (HERDR_WEB_PORT to override)
```

Starts (or reuses) a headless `herdr server` automatically. Open
`http://localhost:7930`. From the Android emulator: `http://10.0.2.2:7930`.

## Architecture

```
phone browser <-> HTTP/WS (Express+ws, :7930) <-> ~/.config/herdr/herdr.sock (JSON API)
```

- `server.js` — thin bridge. Sessions/agents from `session.snapshot` +
  lifecycle event subscriptions; live view polls `pane.read visible/ansi`
  (300ms, only for the watched pane) with `pane.scroll_changed` as an
  immediate-read hint; `pane.agent_status_changed` pushes status dots in
  real time; input via `pane.send_text` / `pane.send_keys`.
- `lib/ansi.js` — per-line SGR → span parser (herdr emits no cursor
  escapes; see `docs/socket-api-notes.md` for the full API recon).
- `public/index.html` — single-page vanilla JS PWA: tab bar with
  agent-status dots, native-DOM row terminal (auto font-fit), swipe-down
  history mode, quick keys, textarea input.

## Key findings / decisions

Read `docs/socket-api-notes.md` before touching the bridge — it maps what
herdr's socket API can and cannot do (no output-stream subscription; why
polling; the 80×24 headless size constraint and the sidebar-collapse
config in `~/.config/herdr/config.toml`).

Mobile gotchas encoded in the UI (verified on the Android emulator,
evidence in `docs/verification/`):

- `interactive-widget=resizes-content` in the viewport meta — without it
  the keyboard pans the page and hides the terminal.
- The swipe-down-for-history gesture listens to **touch** events, not
  pointer events — Android Chrome fires `pointercancel` one move into any
  drag, but `touchmove` keeps streaming.

## Verify

```bash
node scripts/_smoke-screenshot.mjs   # desktop smoke @ phone viewport (needs playwright)
```

Android emulator flow (Phase 3 of PLAN.md): launch TestPhone2, open
`http://10.0.2.2:7930` in Chrome, drive via adb input, screenshot via
`adb exec-out screencap -p`.
