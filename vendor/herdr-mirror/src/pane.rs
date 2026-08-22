// herdr-mirror pane wrapper (data plane).
//
// Runs inside a local herdr pane and shows a remote herdr pane's terminal,
// live, over ssh. Read-only observe by default; escalates to a writable
// control session when the user types and releases back to observe.
//
//   herdr-mirror pane <ssh-target> <pane-target> [options]
//
// options:
//   --remote-bin PATH   remote herdr binary (default: PATH, then ~/.local/bin/herdr)
//   --cols N --rows N   observe request size (default 240x72; must be >= the
//                       remote PTY size or the server clips bottom rows away)
//   --dump              headless mode: print plain-text screen per frame
//   --session NAME      remote named session (passed as --session to herdr)
//   --control-idle N    auto-release control after N seconds idle (default 3600)
//   --always-control    start and stay in control: writable, no idle release,
//                       and sized to the local pane so it fills
//
// SSH hosts normally use one host-level forwarded Herdr client socket. Each
// pane then starts a local `herdr terminal session` client, so pane count does
// not multiply SSH processes. Direct ssh remains a compatibility fallback when
// the remote client socket cannot be forwarded.
//
// One owner of all state, message-driven: frames, keystrokes, timers, and
// ssh-child exits arrive on one channel; a session generation number tags
// every message so stale ones are dropped.

use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::Deserialize;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::signal::unix::{signal, SignalKind};
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::util::{err, Result};
use crate::grid::{Grid, Renderer};
use crate::predict::Predictor;

// ---------------------------------------------------------------------------
// args

#[derive(Debug, Clone)]
pub struct Args {
    pub ssh_target: String,
    pub pane_target: String,
    /// Configured remote herdr path. `None` = auto-resolve on the remote
    /// (PATH, then `~/.local/bin/herdr`). See `config::remote_bin_expr`.
    pub remote_bin: Option<String>,
    pub cols: usize,
    pub rows: usize,
    pub dump: bool,
    pub session: Option<String>,
    /// auto-release control after this much input idle; 0 disables
    pub control_idle_secs: u64,
    /// start and stay in control: writable, no idle release, and sized to the
    /// local pane so it fills. Set by the daemon from per-host config.
    pub always_control: bool,
    /// daemon's ssh ControlMaster socket for this host; foreground polls reuse it
    /// (`ssh -S <path>`) to skip a handshake. None → polls connect directly.
    ///
    pub ctl_path: Option<String>,
    /// host-level forwarded Herdr client socket. When present, terminal session
    /// clients connect through it instead of spawning a per-pane ssh process.
    pub client_socket: Option<String>,
    /// container to exec into instead of ssh. `None` = ssh host.
    pub container: Option<ContainerArg>,
}

/// How the pane process should reach its container. The daemon passes a *ref*,
/// not a resolved id: the pane may outlive a rebuild, and ids change while the
/// folder label does not.
#[derive(Debug, Clone)]
pub struct ContainerArg {
    pub kind: crate::config::HostKind,
    pub docker_bin: String,
}

pub fn parse_args(argv: &[String]) -> Result<Args> {
    let mut args = Args {
        ssh_target: String::new(),
        pane_target: String::new(),
        remote_bin: None,
        cols: 240,
        rows: 72,
        dump: false,
        session: None,
        control_idle_secs: 3600,
        always_control: false,
        ctl_path: None,
        client_socket: None,
        container: None,
    };
    let mut container_name: Option<String> = None;
    let mut container_folder: Option<String> = None;
    let mut docker_bin = "docker".to_string();
    let mut positional: Vec<String> = Vec::new();
    let mut it = argv.iter();
    while let Some(a) = it.next() {
        let mut next = |flag: &str| -> Result<String> {
            it.next().cloned().ok_or_else(|| err(format!("{flag} needs a value")))
        };
        match a.as_str() {
            "--remote-bin" => args.remote_bin = Some(next("--remote-bin")?),
            "--cols" => {
                args.cols = next("--cols")?.parse().map_err(|_| err("--cols must be a number"))?;
            }
            "--rows" => {
                args.rows = next("--rows")?.parse().map_err(|_| err("--rows must be a number"))?;
            }
            "--session" => args.session = Some(next("--session")?),
            "--control-idle" => {
                args.control_idle_secs =
                    next("--control-idle")?.parse().map_err(|_| err("--control-idle must be a number"))?
            }
            "--always-control" => args.always_control = true,
            "--ctl-path" => args.ctl_path = Some(next("--ctl-path")?),
            "--client-sock" => args.client_socket = Some(next("--client-sock")?),
            "--container" => container_name = Some(next("--container")?),
            "--container-folder" => container_folder = Some(next("--container-folder")?),
            "--docker-bin" => docker_bin = next("--docker-bin")?,
            "--dump" => args.dump = true,
            other if other.starts_with('-') => return Err(err(format!("unknown option: {other}"))),
            other => positional.push(other.to_string()),
        }
    }
    if positional.len() != 2 {
        return Err(err(
            "usage: herdr-mirror pane <ssh-target> <pane-target> [--remote-bin PATH] [--cols N --rows N] [--dump]",
        ));
    }
    args.container = match (container_name, container_folder) {
        (Some(_), Some(_)) => return Err(err("--container and --container-folder are exclusive")),
        (Some(n), None) => {
            Some(ContainerArg { kind: crate::config::HostKind::DockerContainer(n), docker_bin })
        }
        (None, Some(f)) => {
            Some(ContainerArg { kind: crate::config::HostKind::DockerFolder(f), docker_bin })
        }
        (None, None) => None,
    };
    args.ssh_target = positional.remove(0);
    args.pane_target = positional.remove(0);
    Ok(args)
}

// ---------------------------------------------------------------------------
// remote session: one ssh child running observe or control

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Observe,
    Control,
}

impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Mode::Observe => "observe",
            Mode::Control => "control",
        }
    }
}

#[derive(Debug, Deserialize)]
struct Frame {
    #[serde(rename = "type")]
    kind: String,
    seq: Option<u64>,
    full: Option<bool>,
    width: Option<usize>,
    height: Option<usize>,
    bytes: Option<String>,
    reason: Option<String>,
}

enum Msg {
    Frame { gen: u64, frame: Frame },
    SessionExit { gen: u64, mode: Mode, reason: String, uptime: Duration },
    Stdin(Vec<u8>),
    /// result of a background foreground-process poll: Some(true)=shell,
    /// Some(false)=TUI, None=poll failed (keep last value)
    Foreground(Option<bool>),
}

struct Session {
    gen: u64,
    mode: Mode,
    pid: i32,
    stdin: ChildStdin,
    cols: usize,
    rows: usize,
}

