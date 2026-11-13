#!/usr/bin/env bash
# Build everything from a clean checkout (DEVELOPMENT.md): the Rust engine as WebAssembly, the TypeScript, the
# single-file CLI, the notebook page, the board package, the Node addon, the Python wheel and the MCP package,
# and the desktop app (Tauri). Each step is timed; a summary prints at the end.
#
#   scripts/build-all.sh             # everything
#   scripts/build-all.sh --no-app    # without the Tauri app (no Tauri CLI or WebKitGTK needed)
#   scripts/build-all.sh --no-engine # fetch the four WebAssembly modules by their pins instead (no Rust needed for them)
#
# The prerequisites and their versions are DEVELOPMENT.md's. This script checks them first and stops on a
# missing one, and on a bun older than CI's pin (an older Bun.build gives the build no metafile); another
# version that differs from CI's pin is a warning (budgets that record exact bytes or heap would then differ).
set -euo pipefail
cd "$(dirname "$0")/.."
APP=1 ENGINE=1
for a in "$@"; do
  case "$a" in
    --no-app) APP=0 ;;
    --no-engine) ENGINE=0 ;;
    -h|--help) sed -n 2,13p "$0"; exit 0 ;;
    *) echo "unknown option: $a"; exit 2 ;;
  esac
done

need() { command -v "$1" > /dev/null || { echo "missing: $1 ($2; see DEVELOPMENT.md)"; exit 1; }; }
pin() { [ "$2" = "$3" ] || echo "warning: $1 is $2; CI pins $3 (DEVELOPMENT.md)"; }
need node "Node.js 24.21.0"
need pnpm "pnpm 11"
need bun "bun 1.4.4"
need uv "uv"
need cargo "Rust via rustup (engine/rust-toolchain.toml pins the engine's toolchain)"
need rustup "rustup"
pin node "$(node --version)" v24.21.0
# (at least CI's bun: an older one's Bun.build gives web/build.ts no metafile, issue #511; a newer one is a warning)
if [ "$(printf '%s\n' 1.4.4 "$(bun --version)" | sort -V | head -1)" != 1.4.4 ]; then
  echo "bun $(bun --version) is older than 1.4.4, CI's pin, which the build needs: bun upgrade (or curl -fsSL https://bun.sh/install | bash -s bun-v1.4.4)"
  exit 1
fi
pin bun "$(bun --version)" 1.4.4
case "$(pnpm --version)" in 11.*) ;; *) echo "warning: pnpm is $(pnpm --version); CI uses pnpm 11" ;; esac
if [ "$APP" = 1 ]; then need tauri "the Tauri 2 CLI: npm install -g @tauri-apps/cli@^2, or --no-app"; fi
# (on Linux the app links against WebKitGTK; without its development files the Tauri build fails late, at the link)
if [ "$APP" = 1 ] && [ "$(uname -s)" = Linux ] && ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
  echo "missing: WebKitGTK 4.1's development files, which the desktop app needs on Linux:"
  echo "  sudo apt-get install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf"
  echo "(or build without the app: scripts/build-all.sh --no-app)"
  exit 1
fi

summary=()
step() {
  local name=$1; shift
  local t0=$SECONDS
  echo
  echo "== $name"
  "$@"
  summary+=("$(printf '%5ds  %s' $((SECONDS - t0)) "$name")")
}

step "dependencies (pnpm install)" pnpm install --frozen-lockfile
if [ "$ENGINE" = 0 ]; then
  step "the WebAssembly modules, by their pins (wasm/pins.json)" node scripts/wasm-fetch.mjs
fi
if [ "$ENGINE" = 1 ]; then
  # (rustup installs engine/rust-toolchain.toml's toolchain and wasm32 target on first use. The modules embed the
  # crate registry's paths; mapped to CI's, a fresh build matches wasm/pins.json: README)
  step "the engine as WebAssembly (wasm/sagebrush-engine.wasm)" env RUSTFLAGS="--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/home/runner/.cargo${RUSTFLAGS:+ $RUSTFLAGS}" node scripts/build-engine.mjs
fi
step "TypeScript (dist/)" pnpm run build
step "the CLI (build/cli/pyjs.cjs)" node scripts/build-cli.mjs
# (web/build.ts exits 3 when the bundles' npm packages changed and the notices are stale: write them, as
# scripts/third-party-notices.mjs does, and build again; CI's own check stays strict)
web_page() {
  local rc=0
  bun web/build.ts || rc=$?
  if [ "$rc" = 3 ]; then
    echo "build-all: writing the third-party notices (node scripts/third-party-notices.mjs; commit them with your change), then building the page again"
    node scripts/third-party-notices.mjs && bun web/build.ts
  else
    return "$rc"
  fi
}
step "the notebook page (web/dist)" web_page
# (again, as CI does: the CLI embeds the page's assets)
step "the CLI again, with the page" node scripts/build-cli.mjs
step "the board package (packages/sagebrush-board)" bash -c 'cd packages/sagebrush-board && bun build.mjs'
step "the Node addon (engine/node/sagebrush.node)" engine/node/build.sh
step "Python 3.14 and maturin (engine/.venv)" bash -c '[ -x engine/.venv/bin/python ] || uv venv --seed --python 3.14 engine/.venv; uv pip install --python engine/.venv/bin/python maturin'
step "the Python wheel (engine/py/dist)" bash -c 'cd engine/py && ../.venv/bin/maturin build --release -i ../.venv/bin/python --out dist'
step "the MCP package (engine/py-mcp/dist)" uv build engine/py-mcp --out-dir engine/py-mcp/dist
if [ "$APP" = 1 ]; then
  step "the app's page (app/dist)" node app/build-frontend.mjs
  step "the desktop app (app/src-tauri/target/release/bundle)" bash -c 'cd app/src-tauri && tauri build'
fi

echo
echo "== build-all: done"
printf '%s\n' "${summary[@]}"
echo "total $((SECONDS / 60)) min $((SECONDS % 60)) s"
# (with the paths mapped, a fresh build matches its pin; a difference is real: another toolchain, or engine/ changed
# without its pins updated. node scripts/wasm-fetch.mjs --force restores the pinned modules)
if [ "$ENGINE" = 1 ]; then
  if node scripts/check-fresh-wasm.mjs >/dev/null; then echo "the fresh modules match wasm/pins.json"
  else echo "warning: the fresh modules differ from wasm/pins.json (DEVELOPMENT.md: the engine)"; node scripts/check-fresh-wasm.mjs | tail -n +2; fi
fi
