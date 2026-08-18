# Prompt a live agent

Type to Claude Code from a phone and watch the answer stream in.

https://github.com/user-attachments/assets/7441eba1-a791-437f-8f01-788bee9f55e1

The tab dot pulses green while the agent works, and the tab subtitle tracks the
agent's own task title, so a glance tells you what each pane is doing.

Submitting is one atomic `agent.prompt` call, which honours the pane's live
bracketed-paste mode — the reason prompts never arrive half-pasted here. The
keyboard drops on send so the full terminal is visible while the agent thinks.

The terminal itself is native DOM rows built from herdr's own screen reads.
Rows wrap locally at a phone-readable size without resizing the shared Herdr
PTY or the desktop client.

---

[← All demos](../demos.md) · [README](../../README.md)
