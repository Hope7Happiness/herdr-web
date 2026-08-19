# herdr-web

> This is the `Hope7Happiness/herdr-web` fork of
> [`eyalev/herdr-web`](https://github.com/eyalev/herdr-web). It keeps the
> upstream mobile UI and adds first-class Tailscale lifecycle commands,
> cross-origin WebSocket protection, security headers, tests, and macOS-safe
> plugin startup.

Minimal, Codex-first web UI for the [herdr](https://herdr.dev) agent multiplexer —
view and drive coding agents from a phone browser,
backed by herdr's persistent PTY sessions and its semantic agent states
(idle / working / blocked / done).

**[Watch the 40-second desktop demo →](docs/demos/desktop-browser.md)** — an
agent restyling an app while you watch the real page repaint beside it.

https://github.com/user-attachments/assets/7062da6d-f65e-45e7-a695-1d6bbe116a03

**Every demo, one page each: [docs/demos.md](docs/demos.md)** ·
Agent-to-agent coordination: [docs/agent-coordination.md](docs/agent-coordination.md)

## What you get

- **Live terminal view** of any herdr pane, rendered as native DOM rows at a
  phone-readable size. Rows wrap locally in the browser, so opening the phone
  no longer changes the desktop terminal's PTY width.
- **Agent-status tabs** — herdr's killer feature, front and center: one tab
  per pane with a colored state dot (working / blocked / done / idle),
  sorted by attention.
- **Attention queue**: blocked agents raise an in-app toast and a bell chip
  cycles through everything that needs you. "Done while you weren't looking"
  stays unseen until you view it.
- **Smooth scrollback** — history is prefetched above the live screen in one
  scroll container; swiping into the past is plain native scrolling.
- **Quick keys + input** — Esc, Tab, ⇧Tab, Ctrl-C, arrows, Enter; text
  submits atomically via herdr's `agent.prompt` (no half-pasted prompts).
- **Directory picker** — `📁 cd` finds projects by zoxide frecency, git repos
  and open panes, so you never type a path on a phone.
- **New Codex sessions** — create a pane in a selected project with `codex` as
  the default command; the command remains configurable for aliases and flags.
- **Cross-machine workspaces** — add explicit Tailscale/SSH hosts in Settings;
  [`herdr-mirror`](https://github.com/nikok6/herdr-mirror) brings their live
  Herdr workspaces into the same session list.
- **Local web preview** — open a discovered dev-server port or tap a localhost
  URL in agent output.

## Local web preview

The bridge reverse-proxies a local dev server under
this same origin and shows it in an iframe, so you get the **real page** —
selectable text, native pinch-zoom and momentum scroll, a real keyboard,
forms and file pickers. Bandwidth is the app's own assets, not JPEG frames
of them. Two side effects worth having: your plain-HTTP dev server inherits
the bridge's HTTPS, and no dev port needs its own tunnel. Ports are
discovered automatically on Linux and macOS and ranked dev-server-first. Any
`http://localhost:PORT` in agent output is also a tap target.

Demos: [desktop, side by side](docs/demos/desktop-browser.md) ·
[preview on a phone](docs/demos/preview-tap.md).

## Install

### One-command RC setup

With Herdr running and Tailscale installed and signed in, this installs the RC
and herdr-mirror plugins, starts the bridge, configures a private Tailscale
Serve route, and prints the phone URL:

```bash
curl -fsSL https://raw.githubusercontent.com/Hope7Happiness/herdr-web/master/scripts/install-rc.sh | bash
```

The operation is idempotent: run it again to update or repair the setup. It
refuses to replace an unrelated Tailscale Serve or Funnel listener.

### As a herdr plugin

```bash
herdr plugin install Hope7Happiness/herdr-web
```

The plugin's startup hook launches the bridge on `http://127.0.0.1:7930`
whenever herdr starts. From Herdr's plugin actions, choose **Set up phone RC
with Tailscale** to perform the remaining setup with one click.

### Standalone

```bash
git clone https://github.com/Hope7Happiness/herdr-web
cd herdr-web && npm install
node server.js        # http://127.0.0.1:7930
```

Requires Node 18+ and a running (or startable) herdr ≥ 0.7. `node-pty` is only
used by the optional legacy shared-resize mode; independent mode does not need
it.

## Reaching it from your phone

The server deliberately binds `127.0.0.1` only — **it grants full terminal
control of every pane with no auth**. Expose it through something that
handles transport security for you:

- **Tailscale** (recommended): use the lifecycle commands below.
- Any authenticated reverse proxy works the same way.
- `HERDR_WEB_BIND=0.0.0.0` exists if you really know what you're doing.

### Tailscale quick start

Install Tailscale on both the Herdr computer and phone, and sign both into the
same tailnet. Then, from this repository:

```bash
npm run tailscale:serve
```

This command starts herdr-web if needed, creates a **private, tailnet-only**
HTTPS listener on port `17930`, and prints the phone URL:

```text
https://<machine>.<tailnet>.ts.net:17930
```

The helper supports Linux and both macOS CLI locations. It never enables
Tailscale Funnel and never resets unrelated Serve routes.

```bash
npm run tailscale:status  # Tailscale, Serve, bridge, and phone URL
npm run tailscale:doctor  # versions and connectivity diagnostics
npm run tailscale:off     # remove only the :17930 HTTPS listener
```

As a Herdr plugin, the same operations appear as `Tailscale Serve`,
`Tailscale status`, and `Tailscale stop` actions.

To choose another private HTTPS port:

```bash
HERDR_WEB_TAILSCALE_HTTPS_PORT=443 npm run tailscale:serve
```

Tailscale Serve access is governed by your tailnet ACLs. Restrict this device
and port to the people/devices that should have full shell control. Do not use
Funnel for herdr-web.

### Cross-machine workspaces

Install Herdr on each computer and make sure ordinary, non-interactive SSH
works over its Tailscale name:

```bash
ssh rtx5090 herdr status server --json
```

Then open RC Settings and enter `rtx5090` (or several comma-separated SSH
targets) under **Remote Herdr hosts**. Saving installs herdr-mirror if needed,
writes its host configuration, and starts it. Remote workspaces and agents then
appear in RC's existing session list; input uses mirror's normal writable
session stream.

RC deliberately does not scan the tailnet. It only connects to hosts you name.
Its generated mirror config uses `always_control = false`, so merely opening a
remote pane from the phone does not resize that computer's PTY, and
`close_remote_on_local_close = false`, so closing a local mirror cannot kill a
remote agent. If `hosts.toml` already exists and was not created by RC, RC
leaves it untouched and reports the conflict.

This path is OpenSSH **over** Tailscale, not an SSH tunnel instead of
Tailscale: WireGuard/MagicDNS supplies the private network and stable machine
identity, while SSH supplies the authenticated process transport expected by
herdr-mirror. A separate raw TCP Serve/Service endpoint is not required.

### Reverse proxies and allowed hosts

Loopback hosts and `*.ts.net` hosts work without configuration. A custom
authenticated reverse proxy must preserve its original `Host` header, or be
listed explicitly:

```bash
HERDR_WEB_ALLOWED_HOSTS=herdr.example.com \
HERDR_WEB_ALLOWED_ORIGINS=https://herdr.example.com \
node server.js
```

WebSocket connections require a same-origin browser request. This prevents an
untrusted website open in your browser from silently controlling Herdr through
the local bridge.

## How it works

```
 phone browser
   │ ▲ screens/agent-states (WebSocket) · keys, prompts (WS/HTTP)
   ▼ │
 herdr-web bridge :7930
   server.js ── lib/ansi.js (ANSI → locally wrapped DOM rows)
   │            lib/size-driver.js (optional shared PTY resize)
   ▼  JSON socket (session.snapshot, events, agent.prompt, keys)
 herdr daemon ──▶ PTY panes (Codex agents, …)
```

herdr's server owns the PTYs and already runs a full terminal emulator, so
there is **no xterm and no escape-sequence parsing pipeline here**: the
bridge polls `pane.read {source: "visible", format: "ansi"}` for the pane
you're viewing (300 ms, plus `pane.scroll_changed` events for snappiness),
parses the SGR-only styled lines into spans (~100 lines of code), and ships
them over a WebSocket. Background panes cost nothing — their status dots
come from pushed `pane.agent_status_changed` events.

### Independent sizing

A terminal process has one real PTY geometry, so two clients cannot get native
TUI reflow at different widths from the same process. By default, herdr-web
leaves that geometry entirely under the desktop Herdr client and wraps the
rendered rows locally in each browser. Phone rotation therefore never resizes
the computer terminal.

The old native-reflow approach remains available as an explicit compatibility
mode:

```bash
HERDR_WEB_SHARED_RUNTIME_RESIZE=true node server.js
```

It makes the shared PTY follow the browser and will consequently affect an
attached desktop client, so it should not normally be enabled.

The full empirical API recon that shaped this design:
[docs/socket-api-notes.md](docs/socket-api-notes.md).

## Configuration

| Env var | Default | |
|---|---|---|
| `HERDR_WEB_PORT` | `7930` | HTTP/WS port |
| `HERDR_WEB_BIND` | `127.0.0.1` | Listen address |
| `HERDR_SOCKET_PATH` | `~/.config/herdr/herdr.sock` | herdr API socket |
| `HERDR_WEB_CONFIG_DIR` | `~/.config/herdr-web` | Where `settings.json` lives |
| `HERDR_WEB_TAILSCALE_HTTPS_PORT` | `17930` | Private Tailscale Serve HTTPS port |
| `HERDR_WEB_ALLOWED_HOSTS` | empty | Extra comma-separated reverse-proxy hostnames |
| `HERDR_WEB_ALLOWED_ORIGINS` | empty | Extra comma-separated trusted browser origins |
| `HERDR_WEB_SHARED_RUNTIME_RESIZE` | `false` | Opt into shared PTY resizing; also affects desktop clients |

Settings (the ⚙ button) are stored server-side in `settings.json`, so your
phone and your laptop agree. The one that matters most is **agent command**:
it is typed into the pane's *interactive shell* when a session starts an
agent, so Codex aliases and flags work just like a direct shell launch.

Recommended herdr config (`~/.config/herdr/config.toml`) so headless panes
get full width:

```toml
[ui]
sidebar_start_collapsed = true
sidebar_collapsed_mode = "hidden"
```

## Status

Beta-quality, not yet a security boundary or a full desktop replacement. This
fork is verified against herdr 0.8.0 (protocol 19) and Tailscale 1.98.5 on
macOS, including real HTTPS/WSS access through Tailscale Serve and a 414×896
independent-width mobile smoke test. Expect herdr's pre-1.0 API to move. See the
[maintenance audit](docs/maintenance-audit.md) for known gaps and evidence.

## License

MIT
