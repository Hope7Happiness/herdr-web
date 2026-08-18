#!/usr/bin/env bash
set -euo pipefail
STATE_DIR="${HERDR_PLUGIN_STATE_DIR:-$HOME/.local/state/herdr-web}"
if [ -f "$STATE_DIR/server.pid" ] && kill -0 "$(cat "$STATE_DIR/server.pid")" 2>/dev/null; then
  PID="$(cat "$STATE_DIR/server.pid")"
  kill "$PID"
  rm -f "$STATE_DIR/server.pid"
  echo "herdr-web stopped"
else
  rm -f "$STATE_DIR/server.pid"
  echo "herdr-web not running (or not started by this plugin)"
fi
