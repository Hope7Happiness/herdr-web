#!/usr/bin/env bash
set -euo pipefail
STATE_DIR="${HERDR_PLUGIN_STATE_DIR:-$HOME/.local/state/herdr-web}"
if [ -f "$STATE_DIR/server.pid" ] && kill -0 "$(cat "$STATE_DIR/server.pid")" 2>/dev/null; then
  kill "$(cat "$STATE_DIR/server.pid")"
  rm -f "$STATE_DIR/server.pid"
  echo "herdr-web stopped"
else
  pkill -f "herdr-web/server\.js" 2>/dev/null && echo "herdr-web stopped (by pattern)" || echo "herdr-web not running"
fi