/// POSIX single-quote: an embedded ' can't break the remote shell parse.
pub(crate) fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn spawn_session(args: &Args, mode: Mode, cols: usize, rows: usize, gen: u64, tx: mpsc::Sender<Msg>) -> Result<Session> {
    let session_flag = args
        .session
        .as_ref()
        .map(|s| format!(" --session {}", sh_quote(s)))
        .unwrap_or_default();
    // Configured paths stay unquoted so remote-shell ~ expands; auto mode is an
    // `sh -c` resolver that takes the trailing words as "$@" (see
    // config::remote_bin_expr).
    let bin = crate::config::remote_bin_expr(args.remote_bin.as_deref());
    let cmd = format!(
        "exec {}{} terminal session {} {} --cols {} --rows {}",
        bin,
        session_flag,
        mode.as_str(),
        sh_quote(&args.pane_target),
        cols,
        rows
    );
    // ssh and docker differ only in how the command is carried; the streaming
    // contract (piped stdio, herdr's frames on stdout) is identical
    let mut builder = match (&args.container, &args.client_socket) {
        (None, Some(client_socket)) => {
            let bin = std::env::var("HERDR_BIN_PATH").unwrap_or_else(|_| "herdr".to_string());
            let mut c = tokio::process::Command::new(bin);
            c.args(["terminal", "session", mode.as_str()])
                .arg(&args.pane_target)
                .args(["--cols", &cols.to_string(), "--rows", &rows.to_string()])
                .env("HERDR_CLIENT_SOCKET_PATH", client_socket)
                // A pane inherits the local Herdr API socket. Terminal session
                // must use the forwarded remote client socket instead.
                .env_remove("HERDR_SOCKET_PATH");
            c
        }
        (None, None) => {
            let mut c = tokio::process::Command::new("ssh");
            c.args(crate::remote::SSH_COMMON_OPTS).arg(&args.ssh_target).arg(cmd);
            c
        }
        (Some(ct), _) => {
            // resolve per spawn so a rebuilt container is picked up on
            // reconnect. Bounded: this runs on the pane's single-threaded
            // runtime, so a wedged Docker daemon must not be able to freeze
            // input, rendering or signal handling.
            let id = crate::docker::resolve_blocking(
                &ct.docker_bin,
                &ct.kind,
                Duration::from_secs(5),
            )?;
            let mut c = tokio::process::Command::new(&ct.docker_bin);
            // `sh -c` not `-lc`: match ssh's non-login remote shell
            c.args(["exec", "-i", &id, "sh", "-c", &cmd]);
            c
        }
    };
    let mut child = builder
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let pid = child.id().map(|p| p as i32).unwrap_or(0);
    let stdin = child.stdin.take().ok_or_else(|| err("no child stdin"))?;
    let stdout = child.stdout.take().ok_or_else(|| err("no child stdout"))?;
    let stderr = child.stderr.take().ok_or_else(|| err("no child stderr"))?;
    let started = Instant::now();

    tokio::spawn(async move {
        // ssh errors arrive on stderr; the server's failure reason arrives as
        // a terminal.closed frame on STDOUT — capture both
        let err_tail: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
        let err_tail2 = err_tail.clone();
        let stderr_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                let mut buf = err_tail2.lock().unwrap();
                buf.push_str(&l);
                buf.push('\n');
                if buf.len() > 400 {
                    let tail: String = buf.chars().rev().take(400).collect::<Vec<_>>().into_iter().rev().collect();
                    *buf = tail;
                }
            }
        });
        let mut close_reason = String::new();
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(frame) = serde_json::from_str::<Frame>(&line) else { continue };
            if frame.kind == "terminal.closed" {
                if let Some(r) = &frame.reason {
                    close_reason = r.clone();
                }
            }
            if tx.send(Msg::Frame { gen, frame }).await.is_err() {
                break;
            }
        }
        let _ = child.wait().await;
        stderr_task.abort();
        let tail = err_tail.lock().unwrap().trim().to_string();
        let reason = if close_reason.is_empty() { tail } else { close_reason };
        let _ = tx.send(Msg::SessionExit { gen, mode, reason, uptime: started.elapsed() }).await;
    });

    Ok(Session { gen, mode, pid, stdin, cols, rows })
}

// ---------------------------------------------------------------------------
// terminal plumbing

/// The layout herdr renders when a server has NO client attached: MIN_COLS x
/// MIN_ROWS from its headless server. Not a minimum — an attached client
/// smaller than this gets its real size — it is specifically the placeholder
/// used when nobody is watching.
///
/// Every derivation from it subtracts: sidebar, tab bar, splits, gaps, the
/// scrollbar gutter. So a pane born under that layout cannot EXCEED it on
/// either axis, which is what makes this a sound upper bound rather than a
/// shape to match. Shape matching is the trap: a phone lays out to the same
/// rectangle as the placeholder.
const HERDR_NO_CLIENT_LAYOUT: (usize, usize) = (80, 24);

/// Could this pane's size have come from a layout nobody is watching?
///
/// Strictly larger on either axis is provably a real viewport. `>` not `>=`:
/// herdr spawns restored panes at exactly 24x80, so `>=` would trust a
/// placeholder.
///
/// Consulted at birth to pick the initial mode. Deliberately NOT consulted on
/// the promotion path: a resize is taken as evidence of a client, which holds
/// in practice but is empirical rather than structural — herdr has one
/// clientless resize path (its first virtual render), so a pane created in the
/// instant before that render could in principle promote on a placeholder
/// resize. It self-heals the moment a client attaches.
fn size_is_trusted((cols, rows): (usize, usize)) -> bool {
    cols > HERDR_NO_CLIENT_LAYOUT.0 || rows > HERDR_NO_CLIENT_LAYOUT.1
}

/// Size to request for an observe stream. Split out from `App::observe_size` so
/// the floor is testable.
///
/// `--cols/--rows` are a floor, never an exact request. As a floor they still do
/// their original job: the request must be >= the remote PTY size or the server
/// clips its bottom rows away, and the daemon's numbers already carry a margin.
/// As an exact request they are wrong — the daemon samples the *remote* pane's
/// rect when it spawns the streamer, and a headless remote reports the no-client
/// placeholder, so the numbers are small. Control then resizes the remote pty to
/// this pane and nothing shrinks it back on release, so asking for the daemon's
/// numbers again would stream a crop of a screen that has since grown, painted
/// into the corner of a much larger pane.
fn observe_size_for(args: &Args, term: (usize, usize)) -> (usize, usize) {
    (args.cols.max(term.0), args.rows.max(term.1))
}

/// Mode to open with. Split out from `run` so the composition is testable.
fn initial_mode(always_control: bool, size: (usize, usize)) -> Mode {
    if always_control && size_is_trusted(size) {
        Mode::Control
    } else {
        Mode::Observe
    }
}

fn term_size() -> (usize, usize) {
    unsafe {
        let mut ws: libc::winsize = std::mem::zeroed();
        if libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut ws) == 0 && ws.ws_col > 0 && ws.ws_row > 0 {
            return (ws.ws_col as usize, ws.ws_row as usize);
        }
    }
    (80, 24)
}

