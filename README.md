# herdr-web

Mobile-first web UI for the [herdr](https://herdr.dev) agent multiplexer —
view and drive your coding agents (Claude Code first) from a phone browser,
backed by herdr's persistent PTY sessions and its semantic agent states
(idle / working / blocked / done).

Prompting a live Claude Code agent from a phone:

https://github.com/user-attachments/assets/a687a81a-8baf-497e-88e1-a6a8ff273e46

**More demos (mobile + desktop videos): [docs/demos.md](docs/demos.md)** ·
Agent-to-agent coordination: [docs/agent-coordination.md](docs/agent-coordination.md)

## What you get

- **Live terminal view** of any herdr pane, rendered as native DOM rows at a
  phone-readable width — herdr's runtime is resized to fit your screen, so
  Claude Code *reflows* to ~50 columns instead of squinting at 80.
- **Agent-status tabs** — herdr's killer feature, front and center: one tab
  per pane with a colored state dot (working / blocked / done / idle),
  sorted by attention.
- **Never miss an approval**: blocked agents raise a toast in-app and a
  system notification when the app is in the background; a bell chip cycles
  you through everything that needs you. "Done while you weren't looking"
  is tracked as unseen until you view it (synced with herdr's own seen state).
- **Smooth scrollback** — history is prefetched above the live screen in one
  scroll container; swiping into the past is plain native scrolling.
- **Quick keys + input** — Esc, Tab, ⇧Tab, Ctrl-C, arrows, Enter; text
  submits atomically via herdr's `agent.prompt` (no half-pasted prompts).
- **PWA** — installable, no build step, three runtime dependencies.

## Install

### As a herdr plugin

```bash
herdr plugin install eyalev/herdr-web
```

The plugin's startup hook launches the bridge on `http://127.0.0.1:7930`
whenever herdr starts (and there are Start/Stop actions in herdr's UI).

### Standalone

```bash
git clone https://github.com/eyalev/herdr-web
cd herdr-web && npm install
node server.js        # http://127.0.0.1:7930
```

Requires Node 18+, a running (or startable) herdr ≥ 0.7. `node-pty` is an
optional dependency — without it everything works, but the terminal stays at
herdr's 80×24 headless default instead of fitting your phone.

## Reaching it from your phone

The server deliberately binds `127.0.0.1` only — **it grants full terminal
control of every pane with no auth**. Expose it through something that
handles transport security for you:

- **Tailscale** (recommended): `tailscale serve --bg --https=17930 http://127.0.0.1:7930`
  then open `https://<machine>.<tailnet>.ts.net:17930` on your phone.
  HTTPS also unlocks notifications and PWA install.
- Any authenticated reverse proxy works the same way.
- `HERDR_WEB_BIND=0.0.0.0` exists if you really know what you're doing.

## How it works

```
 phone browser (PWA)
   │ ▲ screens/agent-states (WebSocket) · keys, prompts (WS/HTTP)
   ▼ │
 herdr-web bridge :7930
   server.js ── lib/ansi.js (ANSI → grid)
   │            lib/size-driver.js (fit-to-phone resize)
   ▼  JSON socket (session.snapshot, events, agent.prompt, keys)
 herdr daemon ──▶ PTY panes (Claude Code agents, …)
```

herdr's server owns the PTYs and already runs a full terminal emulator, so
there is **no xterm and no escape-sequence parsing pipeline here**: the
bridge polls `pane.read {source: "visible", format: "ansi"}` for the pane
you're viewing (300 ms, plus `pane.scroll_changed` events for snappiness),
parses the SGR-only styled lines into spans (~100 lines of code), and ships
them over a WebSocket. Background panes cost nothing — their status dots
come from pushed `pane.agent_status_changed` events.

The one clever bit: the JSON API can't resize the headless runtime, but the
runtime follows the foreground *client's* terminal size — so the bridge
keeps a real `herdr` TUI client in a hidden pty and resizes it to whatever
your browser reports. That's what makes agents reflow to phone width.

The full empirical API recon that shaped this design:
[docs/socket-api-notes.md](docs/socket-api-notes.md).

## Configuration

| Env var | Default | |
|---|---|---|
| `HERDR_WEB_PORT` | `7930` | HTTP/WS port |
| `HERDR_WEB_BIND` | `127.0.0.1` | Listen address |
| `HERDR_SOCKET_PATH` | `~/.config/herdr/herdr.sock` | herdr API socket |

Recommended herdr config (`~/.config/herdr/config.toml`) so headless panes
get full width:

```toml
[ui]
sidebar_start_collapsed = true
sidebar_collapsed_mode = "hidden"
```

## Status

Early but real — built and verified against herdr 0.7.5 (protocol 17) with
emulator-tested UX (see [docs/demos.md](docs/demos.md) for the evidence).
Expect herdr's pre-1.0 API to move. Issues and PRs welcome.

## License

MIT
