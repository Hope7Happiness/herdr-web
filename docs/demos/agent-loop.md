# Takeover, page errors → agent, and the element picker

The browser stops being a thing you *watch* the agent use, and becomes part of
the loop you drive.

## Desktop

https://github.com/user-attachments/assets/dd98f18c-1566-491f-8662-281311ea9aac

## On a phone

Same loop, one screen at a time — you step back to the terminal to send the
prompt and return to the cast with your control (and the collected errors)
intact.

https://github.com/user-attachments/assets/ba9ad8ec-0043-4080-bde1-26d876a73fe0

## What is happening

**Takeover / hand-back.** Cast opens in **watching** mode: the agent may be
driving this browser, and stray taps from a pocket would fight it. Taking
control is explicit, gated server-side (input is refused while watching, not
merely hidden), and handing back is the same chip. Note the honest limit: CDP
allows many clients, so this cannot *lock the agent out* — it keeps **your**
input off the page and makes the state visible.

**Page errors → agent.** The session subscribes to `Runtime.exceptionThrown`,
`Runtime.consoleAPICalled` and `Log.entryAdded`, de-duplicates them, and
surfaces a chip. One tap composes a report — message, source location — into
the agent prompt. It is *filled, not sent*, so you see exactly what goes to the
agent. In the clips the agent then reads the real stack location and fixes the
source; live-reload repaints the page and the counter climbs past 1 again.

**Element picker.** Tap an element and `DOM.getNodeForLocation` →
`DOM.resolveNode` → an in-page function resolve it to a selector plus its text
(`#count` (<span> — "2")), dropped into the prompt so your next instruction has
a subject. On a phone this replaces describing an element in words.

Everything rides the same CDP session as the cast, so none of it needs the page
to be same-origin, framable, or proxied.

---

[← All demos](../demos.md) · [README](../../README.md)