struct RawMode {
    orig: libc::termios,
}

impl RawMode {
    fn enable() -> Option<RawMode> {
        unsafe {
            let mut orig: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(libc::STDIN_FILENO, &mut orig) != 0 {
                return None;
            }
            let mut raw = orig;
            libc::cfmakeraw(&mut raw);
            if libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &raw) != 0 {
                return None;
            }
            Some(RawMode { orig })
        }
    }

    fn restore(&self) {
        unsafe {
            libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &self.orig);
        }
    }
}

fn write_stdout(s: &str) {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(s.as_bytes());
    let _ = out.flush();
}

/// One SGR mouse event: ESC [ < btn ; col ; row (M|m). Returns (btn, col, row,
/// press, total len) for a sequence starting at `bytes[at]`.
fn parse_mouse(bytes: &[u8], at: usize) -> Option<(u32, u32, u32, bool, usize)> {
    let rest = &bytes[at..];
    if rest.len() < 6 || rest[0] != 0x1b || rest[1] != b'[' || rest[2] != b'<' {
        return None;
    }
    let mut nums = [0u32; 3];
    let mut n = 0usize;
    let mut i = 3usize;
    let mut have_digit = false;
    while i < rest.len() && n < 3 {
        match rest[i] {
            b'0'..=b'9' => {
                // saturate: garbage digit runs on stdin must not overflow-panic
                nums[n] = nums[n].saturating_mul(10).saturating_add((rest[i] - b'0') as u32);
                have_digit = true;
                i += 1;
            }
            b';' if n < 2 && have_digit => {
                n += 1;
                have_digit = false;
                i += 1;
            }
            b'M' | b'm' if n == 2 && have_digit => {
                return Some((nums[0], nums[1], nums[2], rest[i] == b'M', i + 1));
            }
            _ => return None,
        }
    }
    None
}

/// How a parsed mouse event should be routed while in control mode.
#[derive(Debug, PartialEq, Eq)]
enum MouseAction {
    /// wheel: send as a semantic terminal.scroll (server decides app vs scrollback)
    Scroll { up: bool },
    /// click/drag on a remote TUI: forward the raw SGR sequence
    ForwardRaw,
    /// click/drag at a shell (or unclassified): drop, keep mouse local
    Drop,
}

/// Wheel always scrolls semantically, regardless of the foreground
/// classification — the remote herdr server knows the real app's mouse mode
/// and is a better judge than this side's process-name heuristic (e.g. a TUI
/// that doesn't consume wheel events, like an agent CLI). Non-wheel
/// clicks/drags keep the existing foreground-based routing.
fn mouse_action(remote_is_shell: Option<bool>, btn: u32, press: bool) -> MouseAction {
    if press && (btn == 64 || btn == 65) {
        MouseAction::Scroll { up: btn == 64 }
    } else if btn & 4 != 0 {
        // Shift-drag is the conventional terminal escape hatch from an
        // application's mouse mode. Let Herdr/the host terminal own the
        // selection so mirrored TUI text can be copied locally.
        MouseAction::Drop
    } else if btn == 66 || btn == 67 {
        MouseAction::Drop
    } else if remote_is_shell == Some(false) {
        MouseAction::ForwardRaw
    } else {
        MouseAction::Drop
    }
}

fn scroll_message(up: bool, x: u32, y: u32) -> serde_json::Value {
    json!({
        "type": "terminal.scroll",
        "direction": if up { "up" } else { "down" },
        "lines": 3,
        "source": "wheel",
        "column": x.saturating_sub(1),
        "row": y.saturating_sub(1),
        "modifiers": 0,
    })
}

fn has_mouse_seq(bytes: &[u8]) -> bool {
    bytes.windows(3).any(|w| w == [0x1b, b'[', b'<'])
}

/// Detect a passive viewport jumping backwards into scrollback. The remote
/// stream can emit these as a short cycle while an idle TUI redraws: most
/// existing non-empty rows reappear several rows lower, then the live viewport
/// returns. New output moves existing rows upward, so it does not match.
fn dominant_downward_shift(before: &Grid, after: &Grid) -> Option<usize> {
    if before.width != after.width || before.height != after.height || before.height < 6 {
        return None;
    }
    let old = before.text_lines();
    let new = after.text_lines();
    let max_shift = 12.min(before.height / 3);
    (2..=max_shift)
        .filter_map(|shift| {
            let mut comparable = 0usize;
            let mut matches = 0usize;
            for row in 0..before.height.saturating_sub(shift) {
                if old[row].is_empty() {
                    continue;
                }
                comparable += 1;
                if old[row] == new[row + shift] {
                    matches += 1;
                }
            }
            (matches >= 8 && matches * 100 >= comparable.max(1) * 70).then_some((shift, matches))
        })
        .max_by_key(|(_, matches)| *matches)
        .map(|(shift, _)| shift)
}

/// A remote idle redraw can alternate between two unrelated viewport snapshots
/// without any terminal input. Treat a large partial frame as transient until
/// the following frame confirms it; this catches A -> B -> A flashes while
/// allowing a continuously changing stream to advance by one frame.
fn large_partial_change(before: &Grid, after: &Grid) -> bool {
    if before.width != after.width || before.height != after.height || before.height < 10 {
        return false;
    }
    let old = before.text_lines();
    let new = after.text_lines();
    let changed = old.iter().zip(new.iter()).filter(|(a, b)| a != b).count();
    // Five rows is the smallest viewport swap that has been observed in the
    // remote TUI. Keep the proportional guard low enough to catch that on a
    // 66-row pane, while still leaving ordinary one-line typing immediate.
    changed >= 5 && changed * 100 >= before.height.max(1) * 7
}

fn same_grid_content(a: &Grid, b: &Grid) -> bool {
    a.width == b.width && a.height == b.height && a.text_lines() == b.text_lines()
}


// ---------------------------------------------------------------------------
// the wrapper state machine

const BACKOFF: [u64; 4] = [1000, 2000, 5000, 10000];
const SWITCH_GAP: Duration = Duration::from_millis(200);
const QUICK_CONTROL_FAILURE: Duration = Duration::from_secs(4);

struct App {
    args: Args,
    tty: bool,
    grid: Grid,
    /// Protocol-authoritative grid. Passive scrollback-like frames update this
    /// baseline without being committed to the visible `grid`.
    wire_grid: Grid,
    renderer: Renderer,
    tx: mpsc::Sender<Msg>,

    mode: Mode,
    /// in-flight mode switch (guards fast re-entry)
    switching_to: Option<Mode>,
    switch_at: Option<Instant>,
    session: Option<Session>,
    next_gen: u64,

