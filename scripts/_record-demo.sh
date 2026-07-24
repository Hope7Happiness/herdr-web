#!/usr/bin/env bash
# Record an emulator demo: ./_record-demo.sh <name> <seconds> — starts
# screenrecord, waits (drive the UI meanwhile from another shell), pulls the
# mp4 into docs/media/ and renders a GitHub-embeddable GIF next to it.
set -euo pipefail
NAME="$1"; SECS="${2:-30}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/docs/media"

adb shell "screenrecord --bit-rate 6000000 --time-limit $((SECS + 2)) /sdcard/demo.mp4" &
REC_PID=$!
sleep "$SECS"
adb shell pkill -INT screenrecord 2>/dev/null || true
wait $REC_PID 2>/dev/null || true
sleep 1
adb pull /sdcard/demo.mp4 "$ROOT/docs/media/$NAME.mp4" >/dev/null
adb shell rm -f /sdcard/demo.mp4

# GIF: 360px wide, 10fps, palette-optimized
ffmpeg -y -loglevel error -i "$ROOT/docs/media/$NAME.mp4" \
  -vf "fps=10,scale=360:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer" \
  "$ROOT/docs/media/$NAME.gif"
ls -la "$ROOT/docs/media/$NAME".{mp4,gif} | awk '{print $5, $9}'
