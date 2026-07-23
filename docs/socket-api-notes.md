# herdr socket API — empirical recon notes (Phase 0)

Tested against **herdr 0.7.5, protocol 17** on 2026-07-23, headless server
(`herdr server`), default session. Source cloned at
`~/projects/github/ogulcancelik/herdr`.

## TL;DR for the bridge

- Integration surface: **JSON socket API only** (`~/.config/herdr/herdr.sock`,
  newline-delimited JSON, one request per line, subscriptions keep the
  connection open).
- **Rendering strategy (Phase 2 fork resolved): native-DOM rows, no xterm
  anywhere.** `pane.read {source: "visible", format: "ansi"}` returns the
  server-maintained screen matrix as lines containing **only SGR codes**
  (`ESC[…m`) and `\r\n` — no cursor movement escapes, even for alt-screen TUIs
  (verified with htop and Claude Code). A small server-side per-line SGR→spans
  parser in Node is all that's needed.
- Live view = **poll the watched pane + push events for everything else**.
  There is no raw output stream/subscription in the socket API (see below).
- Agent semantic state is pushed in real time via
  `pane.agent_status_changed` subscription (verified: idle → working → idle
  round-trip with a real Claude Code session, events arrive <1s).

## The two sockets (important)

| Socket | Protocol | Use |
| --- | --- | --- |
| `~/.config/herdr/herdr.sock` | newline-delimited JSON, documented, versioned (protocol 17) | **ours** |
| `~/.config/herdr/herdr-client.sock` | `[u32LE len][bincode]` frames, Rust-internal, undocumented | herdr's own TUI client. NOT a sane surface for Node |

The client socket carries the interesting-but-unreachable stuff: semantic
`FrameData` grids, `ObserveTerminal` (read-only per-pane observe mode),
`ControlTerminal`. All bincode-serialized Rust enums — skip for v0. If herdr
ever documents/stabilizes it, it would give us push frames at observer-chosen
size.

Named sessions get their own socket pair under
`~/.config/herdr/sessions/<name>/`.

## Reading pane content

`pane.read` params: `pane_id`, `source` (`visible` | `recent` |
`recent_unwrapped` | `detection`), `format` (`text` | `ansi`), `lines`,
`strip_ansi` (default true; irrelevant when `format: "ansi"`).

- `visible` = current screen (viewport). `recent` = scrollback tail
  (`lines` caps it), `recent_unwrapped` ignores soft wrap.
- Result: `{pane_id, workspace_id, tab_id, source, format, text, revision, truncated}`.
- ANSI output sample (htop): `^[[0m^[[38;5;6m  0^[[0m^[[1m[^[...` — pure SGR,
  lines joined with `\r\n`. 256-color (`38;5;N`) codes observed; assume
  truecolor (`38;2;r;g;b`) possible too.
- **`revision` is NOT an output counter** — it only bumps on terminal-title
  changes (src/terminal/state.rs:176). Useless for change detection; diff the
  text in Node instead.
- Scrollback for scroll-up UI: `pane.read {source: "recent", lines: N, format: "ansi"}`.
- No cursor position in the read result. (PaneInfo has `scroll` metrics:
  `offset_from_bottom`, `max_offset_from_bottom`, `viewport_rows`.)

## Live output: what exists and what doesn't

- **There is NO output-stream subscription.** The `pane.output_changed` /
  `pane_output_changed` event kind seen in the schema's `EventKind` enum is
  **plugin-event-hook-only** — `events.subscribe` rejects it
  (`unknown variant`). Valid subscription types are exactly:
  `workspace.{created,updated,metadata_updated,renamed,moved,closed,focused}`,
  `worktree.{created,opened,removed}`, `tab.{created,closed,focused,renamed,moved}`,
  `pane.{created,closed,updated,focused,moved,exited,agent_detected,output_matched,agent_status_changed,scroll_changed}`,
  `layout.updated`.
- `pane.output_matched` is **edge-triggered** (fires on not-matching →
  matching transition, `currently_matching` flag in src/api/subscriptions.rs) —
  not usable as a change stream.
- `pane.scroll_changed` **does fire on output** that grows scrollback
  (verified: 40 echo lines → coalesced event with updated scroll metrics).
  It does NOT fire for in-place TUI repaints that don't scroll. Use it as a
  "read now" hint, with the poll as the ground truth.
- `pane.wait_for_output` = one-shot blocking wait for substring/regex, with
  `timeout_ms`. Good for scripting, not streaming.

