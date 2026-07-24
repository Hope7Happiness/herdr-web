# Demos

All clips below were recorded on a real Android emulator (Pixel-class,
1080×2400) driving the actual app over HTTPS, and on desktop Chromium.
Each GIF has a full-quality MP4 next to it in [`docs/media/`](media/).

## Mobile

### Prompt a live agent

Type to a Claude Code session and watch the response stream into the live
terminal view. The tab dot pulses green while the agent works, and the tab
subtitle tracks the agent's own task title.

<img src="media/live-agent.gif" width="300" alt="Live agent demo">

[MP4](media/live-agent.mp4)

### Smooth scrollback

History is prefetched above the live screen in a single scroll container —
swiping into the past is plain native scrolling with fling momentum, no
mode switch, no fetch stall. The **↓ Live** chip lights up while you're in
history; tapping it (or scrolling back down) returns to the live tail.

<img src="media/smooth-scrollback.gif" width="300" alt="Smooth scrollback demo">

[MP4](media/smooth-scrollback.mp4)

### Blocked agent → toast → jump

The herdr feature people love, on your phone: an agent in another workspace
hits an approval prompt → its dot turns orange, a toast slides in, and the
bell chip starts pulsing. Tap the toast to jump straight to the blocked
pane.

<img src="media/attention-blocked.gif" width="300" alt="Blocked attention demo">

[MP4](media/attention-blocked.mp4)

### Done while you weren't looking

An agent finishing in a background pane is marked **done — unseen** (blue
dot) with a "finished" toast. The bell chip cycles you to the next agent
needing attention; viewing the pane marks it seen — in the web UI *and* in
herdr itself.

<img src="media/attention-done.gif" width="300" alt="Done-unseen demo">

[MP4](media/attention-done.mp4)

### Background system notification

With the app backgrounded (HTTPS origin + granted permission), a blocked
agent raises a real Android notification. Tapping it brings the app back
with the attention state waiting.

<img src="media/background-notification.gif" width="300" alt="Background notification demo">

[MP4](media/background-notification.mp4)

### Create a session

The **+** button opens a sheet: pick a working directory (and optionally a
label/command), and the new pane appears as a tab — here a plain shell that
we immediately type into.

<img src="media/new-session.gif" width="300" alt="New session demo">

[MP4](media/new-session.mp4)

## Desktop

The same single-page app at desktop size: the herdr runtime resizes to the
bigger viewport, so the agent gets a wide terminal. Prompt, watch the
response, wheel-scroll into history, hop between workspace tabs.

<img src="media/desktop.gif" width="640" alt="Desktop demo">

[MP4](media/desktop.mp4)
