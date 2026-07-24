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

https://github.com/user-attachments/assets/b437eecc-a175-4cc4-ad05-7a753db097d3

### Smooth scrollback

History is prefetched above the live screen in a single scroll container —
swiping into the past is plain native scrolling with fling momentum, no
mode switch, no fetch stall. The **↓ Live** chip lights up while you're in
history; tapping it (or scrolling back down) returns to the live tail.

https://github.com/user-attachments/assets/b573db50-3605-40fd-9d6a-b8e0df02b96d

### Blocked agent → toast → jump

The herdr feature people love, on your phone: an agent in another workspace
hits an approval prompt → its dot turns orange, a toast slides in, and the
bell chip starts pulsing. Tap the toast to jump straight to the blocked
pane.

https://github.com/user-attachments/assets/61e00525-17f1-4c25-8a20-d7ccba95d3ec

### Done while you weren't looking

An agent finishing in a background pane is marked **done — unseen** (blue
dot) with a "finished" toast. The bell chip cycles you to the next agent
needing attention; viewing the pane marks it seen — in the web UI *and* in
herdr itself.

https://github.com/user-attachments/assets/7692ccc0-df1a-4e2c-896d-dcc81351105c

### Background system notification

With the app backgrounded (HTTPS origin + granted notification permission),
a blocked agent raises a real system notification; tapping it brings the
app back with the attention state waiting. (No clip for this one — the
notification shade displays the serving hostname, which we keep private.)

### Create a session

The **+** button opens a sheet: pick a working directory (and optionally a
label/command), and the new pane appears as a tab — here a plain shell that
we immediately type into.

https://github.com/user-attachments/assets/b452306b-18d2-49da-9680-f2f09ee4f4b8

## Desktop

The same single-page app at desktop size: the herdr runtime resizes to the
bigger viewport, so the agent gets a wide terminal. Prompt, watch the
response, wheel-scroll into history, hop between workspace tabs.

https://github.com/user-attachments/assets/12e95155-4c10-4cdf-9020-f42ebd4f543f
