---
name: herdr-rc-remote
description: Use alongside the Herdr skill whenever the target is a remote Herdr machine or mirrored pane, including a Tailscale/SSH host, a remote-host-prefixed workspace, or a pane whose cwd ends in .mirror-pane. Enables phone RC; connects or disconnects remote machines; and inspects, reads, prompts, waits on, or controls connected remote panes through the herdr-remote companion CLI. Do not use the base Herdr skill alone for a mirrored pane.
---

# Herdr RC and Remote

Load this skill in addition to the base `herdr` skill whenever the user's target
is remote or mirrored, even when the host is already connected and the request
only says to inspect, message, coordinate with, or wait for its agent.

Use the deterministic companion CLI installed with this skill. Do not edit mirror TOML or RC settings directly.

```bash
rc_skill_root="${CODEX_HOME:-$HOME/.codex}/skills/herdr-rc-remote"
remote_cli="$rc_skill_root/scripts/herdr-remote"
```

Require `HERDR_ENV=1`. If the helper is absent, tell the user to reinstall or update `hope7happiness.herdr-web`; do not reconstruct its configuration manually.

## Map the user's intent

- Enable, open, or start phone remote control: run `"$remote_cli" enable` and return the reported private HTTPS URL.
- Check the RC URL or diagnose availability: run `"$remote_cli" status`.
- Connect or add a remote Herdr panel/workspace: run `"$remote_cli" connect <exact-ssh-target>`.
- List configured remote machines: run `"$remote_cli" list`.
- Disconnect a remote machine only when explicitly requested: run `"$remote_cli" disconnect <exact-ssh-target>`.

Treat “panel” as the remote machine's Herdr workspaces and panes appearing in RC's ordinary agent list. Do not use `herdr --remote <target>` for RC/mirror control: that attaches a separate remote TUI and does not add the target to RC's unified pane list. Use native `--remote` only when the user explicitly asks to attach a separate remote Herdr TUI.

## Operate Remote Panes

After a host is connected, use `"$remote_cli"` for every operation on that remote
target. Do not call native `herdr agent` or `herdr pane` commands for a remote
pane, and do not execute `ssh <target> herdr ...`. The companion CLI uses the
local Herdr socket under the hood, while the mirror daemon owns the background
SSH transport.

Discover remote agents and use their current IDs:

```bash
"$remote_cli" agent list
"$remote_cli" agent get <mirror-pane-id>
"$remote_cli" agent read <mirror-pane-id> --source recent-unwrapped --lines 120
# If it has no recognized agent:
"$remote_cli" pane read <mirror-pane-id> --source recent-unwrapped --lines 120
```

The companion refuses non-mirror panes. If the remote workspace is absent,
diagnose or reconnect with `"$remote_cli"`, rather than bypassing it with
per-operation SSH.

For a normal prompt, use the guarded shortcut. It submits text, confirms a new
local echo, and then sends Enter:

```bash
"$remote_cli" agent prompt <mirror-pane-id> "<message>"
```

For deliberate low-level input, use the companion pane commands:

```bash
"$remote_cli" pane send-text <mirror-pane-id> "<message>"
"$remote_cli" pane wait-output <mirror-pane-id> --match "<message>" --source recent --lines 2000 --timeout 5000
"$remote_cli" pane send-keys <mirror-pane-id> enter
```

For waits on a mirror pane, use the companion's level-based wait instead of
native `agent.wait`:

```bash
"$remote_cli" agent wait <mirror-pane-id> --until idle --timeout 30000
```

The companion polls local `agent.get`, pins the local terminal identity, requires
a `.mirror-pane` cwd, and never opens another SSH connection. Always use a
finite timeout and re-read the pane after a timeout. An error from native
`agent prompt` or `agent wait` does not authorize direct SSH fallback.

## Connection rules

- Use only the host or SSH alias the user named. Never scan the tailnet.
- Accept a Tailscale MagicDNS name, an SSH config alias, or `user@host`. Require an SSH config alias for custom ports or options.
- Let the helper perform non-interactive SSH and remote Herdr preflight before changing RC configuration.
- Do not install keys, accept host keys, request a password, edit SSH config, start the remote Herdr server, or change tailnet ACLs without separate user direction.
- If preflight fails, report the helper's actionable error and stop. Do not add a host that was not verified.
- Connection is idempotent. Reconnecting an existing target is safe and refreshes mirror configuration.
- Report the target, remote Herdr verification, and RC/mirror result. Do not claim success from SSH reachability alone.

The mirror executable runs on the RC machine. The remote host only needs a protocol-compatible Herdr reachable through non-interactive SSH; its OS and CPU do not need to match the RC machine.