    backoff_idx: usize,
    reconnect_at: Option<(Instant, Mode)>,
    /// consecutive quick control failures → fall back to observe
    control_failures: u32,
    control_sticky: bool,
    pending_input: Vec<Vec<u8>>,
    pending_control: Vec<serde_json::Value>,
    last_input: Instant,
    hint_clear_at: Option<Instant>,
    /// Debounced observe reconnect after the local pane gets a real viewport.
    /// Observe cannot resize in place, but reconnecting it is read-only and
    /// lets the remote server stream enough rows/columns for the new viewport.
    /// The check is retried while the pane is still on its headless placeholder
    /// size: Herdr can apply the real PTY dimensions a few seconds after the
    /// streamer is spawned, with no second SIGWINCH delivered to the child.
    observe_resize_at: Option<Instant>,
    /// Passive viewport-shift suppression is disabled briefly after explicit
    /// input/scroll, when a downward shift is user-requested rather than noise.
    allow_viewport_shift_until: Option<Instant>,
    /// Candidate observe frame held for one confirmation frame. Idle remote
    /// redraws can briefly replace the entire viewport, then restore it.
    pending_frame: Option<Grid>,
    /// predictive local echo — draws keystrokes optimistically, frame-verified
    predict: Predictor,
    /// remote pane foreground: Some(true)=shell (keep mouse local, no garbage),
    /// Some(false)=TUI (forward clicks), None=unknown (fail safe to local).
    /// Refreshed lazily on mouse activity via `herdr pane process-info`.
    remote_is_shell: Option<bool>,
    /// last time a foreground poll was kicked off (throttles the ssh handshakes)
    fg_poll_at: Option<Instant>,
    /// scheduled delayed re-poll to catch a foreground change the last input just
    /// caused (e.g. quitting a TUI back to a shell); bypasses the throttle
    settle_at: Option<Instant>,
    /// whether the local mouse grab (?1002h) is currently on. Released at a shell
    /// so herdr does native selection/scroll; re-grabbed for a TUI so clicks can
    /// be forwarded.
    mouse_grabbed: bool,
    /// whether the local pane is currently in application cursor mode (?1h), held
    /// to match the remote's so forwarded arrows arrive in the form it expects
    app_cursor_keys: bool,
}

/// minimum spacing between foreground polls — each is an ssh handshake, so we
/// poll lazily (only around mouse activity) and no faster than this
const FG_POLL_INTERVAL: Duration = Duration::from_millis(1500);

/// after input settles, re-poll once this much later to catch a foreground
/// change the input caused (e.g. a TUI just exited); bypasses FG_POLL_INTERVAL
const SETTLE_DELAY: Duration = Duration::from_millis(350);

impl App {
    fn paint(&mut self) {
        if !self.tty {
            return;
        }
        if self.predict.take_dirty() {
            // cleared predictions may have left ghost chars — full repaint
            self.renderer.invalidate();
        }
        let (cols, rows) = term_size();
        let out = self.renderer.paint(&self.grid, cols, rows);
        // Do not paint a local prediction over the remote frame.  A terminal
        // cell's background is not always represented at the cursor position;
        // an optimistic character would therefore create a transient default
        // (often black) rectangle while the authoritative frame is in flight.
        // Predictor state is still retained for confirmation and timeout logic.
        write_stdout(&out);
    }

    fn hint(&mut self, text: &str) {
        self.renderer.status(text);
        self.paint();
        self.hint_clear_at = Some(Instant::now() + Duration::from_millis(1500));
    }

    /// Kick a background poll of the remote pane's foreground process, throttled
    /// so a mouse burst doesn't spawn an ssh per event. The result arrives as
    /// Msg::Foreground and updates `remote_is_shell`.
    fn spawn_foreground_poll(&mut self, force: bool) {
        let now = Instant::now();
        if !force && self.fg_poll_at.is_some_and(|t| now.duration_since(t) < FG_POLL_INTERVAL) {
            return;
        }
        self.fg_poll_at = Some(now);
        let tx = self.tx.clone();
        let ssh = self.args.ssh_target.clone();
        let bin = self.args.remote_bin.clone();
        let pane = self.args.pane_target.clone();
        let ctl = self.args.ctl_path.clone();
        let container = self.args.container.clone();
        tokio::spawn(async move {
            let v = crate::foreground::poll(
                &ssh,
                bin.as_deref(),
                &pane,
                ctl.as_deref(),
                container.as_ref(),
            )
            .await;
            let _ = tx.send(Msg::Foreground(v)).await;
        });
    }

    /// Match the local mouse grab to the classification: release it at a shell so
    /// herdr does native selection/scroll, keep it grabbed for a TUI (or while
    /// unknown) so clicks can be forwarded. Only writes on a change.
    fn sync_mouse_grab(&mut self) {
        if !self.tty {
            return;
        }
        // grab unless we've confirmed the foreground is a shell
        let want = self.remote_is_shell != Some(true);
        if want == self.mouse_grabbed {
            return;
        }
        self.mouse_grabbed = want;
        write_stdout(if want { "\x1b[?1002h\x1b[?1006h" } else { "\x1b[?1002l" });
    }

    /// Match the local pane's cursor-key mode to the remote's, so the arrow bytes
    /// herdr hands us are already the ones the remote app expects.
    ///
    /// Frames carry no DEC modes (see grid.rs), so a remote app in application
    /// cursor mode (DECCKM, what terminfo `smkx` sets) never moves the local
    /// pane out of normal mode: herdr encodes Up as CSI A, we forward it
    /// verbatim, and the remote app is listening for SS3 A. Rather than rewrite
    /// the bytes in flight, put the LOCAL pane in the same mode and let herdr's
    /// own encoder produce the right form: it also covers Home/End and anything
    /// else whose encoding turns on this mode.
    ///
    /// The classification is the same shell/TUI proxy the mouse grab uses, for
    /// the same reason: the API exposes no input modes to ask for directly.
    fn sync_cursor_key_mode(&mut self) {
        if !self.tty {
            return;
        }
        // a shell prompt reads arrows in normal mode; a TUI is the case that
        // sets smkx, so mirror application mode unless we've confirmed a shell
        let want = self.remote_is_shell == Some(false);
        if want == self.app_cursor_keys {
            return;
        }
        self.app_cursor_keys = want;
        write_stdout(if want { "\x1b[?1h" } else { "\x1b[?1l" });
    }

    fn observe_size(&self) -> (usize, usize) {
        observe_size_for(&self.args, if self.tty { term_size() } else { (0, 0) })
    }

    /// Stop the child (clean release first for control) — never leave an
    /// orphan holding the remote attach lock.
    fn stop_session(&mut self) {
        if let Some(mut s) = self.session.take() {
            tokio::spawn(async move {
                if s.mode == Mode::Control {
                    let _ = s.stdin.write_all(b"{\"type\":\"terminal.release\"}\n").await;
                }
                tokio::time::sleep(Duration::from_millis(150)).await;
                unsafe { libc::kill(s.pid, libc::SIGTERM) };
            });
        }
    }

