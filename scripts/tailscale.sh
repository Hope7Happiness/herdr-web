#!/usr/bin/env bash
# Private HTTPS access to herdr-web through Tailscale Serve.
set -euo pipefail

COMMAND="${1:-status}"
LOCAL_PORT="${HERDR_WEB_PORT:-7930}"
HTTPS_PORT="${HERDR_WEB_TAILSCALE_HTTPS_PORT:-17930}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

for value in "$LOCAL_PORT" "$HTTPS_PORT"; do
  case "$value" in
    ''|*[!0-9]*) echo "ports must be integers" >&2; exit 2 ;;
  esac
  if [ "$value" -lt 1 ] || [ "$value" -gt 65535 ]; then
    echo "port out of range: $value" >&2
    exit 2
  fi
done

find_tailscale() {
  if [ -n "${TAILSCALE_BIN:-}" ] && [ -x "$TAILSCALE_BIN" ]; then
    printf '%s\n' "$TAILSCALE_BIN"
  elif command -v tailscale >/dev/null 2>&1; then
    command -v tailscale
  elif [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
    printf '%s\n' /Applications/Tailscale.app/Contents/MacOS/Tailscale
  else
    return 1
  fi
}

if ! TS_BIN="$(find_tailscale)"; then
  echo "Tailscale CLI not found." >&2
  echo "Install Tailscale on this computer, sign in, then retry:" >&2
  echo "  https://tailscale.com/download" >&2
  exit 1
fi

ts() {
  TAILSCALE_BE_CLI=1 "$TS_BIN" "$@"
}

dns_name() {
  ts status --json | node -e '
    let s=""; process.stdin.on("data", c => s += c).on("end", () => {
      const d=JSON.parse(s); const name=(d.Self?.DNSName || "").replace(/\.$/, "");
      if (!name) process.exit(1); process.stdout.write(name);
    });'
}

public_url() {
  local name suffix
  name="$(dns_name)"
  suffix=":${HTTPS_PORT}"
  if [ "$HTTPS_PORT" = 443 ]; then suffix=""; fi
  printf 'https://%s%s\n' "$name" "$suffix"
}

bridge_ready() {
  curl --fail --silent --max-time 2 "http://127.0.0.1:${LOCAL_PORT}/api/sessions" >/dev/null
}

# Report whether our chosen HTTPS listener is absent, points at this bridge,
# or belongs to something else. This keeps start/off from overwriting another
# Serve or Funnel route on the same machine.
route_state() {
  ts serve status --json | \
    HERDR_LOCAL_PORT="$LOCAL_PORT" HERDR_HTTPS_PORT="$HTTPS_PORT" node -e '
      let s=""; process.stdin.on("data", c => s += c).on("end", () => {
        const d=JSON.parse(s), hp=process.env.HERDR_HTTPS_PORT;
        const match=Object.entries(d.Web || {}).find(([k]) => k.endsWith(`:${hp}`));
        if (!match) return process.stdout.write("absent");
        const [key, web]=match;
        const proxies=Object.values(web.Handlers || {}).map(h => h.Proxy).filter(Boolean);
        const wanted=`http://127.0.0.1:${process.env.HERDR_LOCAL_PORT}`;
        process.stdout.write(proxies.includes(wanted) && !d.AllowFunnel?.[key] ? "ours" : "conflict");
      });'
}

case "$COMMAND" in
  serve|start)
    current="$(route_state)"
    if [ "$current" = conflict ]; then
      echo "Refusing to replace an existing Serve/Funnel route on HTTPS :${HTTPS_PORT}." >&2
      echo "Choose a different HERDR_WEB_TAILSCALE_HTTPS_PORT." >&2
      exit 1
    fi
    if ! bridge_ready; then
      HERDR_WEB_PORT="$LOCAL_PORT" bash "$ROOT/scripts/plugin-start.sh"
    fi
    serve_args=(serve --bg "--https=${HTTPS_PORT}")
    if ts serve --help 2>&1 | grep -q -- '--yes'; then serve_args+=(--yes); fi
    ts "${serve_args[@]}" "http://127.0.0.1:${LOCAL_PORT}"
    echo
    echo "herdr-web is available inside your tailnet:"
    public_url
    ;;
  off|stop)
    current="$(route_state)"
    if [ "$current" = absent ]; then
      echo "herdr-web Tailscale Serve listener is already off (:${HTTPS_PORT})"
      exit 0
    fi
    if [ "$current" = conflict ]; then
      echo "Refusing to remove HTTPS :${HTTPS_PORT}; it is not owned by herdr-web." >&2
      exit 1
    fi
    # Remove only the HTTPS listener owned by herdr-web. Never reset the
    # machine's other Tailscale Serve routes.
    ts serve "--https=${HTTPS_PORT}" off
    echo "herdr-web Tailscale Serve listener stopped (:${HTTPS_PORT})"
    ;;
  url)
    public_url
    ;;
  status)
    echo "Tailscale:"
    ts status
    echo
    echo "Serve:"
    ts serve status
    echo
    if bridge_ready; then
      echo "herdr-web: ready on http://127.0.0.1:${LOCAL_PORT}"
      printf 'phone URL: '
      public_url || echo "unavailable"
    else
      echo "herdr-web: not responding on http://127.0.0.1:${LOCAL_PORT}"
    fi
    ;;
  doctor)
    ts version
    echo
    ts status --json | node -e '
      let s=""; process.stdin.on("data", c => s += c).on("end", () => {
        const d=JSON.parse(s);
        console.log(`backend: ${d.BackendState || "unknown"}`);
        console.log(`device: ${(d.Self?.DNSName || "unknown").replace(/\.$/, "")}`);
      });'
    if bridge_ready; then
      echo "bridge: ready"
    else
      echo "bridge: not responding"
      exit 1
    fi
    ;;
  *)
    echo "usage: $0 {serve|status|url|off|doctor}" >&2
    exit 2
    ;;
esac
