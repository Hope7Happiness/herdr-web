#!/usr/bin/env bash
# Install Herdr's native agent instructions plus the RC-specific workflow.
set -euo pipefail

plugin_root="$(cd "$(dirname "$0")/.." && pwd)"
skill_source="$plugin_root/skills/herdr-rc-remote"
codex_root="${CODEX_HOME:-$HOME/.codex}"
skill_parent="$codex_root/skills"
skill_target="$skill_parent/herdr-rc-remote"
marker="$skill_target/.managed-by-herdr-rc"
herdr_skill_target="$skill_parent/herdr"
herdr_marker="$herdr_skill_target/.managed-by-herdr-rc"
herdr_cmd="${HERDR_BIN_PATH:-herdr}"

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

# `herdr --skill` is the version-matched source of truth for native pane,
# workspace, and agent operations. It prints the skill but does not install it.
# Never replace a user-managed skill with the same name.
if [ -L "$herdr_skill_target" ]; then
  echo "Refusing to install through symlink at $herdr_skill_target" >&2
  exit 1
fi
if [ -e "$herdr_skill_target" ] && [ ! -f "$herdr_marker" ]; then
  echo "Existing Codex skill left unchanged: $herdr_skill_target"
  exit 0
fi
if ! command -v "$herdr_cmd" >/dev/null 2>&1; then
  echo "Herdr CLI not found; cannot install its native Codex skill" >&2
  exit 1
fi

herdr_skill="$($herdr_cmd --skill)"
if ! grep -q '^name: herdr$' <<<"$herdr_skill"; then
  echo "herdr --skill returned an invalid skill document" >&2
  exit 1
fi
mkdir -p "$herdr_skill_target"
printf '%s\n' "$herdr_skill" > "$herdr_skill_target/SKILL.md"
touch "$herdr_marker"
echo "Installed Codex skill: $herdr_skill_target"
