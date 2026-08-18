# Fork maintenance audit

Audit date: 2026-08-18

## Verdict

The upstream project is a strong prototype and a useful base for continued
development. Its core terminal, agent-state, prompt, preview, cast, and PWA
flows work. It is not production-mature yet: the code was young, had no CI or
unit tests, delegated all authorization to the network perimeter, and had
macOS/plugin-path failures in its phone-width driver.

This fork is best described as **beta-quality for a trusted personal
tailnet**. It should not be exposed to the public internet or treated as a
multi-user service.

## Verified in this fork

- Herdr 0.8.0, protocol 19: snapshot, events, pane reads, and WebSocket fanout.
- Node 26.7.0 on macOS arm64; production dependency audit reports no known
  vulnerabilities at the audit date.
- 414×896 Playwright smoke test: session tabs, live terminal, 154 rendered
  rows, controls reachable without page scrolling, and 11px phone text.
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
- The hidden client controls global runtime dimensions. Multiple simultaneous
  browser sizes and an attached desktop client need an explicit arbitration
  policy.
- Herdr's protocol is pre-1.0. Compatibility tests should cover every supported
  Herdr release before upgrading the minimum version.
- Preview and Chrome Cast intentionally grant broad control over trusted local
  development services. They need a separate threat-model pass before any
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
4. Define size ownership for simultaneous phone and desktop clients.
5. Add optional application authentication for non-Tailscale deployments.
