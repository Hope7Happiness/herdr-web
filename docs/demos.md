# Demos

All clips below were recorded on a real Android emulator (Pixel-class,
1080×2400) driving the actual app over HTTPS, and on desktop Chromium.
Videos are hosted as GitHub attachments
([#1](https://github.com/eyalev/herdr-web/issues/1)).

## Mobile

### Prompt a live agent

Type to a Claude Code session and watch the response stream into the live
terminal view. The tab dot pulses green while the agent works, and the tab
subtitle tracks the agent's own task title.

https://github.com/user-attachments/assets/a687a81a-8baf-497e-88e1-a6a8ff273e46

### Smooth scrollback

History is prefetched above the live screen in a single scroll container —
swiping into the past is plain native scrolling with fling momentum, no
mode switch, no fetch stall. The **↓ Live** chip lights up while you're in
history; tapping it (or scrolling back down) returns to the live tail.

https://github.com/user-attachments/assets/b4fadeb8-de0d-4c54-b18d-ca8adda2f703

### Blocked agent → toast → jump

The herdr feature people love, on your phone: an agent in another workspace
hits an approval prompt → its dot turns orange, a toast slides in, and the
bell chip starts pulsing. Tap the toast to jump straight to the blocked
pane.

https://github.com/user-attachments/assets/475602cb-81a1-4995-8f63-d2ffcdaa7f42

### Done while you weren't looking

An agent finishing in a background pane is marked **done — unseen** (blue
dot) with a "finished" toast. The bell chip cycles you to the next agent
needing attention; viewing the pane marks it seen — in the web UI *and* in
herdr itself.

https://github.com/user-attachments/assets/3c0c76d5-46aa-4233-ba97-aa3d0c3ff662

### Background system notification

With the app backgrounded (HTTPS origin + granted notification permission),
a blocked agent raises a real system notification; tapping it brings the
app back with the attention state waiting. (No clip for this one — the
notification shade displays the serving hostname, which we keep private.)

### Create a session

The **+** button opens a sheet: pick a working directory (and optionally a
label/command), and the new pane appears as a tab — here a plain shell that
we immediately type into.

https://github.com/user-attachments/assets/88b75ea9-2777-4a02-a116-1b799fbc848b

## Desktop

The same single-page app at desktop size: the herdr runtime resizes to the
bigger viewport, so the agent gets a wide terminal. Prompt, watch the
response, wheel-scroll into history, hop between workspace tabs.

https://github.com/user-attachments/assets/a9daeaf5-0bcc-4db5-b7f9-cc812884e083
