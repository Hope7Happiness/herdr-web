#!/usr/bin/env bash
# Verify the repo the way a stranger sees it.
#
# Two failure modes this catches:
#  1. Video attachments uploaded through a comment box that was never
#     submitted — they work while YOU are logged in and 404 for everyone
#     else. Always run this after adding media.
#  2. Relative markdown links pointing at files that do not exist.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0

echo "== attachment URLs (anonymous) =="
for u in $(grep -rho "https://github.com/user-attachments/assets/[a-f0-9-]*" README.md docs/ | sort -u); do
  code=$(curl -s -o /dev/null -w "%{http_code}" -L --max-time 25 "$u")
  where=$(grep -rl "$u" README.md docs/ | tr '\n' ' ')
  if [ "$code" = "200" ]; then
    printf '  ok   %s\n' "${u##*/}"
  else
    printf '  %s  %s   <- %s\n' "$code" "${u##*/}" "$where"
    fail=1
  fi
done

echo "== relative markdown links =="
while IFS= read -r line; do
  file="${line%%:*}"
  link="${line#*:}"
  dir=$(dirname "$file")
  target="${link%%#*}"
  [ -z "$target" ] && continue
  if [ ! -e "$dir/$target" ]; then
    printf '  MISSING %s -> %s\n' "$file" "$link"
    fail=1
  fi
done < <(grep -rhoE '\]\([^)#][^)]*\)' README.md docs/*.md docs/demos/*.md 2>/dev/null \
          | sed 's/^](//; s/)$//' | grep -v '^https\?://' | sort -u \
          | while read -r l; do grep -rl -- "]($l)" README.md docs/*.md docs/demos/*.md 2>/dev/null | sed "s|\$|:$l|"; done)

[ "$fail" = 0 ] && echo "ALL LINKS OK" || echo "BROKEN LINKS FOUND"
exit $fail
