#!/usr/bin/env bash
# Install the agent-facing RC workflow alongside the Herdr plugin.
set -euo pipefail

plugin_root="$(cd "$(dirname "$0")/.." && pwd)"
skill_source="$plugin_root/skills/herdr-rc-remote"
codex_root="${CODEX_HOME:-$HOME/.codex}"
skill_parent="$codex_root/skills"
skill_target="$skill_parent/herdr-rc-remote"
marker="$skill_target/.managed-by-herdr-rc"

mkdir -p "$skill_parent"
if [ -L "$skill_target" ]; then
  echo "Refusing to install through symlink at $skill_target" >&2
  exit 1
fi
if [ -e "$skill_target" ] && [ ! -f "$marker" ]; then
  echo "Refusing to overwrite non-RC skill at $skill_target" >&2
  exit 1
fi

mkdir -p "$skill_target"
cp -R "$skill_source/." "$skill_target/"
touch "$marker"
chmod 755 "$skill_target/scripts/herdr-rc.mjs"
echo "Installed Codex skill: $skill_target"
