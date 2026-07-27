# Smooth scrollback

History is already there when your finger arrives.

https://github.com/user-attachments/assets/b0a96b2b-5f69-434e-8c20-2bd2d4c04160

Scrollback is prefetched *above* the live screen in a single scroll container,
so swiping into the past is plain native scrolling with fling momentum — no
mode switch, no fetch on the gesture path, no stall.

Two details that make it feel right:

- while you are scrolled up, the history block is frozen, so your reading
  position never jumps under live output;
- scrolling back to the bottom re-pins to live automatically, and the **↓ Live**
  chip (always present, greyed when you are already live) is the explicit way
  back.

---

[← All demos](../demos.md) · [README](../../README.md)