    async fn connect(&mut self, m: Mode) {
        self.mode = m;
        self.pending_frame = None;
        // re-earn prediction confidence against the new session's frames
        self.predict = Predictor::new();
        let (cols, rows) = match m {
            Mode::Observe => self.observe_size(),
            Mode::Control => term_size(),
        };
        if let Some(s) = self.session.take() {
            unsafe { libc::kill(s.pid, libc::SIGTERM) };
        }
        self.next_gen += 1;
        match spawn_session(&self.args, m, cols, rows, self.next_gen, self.tx.clone()) {
            Ok(mut s) => {
                if m == Mode::Control {
                    self.last_input = Instant::now();
                    for msg in std::mem::take(&mut self.pending_control) {
                        let line = msg.to_string() + "\n";
                        let _ = s.stdin.write_all(line.as_bytes()).await;
                    }
                    // keystrokes typed while the control session was spinning up
                    for buf in std::mem::take(&mut self.pending_input) {
                        let line = json!({ "type": "terminal.input", "bytes": B64.encode(&buf) }).to_string() + "\n";
                        let _ = s.stdin.write_all(line.as_bytes()).await;
                    }
                } else {
                    self.pending_input.clear();
                    self.pending_control.clear();
                }
                self.session = Some(s);
                // warm the foreground classification before the user mouses
                self.spawn_foreground_poll(false);
                // always-control has no release, so no "ctrl+\ to release" hint
                self.renderer.status(
                    if m == Mode::Control && !self.args.always_control {
                        "CONTROL — ctrl+\\ to release"
                    } else {
                        ""
                    },
                );
            }
            Err(e) => self.schedule_reconnect(m, &e.to_string()),
        }
    }

    fn schedule_reconnect(&mut self, m: Mode, reason: &str) {
        let delay = BACKOFF[self.backoff_idx.min(BACKOFF.len() - 1)];
        self.backoff_idx += 1;
        let suffix = if reason.is_empty() { String::new() } else { format!(" — {reason}") };
        self.renderer
            .status(&format!("reconnecting in {}s ({}){suffix}", delay / 1000, m.as_str()));
        self.paint();
        self.reconnect_at = Some((Instant::now() + Duration::from_millis(delay), m));
    }

    fn switch_mode(&mut self, m: Mode) {
        // already settled or scheduled — don't restart. Without this guard,
        // fast typing during the 200ms connect gap would spawn one control
        // ssh per keystroke, all racing to attach the same terminal.
        if self.switching_to == Some(m) || (self.switching_to.is_none() && self.mode == m) {
            return;
        }
        self.reconnect_at = None;
        self.switching_to = Some(m);
        self.stop_session();
        self.renderer.invalidate();
        // immediate feedback for the mode-switch gap (stop + 200ms + reconnect)
        self.renderer.status(if m == Mode::Control { "taking control…" } else { "releasing…" });
        self.paint();
        self.switch_at = Some(Instant::now() + SWITCH_GAP);
    }

    fn handle_frame(&mut self, gen: u64, frame: Frame) {
        if self.session.as_ref().map(|s| s.gen) != Some(gen) {
            return; // stale frame from a replaced session
        }
        if frame.kind == "terminal.closed" {
            let suffix = frame.reason.as_deref().map(|r| format!(": {r}")).unwrap_or_default();
            self.renderer.status(&format!("remote terminal closed{suffix}"));
            self.paint();
            return;
        }
        if frame.kind != "terminal.frame" {
            return;
        }
        let Some(bytes) = &frame.bytes else { return };
        self.backoff_idx = 0;
        self.renderer.status("");
        self.wire_grid.resize(
            frame.width.unwrap_or(self.wire_grid.width),
            frame.height.unwrap_or(self.wire_grid.height),
        );
        if frame.full == Some(true) {
            self.wire_grid.clear();
        }
        if let Ok(decoded) = B64.decode(bytes) {
            self.wire_grid.apply(&String::from_utf8_lossy(&decoded));
            let allow_shift = self.allow_viewport_shift_until.is_some_and(|until| until > Instant::now());
            if frame.full != Some(true) && !allow_shift && dominant_downward_shift(&self.grid, &self.wire_grid).is_some() {
                self.pending_frame = None;
                return;
            }
            // Control frames can exhibit the same transient viewport swap while
            // a remote TUI redraws in response to typing. Keep the one-frame
            // confirmation rule in both modes; full frames and explicit scroll
            // remain authoritative and immediate.
            if frame.full == Some(true) || allow_shift {
                self.pending_frame = None;
                self.grid = self.wire_grid.clone();
            } else if large_partial_change(&self.grid, &self.wire_grid) {
                let candidate = self.wire_grid.clone();
                match self.pending_frame.take() {
                    None => {
                        self.pending_frame = Some(candidate);
                        return;
                    }
                    Some(_previous) if same_grid_content(&candidate, &self.grid) => {
                        // A -> B -> A: the middle frame was a transient flash.
                        return;
                    }
                    Some(previous) if same_grid_content(&candidate, &previous) => {
                        self.grid = candidate;
                    }
                    Some(_previous) => {
                        // A sequence of unrelated large snapshots (A -> B ->
                        // C -> A) is another form of the remote redraw glitch.
                        // Keep the last stable viewport visible until one
                        // candidate repeats; never expose an unconfirmed B/C
                        // intermediate just because it arrived first.
                        self.pending_frame = Some(candidate);
                        return;
                    }
                }
            } else {
                self.pending_frame = None;
                self.grid = self.wire_grid.clone();
            }
            // reconcile predictive echo against the authoritative frame
            self.predict.on_frame(&self.grid);
        }
        if self.args.dump {
            let lines: Vec<String> = self.grid.text_lines().into_iter().filter(|l| !l.is_empty()).collect();
            println!(
                "--- frame seq={:?} full={:?} {}x{} ---\n{}",
                frame.seq,
                frame.full,
                frame.width.unwrap_or(0),
                frame.height.unwrap_or(0),
                lines.join("\n")
            );
        } else {
            self.paint();
        }
    }

    fn handle_exit(&mut self, gen: u64, exited_mode: Mode, reason: String, uptime: Duration) {
        if self.session.as_ref().map(|s| s.gen) != Some(gen) {
            return; // an old child we already replaced/killed
        }
        self.session = None;
        let reason_line =
            reason.lines().map(str::trim).rfind(|l| !l.is_empty()).unwrap_or("").to_string();
        // control that dies quickly twice is failing (refused/dropped): fall
        // back to observe so the pane stays viewable; a keystroke retries
        if exited_mode == Mode::Control {
            self.control_failures = if uptime < QUICK_CONTROL_FAILURE { self.control_failures + 1 } else { 0 };
            if self.control_failures >= 2 {
                self.control_failures = 0;
                self.control_sticky = true;
                self.switch_mode(Mode::Observe);
                let suffix = if reason_line.is_empty() { String::new() } else { format!(" ({reason_line})") };
                self.hint(&format!("control unavailable — viewing only{suffix}; type to retry"));
                return;
            }
        }
        self.schedule_reconnect(exited_mode, &reason_line);
    }

