---
name: herdr-rc-remote
description: Enable, inspect, or troubleshoot Herdr phone remote control over Tailscale Serve, and connect, list, or disconnect remote Herdr panels/workspaces through an explicit Tailscale or SSH host. Use when the user says to enable/open/start Herdr remote control or phone RC, asks for its URL/status, or asks to connect/add/remove a remote Herdr panel, machine, workspace, Tailscale host, MagicDNS name, or SSH target to the unified Herdr RC pane list.
---

# Herdr RC and Remote

Use the deterministic helper installed with this skill. Do not edit mirror TOML or RC settings directly.

```bash
rc_skill_root="${CODEX_HOME:-$HOME/.codex}/skills/herdr-rc-remote"
node "$rc_skill_root/scripts/herdr-rc.mjs" <command> [target]
```

Require `HERDR_ENV=1`. If the helper is absent, tell the user to reinstall or update `hope7happiness.herdr-web`; do not reconstruct its configuration manually.

## Map the user's intent

- Enable, open, or start phone remote control: run `enable` and return the reported private HTTPS URL.
- Check the RC URL or diagnose availability: run `status`.
- Connect or add a remote Herdr panel/workspace: run `connect <exact-ssh-target>`.
- List configured remote machines: run `list`.
- Disconnect a remote machine only when explicitly requested: run `disconnect <exact-ssh-target>`.

Treat “panel” as the remote machine's Herdr workspaces and panes appearing in RC's ordinary agent list. Do not use `herdr --remote <target>` for this intent: that attaches a separate remote TUI and does not add the target to RC's unified pane list. Use native `--remote` only when the user explicitly asks to attach a remote Herdr TUI.

## Connection rules

- Use only the host or SSH alias the user named. Never scan the tailnet.
- Accept a Tailscale MagicDNS name, an SSH config alias, or `user@host`. Require an SSH config alias for custom ports or options.
- Let the helper perform non-interactive SSH and remote Herdr preflight before changing RC configuration.
- Do not install keys, accept host keys, request a password, edit SSH config, start the remote Herdr server, or change tailnet ACLs without separate user direction.
- If preflight fails, report the helper's actionable error and stop. Do not add a host that was not verified.
- Connection is idempotent. Reconnecting an existing target is safe and refreshes mirror configuration.
- Report the target, remote Herdr verification, and RC/mirror result. Do not claim success from SSH reachability alone.

The mirror executable runs on the RC machine. The remote host only needs a protocol-compatible Herdr reachable through non-interactive SSH; its OS and CPU do not need to match the RC machine.
