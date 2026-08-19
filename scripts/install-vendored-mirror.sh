#!/usr/bin/env bash
# Build the vendored mirror source when Cargo is available. Release installs
# without Rust fetch an RC-built, checksum-verified native executable instead.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT/vendor/herdr-mirror/Cargo.toml"
DEST="$ROOT/vendor/herdr-mirror/target/release/herdr-mirror"
RELEASE="${HERDR_RC_MIRROR_RELEASE:-v0.7.1}"
BASE="${HERDR_RC_MIRROR_ASSET_BASE:-https://github.com/Hope7Happiness/herdr-web/releases/download/${RELEASE}}"

if command -v cargo >/dev/null 2>&1; then
  echo "Building vendored herdr-mirror source..."
  cargo build --release --locked --manifest-path "$MANIFEST"
  exit 0
fi

case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *) echo "Unsupported local OS: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch="aarch64" ;;
  x86_64|amd64) arch="x86_64" ;;
  *) echo "Unsupported local architecture: $(uname -m)" >&2; exit 1 ;;
esac

asset="herdr-rc-mirror-${os}-${arch}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --retry 2 -o "$tmp/$asset" "$BASE/$asset"
curl -fsSL --retry 2 -o "$tmp/SHA256SUMS" "$BASE/SHA256SUMS"
expected="$(grep " ${asset}\$" "$tmp/SHA256SUMS")" || {
  echo "$asset is missing from $BASE/SHA256SUMS" >&2
  exit 1
}
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$tmp" && printf '%s\n' "$expected" | sha256sum -c -)
else
  (cd "$tmp" && printf '%s\n' "$expected" | shasum -a 256 -c -)
fi
mkdir -p "$(dirname "$DEST")"
install -m 755 "$tmp/$asset" "$DEST"
if [ "$os" = darwin ]; then
  xattr -d com.apple.quarantine "$DEST" 2>/dev/null || true
  xattr -d com.apple.provenance "$DEST" 2>/dev/null || true
fi
echo "Installed RC-built $asset at $DEST"