    async fn send(&mut self, msg: serde_json::Value) {
        if let Some(s) = self.session.as_mut() {
            let line = msg.to_string() + "\n";
            let _ = s.stdin.write_all(line.as_bytes()).await;
        }
    }

    async fn handle_stdin(&mut self, buf: Vec<u8>) {
        if self.mode == Mode::Observe || self.switching_to == Some(Mode::Observe) {
            // no quit key: the wrapper's lifecycle belongs to the hosting pane
            if has_mouse_seq(&buf) {
                // Scrolling is an intentional remote interaction: take control
                // and preserve the first wheel event instead of swallowing it.
                let mut i = 0usize;
                while i < buf.len() {
                    if let Some((btn, x, y, press, len)) = parse_mouse(&buf, i) {
                        if press && (btn == 64 || btn == 65) {
                            self.pending_control.push(scroll_message(btn == 64, x, y));
                            self.allow_viewport_shift_until = Some(Instant::now() + Duration::from_secs(2));
                            self.pending_frame = None;
                        }
                        i += len;
                    } else {
                        i += 1;
                    }
                }
                if !self.pending_control.is_empty() {
                    self.control_sticky = false;
                    self.switch_mode(Mode::Control);
                }
                return;
            }
            // any keystroke takes control and is delivered once the session is up
            self.control_sticky = false;
            self.pending_input.push(buf);
            self.switch_mode(Mode::Control);
            return;
        }

        // control mode
        self.last_input = Instant::now();
        if buf.len() == 1 && buf[0] == 0x1c {
            // ctrl+\ — manual release. In always-control there's nothing to
            // release to, so swallow it (never forward it: ctrl+\ is SIGQUIT).
            if !self.args.always_control {
                self.control_sticky = false;
                self.switch_mode(Mode::Observe);
            }
            return;
        }
        if self.switching_to == Some(Mode::Control) || self.session.is_none() {
            // spinning up or awaiting reconnect: queue the keystroke (flushed
            // on connect) and, if in backoff, reconnect now
            self.pending_input.push(buf);
            if let Some((_, m)) = self.reconnect_at {
                self.reconnect_at = Some((Instant::now(), m));
            }
            return;
        }
        // refresh the foreground classification on any input while active.
        // keyboard reaches us even when the grab is released at a shell, so this
        // is what catches a shell→TUI switch — a released grab means mouse events
        // stop arriving here, so mouse alone can never trigger the re-poll.
        self.spawn_foreground_poll(false);
        // and re-check shortly after input settles, to catch a change the input
        // just caused (e.g. `:q` quitting vim — the poll above still sees vim)
        self.settle_at = Some(Instant::now() + SETTLE_DELAY);
        // wheel becomes a semantic scroll (server decides app vs scrollback);
        // clicks/drags forward to the remote pty only when the foreground is a
        // TUI — at a shell they're dropped so they don't garbage the prompt
        let mut rest: Vec<u8> = Vec::with_capacity(buf.len());
        let mut i = 0usize;
        let mut scrolls: Vec<serde_json::Value> = Vec::new();
        while i < buf.len() {
            if let Some((btn, x, y, press, len)) = parse_mouse(&buf, i) {
                match mouse_action(self.remote_is_shell, btn, press) {
                    MouseAction::Scroll { up } => {
                        scrolls.push(scroll_message(up, x, y));
                        self.allow_viewport_shift_until = Some(Instant::now() + Duration::from_secs(2));
                        self.pending_frame = None;
                    }
                    MouseAction::ForwardRaw => rest.extend_from_slice(&buf[i..i + len]),
                    MouseAction::Drop => {}
                }
                i += len;
            } else {
                rest.push(buf[i]);
                i += 1;
            }
        }
        for s in scrolls {
            self.send(s).await;
        }
        if !rest.is_empty() {
            let msg = json!({ "type": "terminal.input", "bytes": B64.encode(&rest) });
            self.send(msg).await;
            // optimistic local echo: draw the keystroke now, verify on frame
            if self.predict.on_input(&rest, &self.grid) {
                self.paint();
            }
        }
    }
}

// ---------------------------------------------------------------------------
// main

