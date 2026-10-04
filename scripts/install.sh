#!/bin/sh
# Install the sagebrush command (one self-contained executable).
#
#   curl -fsSL https://get.sagebrush.space/install.sh | sh
#
# Environment:
#   SAGEBRUSH_VERSION      a release tag such as v0.1.1 (default: latest)
#   SAGEBRUSH_INSTALL_DIR  where to put the binary (default: ~/.local/bin,
#                          or /usr/local/bin when run as root)
set -eu

base="https://get.sagebrush.space"
fail() {
  echo "sagebrush installer: $*" >&2
  exit 1
}
command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v xz >/dev/null 2>&1 || fail "xz is required (e.g. apt install xz-utils, brew install xz)"

case "$(uname -s):$(uname -m)" in
  Linux:x86_64 | Linux:amd64) target=x86_64-unknown-linux-gnu ;;
  Linux:aarch64 | Linux:arm64) target=aarch64-unknown-linux-gnu ;;
  Darwin:arm64 | Darwin:aarch64) target=aarch64-apple-darwin ;;
  Darwin:x86_64) target=x86_64-apple-darwin ;;
  *) fail "unsupported platform $(uname -s)/$(uname -m) (Windows: download from https://github.com/sagemathinc/sagebrush/releases)" ;;
esac

version="${SAGEBRUSH_VERSION:-}"
if [ -z "$version" ]; then
  version=$(curl -fsSL "$base/latest" | tr -d '[:space:]') || fail "could not determine the latest version"
fi
case "$version" in v*) ;; *) version="v$version" ;; esac

if [ -n "${SAGEBRUSH_INSTALL_DIR:-}" ]; then
  dir="$SAGEBRUSH_INSTALL_DIR"
elif [ "$(id -u)" -eq 0 ]; then
  dir=/usr/local/bin
else
  [ -n "${HOME:-}" ] || fail "HOME is not set; set SAGEBRUSH_INSTALL_DIR"
  dir="$HOME/.local/bin"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
file="sagebrush-$target.xz"
echo "Downloading sagebrush $version for $target ..."
curl -fSL --progress-bar "$base/releases/$version/$file" -o "$tmp/$file" || fail "download failed"
curl -fsSL "$base/releases/$version/SHA256SUMS" -o "$tmp/SHA256SUMS" || fail "could not download checksums"
want=$(grep " $file\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)
[ -n "$want" ] || fail "no checksum for $file"
if command -v sha256sum >/dev/null 2>&1; then
  got=$(sha256sum "$tmp/$file" | cut -d' ' -f1)
else
  got=$(shasum -a 256 "$tmp/$file" | cut -d' ' -f1)
fi
[ "$got" = "$want" ] || fail "checksum mismatch for $file"
xz -d "$tmp/$file"
mkdir -p "$dir"
chmod +x "$tmp/sagebrush-$target"
mv "$tmp/sagebrush-$target" "$dir/sagebrush"
echo "Installed $dir/sagebrush ($("$dir/sagebrush" -V 2>/dev/null || echo "$version"))"
case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "Add $dir to your PATH, e.g.:  export PATH=\"$dir:\$PATH\"" ;;
esac
