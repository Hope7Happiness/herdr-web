# Create a session

Start a new pane without leaving the phone.

https://github.com/user-attachments/assets/cd286205-3170-4c6a-b812-d1dce8691e4a

The **+** button opens a sheet: pick a working directory, optionally a label and
a command, and the new pane appears as a tab.

The sheet clears its fields every time it opens (stale values used to compound
into wrong paths), and the bridge rejects a directory that does not exist
instead of letting herdr quietly fall back to `$HOME`.

---

[← All demos](../demos.md) · [README](../../README.md)