**Bridge plan:** poll `pane.read visible/ansi` (~250–350ms) for the pane the
phone is actually viewing; skip-if-unchanged diff in Node; `scroll_changed`
subscription triggers an immediate extra read for snappiness. Background panes
get no polling — their status dots come from push events.

## Agent semantic state (the killer feature) — verified working

- Detection is automatic (bundled agent manifests): launched `claude` in a
  pane → within ~10s `agent.list` shows
  `{agent: "claude", agent_status: "idle", terminal_title: "✳ Claude Code", …}`.
- Subscribed `pane.agent_status_changed`, sent a prompt: events pushed
  `working` then `idle` in real time. Event payload:
  `{pane_id, workspace_id, agent, agent_status}` (+ optional title,
  display_agent, state_labels).
- Status values: `idle`, `working`, `blocked`, `done`, `unknown`
  (`done` = idle-and-not-yet-seen).
- `agent_status` also present on every pane/workspace/tab record (rollups) —
  `session.snapshot` alone paints the whole status map.
- `terminal_title` tracks CC's OSC title (e.g. "✳ Acknowledge request") —
  nice free subtitle for the tab bar. `pane.updated` fires when the stripped
  title changes.
- Higher-level agent API exists: `agent.list/get/read/prompt/wait/explain`,
  `agent.prompt` accepts `{wait: {until, timeout_ms}}` in one call.

## Input injection — verified

- `pane.send_text {pane_id, text}` — literal text. A trailing `\n` did execute
  in bash, but for TUIs use explicit keys.
- `pane.send_keys {pane_id, keys: [...]}` — named keys: printables, `enter`,
  `esc`, chords `ctrl+c`, `alt+x`, `shift+tab`, `f1`, `minus`/`plus`. NOT
  `prefix+` binding strings. (`keys: ["enter"]` verified submitting a CC
  prompt.)
- Web-UI plan: text via `send_text`, Enter/Esc/Ctrl-C/arrows via `send_keys`.

## Lifecycle / bootstrap

- `session.snapshot` (= `herdr api snapshot`) — one-time bootstrap:
  workspaces, tabs, panes, agents, layouts + focus ids. Then keep the cache
  fresh from subscriptions. Re-snapshot on reconnect.
- Create: `workspace.create {cwd, label}` → returns workspace + tab +
  root_pane. `pane.split`, `tab.create`, `pane.close`, `workspace.close`.
- `pane.run` (CLI `herdr pane run`) runs a command in a pane;
  `pane.send_text` for typing into whatever is running.
- Server: `herdr server` runs headless and detaches cleanly
  (`setsid herdr server &` verified; `capabilities.detached_server_daemon: true`
  in the `ping` response). Persists session state (`session.json`) across
  restarts. `herdr status` / `ping` for liveness. Bridge should spawn it when
  the socket is dead.

## Terminal size (the one real constraint)

- Headless with no attached TUI client, the shared frame is fixed at
  **80×24** (`MIN_COLS`/`MIN_ROWS`, src/server/headless.rs:222). The pane PTY
  gets frame minus herdr chrome: measured **53×23** with the default sidebar
  (~27 cols of sidebar).
- Frame size follows the *foreground attached client* — attach happens over
  the bincode client socket only, so **the bridge cannot resize the runtime**
  via the JSON API. (`pane.resize` only changes split ratios.)
- Mitigation for v0: config
  `[ui] sidebar_start_collapsed = true`, `sidebar_collapsed_mode = "hidden"`
  → single pane per tab gets ~80×22+. 80 cols is exactly what appcore renders
  on phones anyway.
- If someone attaches a real herdr TUI at a bigger terminal, panes grow —
  reads then reflect that size. The web UI must not assume 80.

## Misc gotchas

- CLI `herdr pane read` prints **plain text**, not the JSON envelope — fine
  for humans; the socket always returns JSON.
- Error shape: `{"id": …, "error": {"code", "message"}}`; subscription errors
  can arrive with `"id": ""`.
- Events on a subscription connection arrive as
  `{"data": {...}, "event": "pane.agent_status_changed"}` lines (no `id`),
  after an initial `{"id", "result": {"type": "subscription_started"}}` ack.
- Processes launched by herdr get `HERDR_SOCKET_PATH`, `HERDR_PANE_ID`, etc.
  injected — an agent inside a pane can self-report state
  (`pane.report_agent`) and metadata (`pane.report_metadata`, display-only
  tokens).
- `agent.wait` pins the pane occupant (replacement processes can't satisfy the
  wait). `ttl_ms`-scoped metadata tokens don't survive server restart.
- Protocol check: `ping` → `{version, protocol, capabilities}`. Handle unknown
  fields gracefully; check `protocol` on bridge startup.
