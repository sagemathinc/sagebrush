#!/bin/sh
# Sagebrush's runner for "Your computer (paired)", for people without uv:
#
#   curl -fsSL https://sagebrush.space/install.sh | sh          (not hosted yet: William's call, with the release)
#   sh scripts/install.sh [--port N]                            (from a checkout)
#
# It installs uv (https://docs.astral.sh/uv/, with uv's own installer) if neither uvx nor uv is on PATH, then runs the
# latest released sagebrush in uv's own Python: `uvx sagebrush@latest remote --loopback`.  No binaries of ours, no
# sudo, nothing written but uv's own install (~/.local/bin) and its cache.  For the person's own Python and packages,
# the sheet's other command is the one: python -m pip install -U sagebrush && python -m sagebrush remote --loopback.
set -eu

case "$(uname -s 2>/dev/null || echo unknown)" in
  MINGW* | MSYS* | CYGWIN* | Windows_NT)
    echo "sagebrush remote: not on Windows yet; run this in WSL (Windows Subsystem for Linux), where it works as on Linux." >&2
    exit 2
    ;;
esac

run() {
  if command -v uvx >/dev/null 2>&1; then
    exec uvx --refresh-package sagebrush sagebrush@latest remote --loopback "$@"
  fi
  if command -v uv >/dev/null 2>&1; then
    exec uv tool run --refresh-package sagebrush sagebrush@latest remote --loopback "$@"
  fi
  return 1
}

run "$@" || true
if ! command -v curl >/dev/null 2>&1; then
  echo "This needs curl to install uv (https://docs.astral.sh/uv/getting-started/installation/), or install uv yourself and run it again." >&2
  exit 1
fi
echo "Installing uv (https://docs.astral.sh/uv/), which runs Sagebrush in its own Python..." >&2
curl -LsSf https://astral.sh/uv/install.sh | sh
# (uv's installer puts uv and uvx in ~/.local/bin, or $XDG_BIN_HOME, or $UV_INSTALL_DIR; this shell's PATH may not have it yet)
PATH="${UV_INSTALL_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}:$HOME/.local/bin:$PATH"
export PATH
run "$@" || {
  echo "uv was installed, but uvx isn't on PATH: open a new terminal and run: uvx sagebrush@latest remote --loopback" >&2
  exit 1
}
