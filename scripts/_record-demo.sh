#!/usr/bin/env bash
# Record an emulator demo: ./_record-demo.sh <name> <seconds> — starts
# screenrecord, waits (drive the UI meanwhile from another shell), pulls the
# mp4 into docs/media/ (local only, gitignored). NO GIFs — demo videos are
# uploaded as GitHub issue attachments and embedded as mp4 (see
# _upload-media-issue.mjs); asset URLs render as inline players.
set -euo pipefail
NAME="$1"; SECS="${2:-30}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/docs/media"

adb shell "screenrecord --bit-rate 12000000 --time-limit $((SECS + 2)) /sdcard/demo.mp4" &
REC_PID=$!
sleep "$SECS"
adb shell pkill -INT screenrecord 2>/dev/null || true
wait $REC_PID 2>/dev/null || true
sleep 1
adb pull /sdcard/demo.mp4 "$ROOT/docs/media/$NAME.mp4" >/dev/null
adb shell rm -f /sdcard/demo.mp4
ls -la "$ROOT/docs/media/$NAME.mp4" | awk '{print $5, $9}'
