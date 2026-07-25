#!/usr/bin/env bash
# Mint the real Let's Encrypt cert for the demo tailnet hostname and restart
# the TLS front with it, so emulator recordings show a valid padlock.
#
# Requires: HTTPS certificates enabled for the demo tailnet
# (admin console → DNS → Enable HTTPS). Until then tailscale replies
# "your Tailscale account does not support getting TLS certs".
set -euo pipefail

HOST="${DEMO_HOST:-herdr-demo.taildf4693.ts.net}"
SOCK="$HOME/.local/share/tailscale-herdrdemo/tailscaled.sock"
DIR="$HOME/.config/herdr-web-demo"
TS=/snap/tailscale/current/bin/tailscale

mkdir -p "$DIR"
# Write both halves in ONE call with relative paths from $DIR: tailscale
# rejects /dev/null as an output path, and absolute paths can trip its
# sandbox check.
cd "$DIR"
"$TS" --socket="$SOCK" cert --cert-file=cert.new --key-file=key.new "$HOST"
mv cert.new "$DIR/cert.pem"
mv key.new "$DIR/key.pem"
chmod 600 "$DIR/key.pem"

openssl x509 -in "$DIR/cert.pem" -noout -subject -issuer -enddate

pkill -f "_demo-tls.mjs" 2>/dev/null || true
sleep 1
DEMO_TLS_PORT="${DEMO_TLS_PORT:-9443}" setsid nohup node "$(dirname "$0")/_demo-tls.mjs" \
  > "${TMPDIR:-/tmp}/demo-tls.log" 2>&1 < /dev/null &
sleep 2
curl -s -o /dev/null -w "tls-front: %{http_code}\n" --resolve "$HOST:9443:127.0.0.1" "https://$HOST:9443/api/sessions"
echo "cert installed for $HOST"
