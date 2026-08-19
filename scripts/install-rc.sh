#!/usr/bin/env bash
# Install herdr-web into the current user's Herdr and expose it privately
# through Tailscale. Intended for:
#   curl -fsSL .../scripts/install-rc.sh | bash
set -euo pipefail

PLUGIN_REPO="${HERDR_RC_PLUGIN_REPO:-Hope7Happiness/herdr-web}"
PLUGIN_REF="${HERDR_RC_PLUGIN_REF:-master}"
PLUGIN_ID="hope7happiness.herdr-web"
ACTION_ID="${PLUGIN_ID}.tailscale-serve"
HERDR_CMD="${HERDR_BIN_PATH:-herdr}"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}

need "$HERDR_CMD"
need node
need npm

if ! "$HERDR_CMD" status server --json >/dev/null 2>&1; then
  echo "Herdr is not running. Open Herdr, then run this installer again." >&2
  exit 1
fi

echo "Installing phone RC plugin from ${PLUGIN_REPO}@${PLUGIN_REF}..."
"$HERDR_CMD" plugin install "$PLUGIN_REPO" --ref "$PLUGIN_REF" --yes

# v0.5.x installed herdr-mirror as a second plugin. v0.6 vendors the same
# source and owns its lifecycle. Only migrate configurations RC itself wrote;
# a user-managed mirror plugin is never disabled here.
mirror_config="$HOME/.config/herdr/plugins/config/mirror/hosts.toml"
if [ -f "$mirror_config" ] && head -n 1 "$mirror_config" | grep -qx '# Managed by hope7happiness.herdr-web'; then
  "$HERDR_CMD" plugin action invoke pause --plugin mirror >/dev/null 2>&1 || true
  "$HERDR_CMD" plugin disable mirror >/dev/null 2>&1 || true
fi

echo "Starting RC and configuring private Tailscale access..."
invoke_json="$("$HERDR_CMD" plugin action invoke "$ACTION_ID")"
log_id="$(printf '%s' "$invoke_json" | node -e '
  let s=""; process.stdin.on("data", c => s += c).on("end", () => {
    const id=JSON.parse(s)?.result?.log?.log_id;
    if (!id) process.exit(1);
    process.stdout.write(id);
  });'
)"

for _attempt in $(seq 1 60); do
  logs_json="$("$HERDR_CMD" plugin log list --plugin "$PLUGIN_ID" --limit 20)"
  parsed="$(
    printf '%s' "$logs_json" | RC_LOG_ID="$log_id" node -e '
      let s=""; process.stdin.on("data", c => s += c).on("end", () => {
        const logs=JSON.parse(s)?.result?.logs || [];
        const log=logs.find(x => x.log_id === process.env.RC_LOG_ID);
        if (!log) return process.stdout.write("missing\n");
        process.stdout.write(`${log.status}\n${log.stdout || ""}${log.stderr || ""}`);
      });'
  )"
  status="${parsed%%$'\n'*}"
  output="${parsed#*$'\n'}"
  case "$status" in
    succeeded)
      printf '%s\n' "$output"
      echo "RC setup complete."
      exit 0
      ;;
    failed)
      printf '%s\n' "$output" >&2
      echo "RC setup failed. Inspect: herdr plugin log list --plugin ${PLUGIN_ID}" >&2
      exit 1
      ;;
  esac
  sleep 0.25
done

echo "RC setup is still running. Inspect:" >&2
echo "  herdr plugin log list --plugin ${PLUGIN_ID}" >&2
exit 1
