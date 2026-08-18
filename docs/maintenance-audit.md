# Fork maintenance audit

Audit date: 2026-08-18

## Verdict

The upstream project is a strong prototype and a useful base for continued
development. Its core terminal, agent-state, prompt, and preview flows work.
It is not production-mature yet: the code was young, had no CI or
unit tests, delegated all authorization to the network perimeter, and had
macOS/plugin-path failures in its phone-width driver.

This fork is best described as **beta-quality for a trusted personal
tailnet**. It should not be exposed to the public internet or treated as a
multi-user service.

## Verified in this fork

- Herdr 0.8.0, protocol 19: snapshot, events, pane reads, and WebSocket fanout.
- Node 26.7.0 on macOS arm64; production dependency audit reports no known
  vulnerabilities at the audit date.
- 414×896 Playwright smoke test: session tabs, live terminal, controls
  reachable without page scrolling, 11px phone text, and rendered rows filling
  406px of the 414px viewport after padding.
- Independent sizing test: opening the mobile view leaves five live pane grids
  unchanged at 170–172 source columns while the browser wraps locally.
- Minimal Codex-first UI: Claude-specific actions, font controls, browser Cast,
  and PWA assets are intentionally removed; macOS Preview discovery uses lsof.
- Tailscale 1.98.5: private HTTPS Serve on `:17930`, HTTPS 200, WSS session
  connection, status/doctor/off/restart lifecycle, and preservation of an
  unrelated Funnel route on `:443`.
- Cross-site WebSocket attempts receive HTTP 403; invalid Host headers receive
  HTTP 421.
- Plugin bridge survives its one-shot startup hook as a detached process and
  shuts down cleanly.

## Issues fixed from upstream

- Added same-origin WebSocket and allowed-host validation.
- Added browser security headers and removed an avoidable `innerHTML` sink.
- Added Tailscale discovery, Serve lifecycle, conflict detection, diagnostics,
  and Herdr plugin actions.
- Replaced the macOS-incompatible `setsid` startup path with Node detached
  process launch.
- Repaired the missing executable bit in node-pty's macOS `spawn-helper` npm
  artifact.
- Removed inherited Herdr pane identity from the hidden sizing client so it is
  not rejected as a nested session.
- Added unit tests, syntax checks, lockfile metadata repair, and CI for Node 20
  and 22.

## Remaining gaps

- Tailscale ACLs are the authorization layer. There is no application account,
  role model, second factor, or per-pane permission.
- The UI is a single large HTML file, which will become harder to maintain as
  desktop-parity controls are added.
- Terminal updates poll the visible pane every 300 ms instead of consuming a
  native screen-diff stream.
- Native TUI reflow still requires shared PTY resizing and therefore cannot be
  independent across clients. Default local wrapping avoids that tradeoff;
  legacy shared resizing remains opt-in.
- Herdr's protocol is pre-1.0. Compatibility tests should cover every supported
  Herdr release before upgrading the minimum version.
- Preview intentionally grants broad control over trusted local development
  services. It needs a separate threat-model pass before any
  multi-user deployment.
- Workspace/tab/pane creation and layout controls do not yet match the desktop
  TUI feature-for-feature.

## Recommended next work

1. Split the client into modules and add browser-level tests for prompts,
   navigation, reconnects, and notifications.
2. Add a connection/session health view that shows Herdr protocol, Tailscale
   identity, and reconnect state.
3. Add workspace, tab, pane layout, and lifecycle controls through the public
   Herdr API.
4. Improve local wrapping for complex full-screen TUI chrome and tables.
5. Add optional application authentication for non-Tailscale deployments.
