---
name: herdr-rc-remote
description: Use alongside the Herdr skill whenever the target is a remote Herdr machine or mirrored pane, including a Tailscale/SSH host, a remote-host-prefixed workspace, or a pane whose cwd ends in .mirror-pane. Enables phone RC; connects or disconnects remote machines; and inspects, reads, prompts, waits on, or controls connected remote panes through the local Herdr CLI. Do not use the base Herdr skill alone for a mirrored pane.
---

# Herdr RC and Remote

Load this skill in addition to the base `herdr` skill whenever the user's target
is remote or mirrored, even when the host is already connected and the request
only says to inspect, message, coordinate with, or wait for its agent.

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

## Operate connected panes locally

After a host is connected, use the local Herdr CLI described by the installed `herdr` skill for routine discovery, status, reads, prompts, and waits. Do not execute `ssh <target> herdr ...` for these operations. The mirror daemon owns the background SSH transport and exposes each remote terminal as an ordinary local pane.

Discover the current IDs instead of retaining an ID from an earlier connection:

```bash
herdr workspace list
herdr pane list --workspace <mirror-workspace-id>
```

Identify the mirror workspace by its remote-host-prefixed label and confirm its pane has a `.mirror-pane` cwd. Then use its local pane ID:

```bash
herdr agent get <mirror-pane-id>
herdr agent read <mirror-pane-id> --source recent-unwrapped --lines 120
# If it has no recognized agent:
herdr pane read <mirror-pane-id> --source recent-unwrapped --lines 120
```

Use local `herdr agent` or `herdr pane` control commands against that mirror pane ID when the user requests interaction. Reserve direct SSH for initial connection preflight or explicit transport diagnosis. If the mirror workspace is absent, diagnose or reconnect with the helper rather than bypassing it with per-operation SSH.

A mirror pane reports the remote agent but its local foreground process is the
mirror relay. Therefore `herdr agent prompt <mirror-pane-id>` may return
`agent_not_ready`; this is expected and is not a reason to use SSH. Submit
through the local pane in this exact order:

```bash
herdr pane send-text <mirror-pane-id> "<message>"
# Wait until the new text is visible in a local pane read before sending Enter.
herdr pane wait-output <mirror-pane-id> --match "<message>" --source recent --lines 2000 --timeout 5000
herdr pane send-keys <mirror-pane-id> enter
```

Then observe the same local mirror pane with `herdr agent get`, `herdr agent
wait`, and `herdr agent read` (or `herdr pane read` when agent reads are not
available). If the exact message already appears in scrollback, confirm a new
echo with repeated local reads before sending Enter. An `agent_not_ready` error
from `agent prompt` does not authorize direct SSH fallback.

## Connection rules

- Use only the host or SSH alias the user named. Never scan the tailnet.
- Accept a Tailscale MagicDNS name, an SSH config alias, or `user@host`. Require an SSH config alias for custom ports or options.
- Let the helper perform non-interactive SSH and remote Herdr preflight before changing RC configuration.
- Do not install keys, accept host keys, request a password, edit SSH config, start the remote Herdr server, or change tailnet ACLs without separate user direction.
- If preflight fails, report the helper's actionable error and stop. Do not add a host that was not verified.
- Connection is idempotent. Reconnecting an existing target is safe and refreshes mirror configuration.
- Report the target, remote Herdr verification, and RC/mirror result. Do not claim success from SSH reachability alone.

The mirror executable runs on the RC machine. The remote host only needs a protocol-compatible Herdr reachable through non-interactive SSH; its OS and CPU do not need to match the RC machine.