/// Removes the streamer pidfile on any exit path out of `run` (stale files
/// from a hard kill are harmless — the daemon checks the pid is alive).
struct PidfileGuard(std::path::PathBuf);
impl Drop for PidfileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub async fn run(args: Args) -> Result<()> {
    // announce ourselves so the daemon can tell its typed `exec` took
    // (see util::streamer_pid_path); --dump is a human diagnostic, not a
    // daemon-spawned streamer, so it must not claim the slot
    let _pidfile = (!args.dump).then(|| {
        let state_dir =
            crate::util::home_dir().join(".local").join("state").join("herdr-mirror");
        let path =
            crate::util::streamer_pid_path(&state_dir, &args.ssh_target, &args.pane_target);
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&path, std::process::id().to_string());
        PidfileGuard(path)
    });

    let tty = !args.dump && unsafe { libc::isatty(libc::STDOUT_FILENO) } == 1;
    let raw = if tty {
        // 1002/1006: button-event mouse tracking with SGR encoding, so wheel and
        // clicks reach us instead of scrolling the hosting pane's scrollback
        write_stdout("\x1b[?1049h\x1b[2J\x1b[H\x1b[?1002h\x1b[?1006h");
        RawMode::enable()
    } else {
        None
    };

    let (tx, mut rx) = mpsc::channel::<Msg>(256);

    // stdin reader
    {
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut stdin = tokio::io::stdin();
            let mut buf = [0u8; 1024];
            loop {
                match stdin.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send(Msg::Stdin(buf[..n].to_vec())).await.is_err() {
                            break;
                        }
                    }
                }
            }
        });
    }

    let mut app = App {
        args,
        tty,
        grid: Grid::new(),
        wire_grid: Grid::new(),
        renderer: Renderer::new(),
        tx,
        mode: Mode::Observe,
        switching_to: None,
        switch_at: None,
        session: None,
        next_gen: 0,
        backoff_idx: 0,
        reconnect_at: None,
        control_failures: 0,
        control_sticky: false,
        pending_input: Vec::new(),
        pending_control: Vec::new(),
        last_input: Instant::now(),
        hint_clear_at: None,
        observe_resize_at: None,
        allow_viewport_shift_until: None,
        pending_frame: None,
        predict: Predictor::new(),
        remote_is_shell: None,
        fg_poll_at: None,
        settle_at: None,
        mouse_grabbed: tty, // startup wrote ?1002h when we're a tty
        // startup leaves the pane in normal cursor mode; the first classification
        // moves it if the remote turns out to be a TUI
        app_cursor_keys: false,
    };
    // Control is authoritative on the remote: the server resizes the remote pty
    // to whatever we ask for, beating even a larger live client over there. So
    // entering Control with a size we cannot vouch for is what let a local herdr
    // with no client attached drag a healthy remote pane down to its 80x24
    // placeholder (#23). Observe never resizes anything, so it is the safe place
    // to wait: the first resize or keystroke proves a human and promotes us.
    // BEFORE connect: spawning the session awaits a process launch, and a
    // SIGWINCH arriving in that window is lost outright (its default disposition
    // is to be ignored). That window is exactly when a client attaching lays out
    // a freshly created pane — the resize we now promote on. Registered first,
    // tokio buffers it and delivers it once the loop starts.
    let mut sigterm = signal(SignalKind::terminate())?;
    let mut sigint = signal(SignalKind::interrupt())?;
    let mut sighup = signal(SignalKind::hangup())?; // pane closed — don't orphan the ssh child
    let mut sigwinch = signal(SignalKind::window_change())?;

    app.connect(initial_mode(app.args.always_control, term_size())).await;
    if app.mode == Mode::Observe {
        // The pane can receive its final local layout just after the streamer
        // starts, before SIGWINCH is delivered. One delayed size check covers
        // that startup race without touching the remote PTY.
        app.observe_resize_at = Some(Instant::now() + Duration::from_millis(150));
    }
    // the pane may have been laid out while the session was spawning; the signal
    // for that is buffered above, but check directly too
    if app.mode == Mode::Observe && initial_mode(app.args.always_control, term_size()) == Mode::Control
    {
        app.switch_mode(Mode::Control);
    } else if app.args.always_control && app.mode == Mode::Observe {
        // F3: otherwise the pane is inert with no explanation
        app.hint("read-only until this pane is sized — type to take control");
    }

    loop {
        // earliest pending deadline: mode-switch gap, reconnect, hint clear, idle release
        let idle_at = (app.mode == Mode::Control
            && app.switching_to.is_none()
            && app.session.is_some()
            && !app.args.always_control
            && app.args.control_idle_secs > 0)
            .then(|| app.last_input + Duration::from_secs(app.args.control_idle_secs));
        let sleep = crate::util::sleep_until_earliest([
            app.switch_at,
            app.reconnect_at.map(|(t, _)| t),
            app.hint_clear_at,
            app.observe_resize_at,
            idle_at,
            app.predict.deadline(),
            app.settle_at,
        ]);

        tokio::select! {
            msg = rx.recv() => {
                match msg {
                    None => break,
                    Some(Msg::Frame { gen, frame }) => app.handle_frame(gen, frame),
                    Some(Msg::SessionExit { gen, mode, reason, uptime }) => app.handle_exit(gen, mode, reason, uptime),
                    Some(Msg::Stdin(buf)) => app.handle_stdin(buf).await,
                    // keep the last good classification if a poll failed (None)
                    Some(Msg::Foreground(v)) => if v.is_some() {
                        app.remote_is_shell = v;
                        app.sync_mouse_grab();
                        app.sync_cursor_key_mode();
                    },
                }
            }
            _ = sigwinch.recv() => {
                app.renderer.invalidate();
                // a resize means a client is laying this pane out, so the size is
                // now a real viewport: take control if that is what we're for.
                // control_sticky means control was refused twice in a row and we
                // told the user "type to retry" — a window drag must not turn
                // that into a reconnect storm.
                if app.args.always_control && app.mode == Mode::Observe && !app.control_sticky {
                    app.switch_mode(Mode::Control);
                }
                if app.mode == Mode::Control {
                    let (cols, rows) = term_size();
                    app.send(json!({ "type": "terminal.resize", "cols": cols, "rows": rows })).await;
                } else if app.switching_to.is_none() {
                    // A newly opened workspace is laid out after its streamer
                    // starts. Refresh the read-only stream at the real size;
                    // otherwise it remains cropped to the headless placeholder
                    // until the user types and takes control.
                    app.observe_resize_at = Some(Instant::now() + Duration::from_millis(100));
                }
                app.paint();
            }
            _ = sigterm.recv() => break,
            _ = sigint.recv() => break,
            _ = sighup.recv() => break,
            _ = sleep => {
                let now = Instant::now();
                if app.switch_at.is_some_and(|t| t <= now) {
                    app.switch_at = None;
                    if let Some(m) = app.switching_to.take() {
                        app.connect(m).await; // pending input from the gap flushes here
                    }
                }
                if let Some((t, m)) = app.reconnect_at {
                    if t <= now {
                        app.reconnect_at = None;
                        app.connect(m).await;
                    }
                }
                if app.hint_clear_at.is_some_and(|t| t <= now) {
                    app.hint_clear_at = None;
                    app.renderer.status("");
                    app.paint();
                }
                if app.observe_resize_at.is_some_and(|t| t <= now) {
                    app.observe_resize_at = None;
                    if app.mode == Mode::Observe && app.switching_to.is_none() {
                        let wanted = app.observe_size();
                        let current = app.session.as_ref().map(|s| (s.cols, s.rows));
                        if current != Some(wanted) {
                            app.connect(Mode::Observe).await;
                        }
                        if !size_is_trusted(wanted) {
                            // Keep checking until a real local client lays out
                            // the pane. This is intentionally read-only and
                            // never resizes the remote PTY itself.
                            app.observe_resize_at = Some(now + Duration::from_millis(500));
                        }
                    }
                }
                if idle_at.is_some_and(|t| t <= now) && app.mode == Mode::Control && app.switching_to.is_none() {
                    app.control_sticky = true;
                    app.switch_mode(Mode::Observe);
                    app.hint("control released (idle) — type to retake");
                }
                if app.settle_at.is_some_and(|t| t <= now) {
                    app.settle_at = None;
                    app.spawn_foreground_poll(true); // forced: bypass the throttle
                }
                if app.predict.deadline().is_some_and(|t| t <= now) {
                    app.predict.on_tick(); // wipe timed-out ghosts (no-echo prompts)
                    app.paint();
                }
            }
        }
    }

    // clean shutdown: release control if held, kill the ssh child, restore tty
    if let Some(mut s) = app.session.take() {
        if s.mode == Mode::Control {
            let _ = s.stdin.write_all(b"{\"type\":\"terminal.release\"}\n").await;
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        unsafe { libc::kill(s.pid, libc::SIGTERM) };
    }
    if tty {
        // ?1l with the rest: leaving the hosting pane in application cursor mode
        // would misencode arrows for whatever runs there next
        write_stdout("\x1b[?1002l\x1b[?1006l\x1b[?1l\x1b[?25h\x1b[?1049l");
    }
    if let Some(raw) = raw {
        raw.restore();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passive_scrollback_jump_is_detected_but_new_output_is_not() {
        let mut before = Grid::new();
        before.resize(30, 30);
        for row in 0..12 {
            before.apply(&format!("\x1b[{};1Hline-{row:02}", row + 1));
        }

        let mut down = Grid::new();
        down.resize(30, 30);
        for row in 0..12 {
            down.apply(&format!("\x1b[{};1Hline-{row:02}", row + 9));
        }
        assert_eq!(dominant_downward_shift(&before, &down), Some(8));

        let mut up = Grid::new();
        up.resize(30, 30);
        for row in 2..12 {
            up.apply(&format!("\x1b[{};1Hline-{row:02}", row - 1));
        }
        assert_eq!(dominant_downward_shift(&before, &up), None);
    }

    #[test]
    fn large_partial_change_is_debounced_but_small_change_is_immediate() {
        let mut before = Grid::new();
        before.resize(40, 20);
        for row in 0..20 {
            before.apply(&format!("\x1b[{};1Hline-{row:02}", row + 1));
        }

        let mut large = before.clone();
        for row in 0..8 {
            large.apply(&format!("\x1b[{};1Hother-{row:02}", row + 1));
        }
        assert!(large_partial_change(&before, &large));

        let mut five = before.clone();
        for row in 0..5 {
            five.apply(&format!("\x1b[{};1Hfive-{row:02}", row + 1));
        }
        assert!(large_partial_change(&before, &five));

        let mut small = before.clone();
        small.apply("\x1b[1;1Hchanged");
        assert!(!large_partial_change(&before, &small));
    }

    #[test]
    fn wheel_always_semantic_scroll_even_on_tui_foreground() {
        // remote foreground classified as a TUI (e.g. `claude`) — wheel must
        // still produce a semantic scroll, not a raw forward, or it silently
        // does nothing when the TUI doesn't consume mouse wheel input
        assert_eq!(mouse_action(Some(false), 64, true), MouseAction::Scroll { up: true });
        assert_eq!(mouse_action(Some(false), 65, true), MouseAction::Scroll { up: false });
        // unclassified/shell foreground: wheel still scrolls
        assert_eq!(mouse_action(None, 64, true), MouseAction::Scroll { up: true });
        assert_eq!(mouse_action(Some(true), 65, true), MouseAction::Scroll { up: false });
        // non-wheel clicks/drags keep the existing foreground-based routing
        assert_eq!(mouse_action(Some(false), 0, true), MouseAction::ForwardRaw); // TUI click
        assert_eq!(mouse_action(Some(false), 4, true), MouseAction::Drop); // Shift-click selects locally
        assert_eq!(mouse_action(Some(true), 0, true), MouseAction::Drop); // shell click
        assert_eq!(mouse_action(None, 0, true), MouseAction::Drop); // unclassified click
    }

    #[test]
    fn mouse_parsing() {
        let seq = b"\x1b[<64;10;5M";
        let (btn, x, y, press, len) = parse_mouse(seq, 0).unwrap();
        assert_eq!((btn, x, y, press, len), (64, 10, 5, true, seq.len()));
        assert!(has_mouse_seq(b"xx\x1b[<0;1;1Myy"));
        assert!(!has_mouse_seq(b"plain text"));
    }


    #[test]
    fn sh_quote_escapes_single_quotes() {
        assert_eq!(sh_quote("w9:p1"), "'w9:p1'");
        assert_eq!(sh_quote("a'b"), "'a'\\''b'");
        // overflow-proof mouse params: 11 digits saturate instead of panicking
        let (_, x, _, _, _) = parse_mouse(b"\x1b[<64;99999999999;1M", 0).unwrap();
        assert_eq!(x, u32::MAX);
    }

    #[test]
    fn observe_size_treats_daemon_sizes_as_a_floor() {
        // what the daemon spawns a streamer with for a headless remote: the
        // no-client placeholder rect plus its margin
        let argv: Vec<String> = ["work", "w1:p1", "--cols", "70", "--rows", "31"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let a = parse_args(&argv).unwrap();
        // control has already resized the remote pty to this pane, and release
        // does not shrink it back — observing at 70x31 would stream a crop
        assert_eq!(observe_size_for(&a, (314, 92)), (314, 92));
        // a pane smaller than the remote still gets the daemon's margin
        assert_eq!(observe_size_for(&a, (40, 20)), (70, 31));
        // --dump has no tty: exactly what was asked for
        assert_eq!(observe_size_for(&a, (0, 0)), (70, 31));
    }

    #[test]
    fn arg_parsing() {
        let argv: Vec<String> =
            ["work", "w9:p1", "--remote-bin", "/opt/herdr", "--cols", "176", "--rows", "66"]
                .iter()
                .map(|s| s.to_string())
                .collect();
        let a = parse_args(&argv).unwrap();
        assert_eq!(a.ssh_target, "work");
        assert_eq!(a.pane_target, "w9:p1");
        assert_eq!(a.remote_bin.as_deref(), Some("/opt/herdr"));
        assert_eq!((a.cols, a.rows), (176, 66));
        assert!(parse_args(&["onlyone".to_string()]).is_err());
        assert!(parse_args(&["a".into(), "b".into(), "--visibility-file".into(), "x".into()]).is_err());
    }

    // --- birth size trust (#23) ---
    //
    // herdr renders at 80x24 when no client is attached, and chrome only
    // subtracts, so anything larger in either axis is provably a real viewport.

    #[test]
    fn a_placeholder_sized_pane_is_never_trusted() {
        // what a mirror pane is born as when nobody is watching: 80x24 less a
        // 26-col sidebar and the tab bar
        assert!(!size_is_trusted((54, 23)));
        // and the extremes of that layout, in case chrome is configured away
        assert!(!size_is_trusted((80, 24)));
        assert!(!size_is_trusted((80, 23)));
    }

    #[test]
    fn an_ordinary_viewport_is_trusted_immediately() {
        assert!(size_is_trusted((141, 44)));
        assert!(size_is_trusted((133, 47)));
        // one axis is enough: a tall narrow pane cannot come from a 24-row floor
        assert!(size_is_trusted((60, 40)));
        assert!(size_is_trusted((200, 20)));
    }

    #[test]
    fn initial_mode_is_read_only_unless_the_size_vouches_for_itself() {
        // the whole composition: only a trusted size under always_control opens
        // writable, because Control is what can resize the remote
        assert_eq!(initial_mode(true, (141, 44)), Mode::Control);
        assert_eq!(initial_mode(true, (54, 23)), Mode::Observe, "placeholder-sized");
        // without always_control we start read-only regardless, as before
        assert_eq!(initial_mode(false, (141, 44)), Mode::Observe);
        assert_eq!(initial_mode(false, (54, 23)), Mode::Observe);
    }

    #[test]
    fn a_small_client_is_not_trusted_at_birth_and_must_earn_control() {
        // A phone (45x18 -> pane 44x16) and moshi (50x25 -> 49x23) are real
        // viewports, but at birth they are indistinguishable from the placeholder
        // — that is the whole reason shape matching failed. They start read-only
        // and the first resize or keystroke promotes them, rather than being
        // allowed to impose a size we cannot vouch for.
        assert!(!size_is_trusted((44, 16)));
        assert!(!size_is_trusted((49, 23)));
    }
}
