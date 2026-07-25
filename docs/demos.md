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

https://github.com/user-attachments/assets/7441eba1-a791-437f-8f01-788bee9f55e1

### Smooth scrollback

History is prefetched above the live screen in a single scroll container —
swiping into the past is plain native scrolling with fling momentum, no
mode switch, no fetch stall. The **↓ Live** chip lights up while you're in
history; tapping it (or scrolling back down) returns to the live tail.

https://github.com/user-attachments/assets/b0a96b2b-5f69-434e-8c20-2bd2d4c04160

### Blocked agent → toast → jump

The herdr feature people love, on your phone: an agent in another workspace
hits an approval prompt → its dot turns orange, a toast slides in, and the
bell chip starts pulsing. Tap the toast to jump straight to the blocked
pane.

https://github.com/user-attachments/assets/265b1086-8129-47e4-b522-45f131329b91

### Done while you weren't looking

An agent finishing in a background pane is marked **done — unseen** (blue
dot) with a "finished" toast. The bell chip cycles you to the next agent
needing attention; viewing the pane marks it seen — in the web UI *and* in
herdr itself.

https://github.com/user-attachments/assets/ade7844b-d78d-41d5-9a11-0a0f7b7fcdca

### Background system notification

With the app backgrounded, a blocked agent raises a real system
notification. Tapping it brings the app straight back to the pane that
needs you.

https://github.com/user-attachments/assets/f301b223-b84b-46fb-b01e-7a49ae90e09d

### Create a session

The **+** button opens a sheet: pick a working directory (and optionally a
label/command), and the new pane appears as a tab — here a plain shell that
we immediately type into.

https://github.com/user-attachments/assets/cd286205-3170-4c6a-b812-d1dce8691e4a

## Desktop

The same single-page app at desktop size: the herdr runtime resizes to the
bigger viewport, so the agent gets a wide terminal. Prompt, watch the
response, wheel-scroll into history, hop between workspace tabs.

https://github.com/user-attachments/assets/aeca8a81-a05c-436f-ac39-c355a1a895bd
