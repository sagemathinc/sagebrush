#!/usr/bin/env bash
# One VM's build for the shard driver (bench/core/shard.py), run once, before any point, from the payload: a git
# archive of the plan's commit (no .git; .bench-commit names the commit). It installs only public packages and
# builds this tree; no credentials are on the VM or needed. It exits non-zero on any failure, which stops the
# machine type (the same commit would fail the same way on another VM).
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$(pwd)
t0=$SECONDS
# FLINT 3.6.0's release tarball, as published (the Rust FLINT oracle links it statically)
FLINT_URL=https://github.com/flintlib/flint/releases/download/v3.6.0/flint-3.6.0.tar.gz
FLINT_SHA256=b95e2c7792f5eea4a1c8d2d42c4098434756832e57a094b295eb5dfdc9b4c36b
TC=$(sed -n 's/^channel = "\(.*\)"/\1/p' engine/rust-toolchain.toml)
rustup target add --toolchain "$TC" wasm32-wasip1 >/dev/null
sudo apt-get update -q >/dev/null
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q m4 libgmp-dev libmpfr-dev libopenblas-dev >/dev/null
# the engine's Python package, and python-flint (pinned) for the reference column
uv venv --seed --python 3.14 engine/.venv >/dev/null
uv pip install --python engine/.venv/bin/python maturin python-flint==0.9.0 >/dev/null
(cd engine/py && ../.venv/bin/maturin build --release -i ../.venv/bin/python --out dist >/dev/null)
uv pip install --python engine/.venv/bin/python engine/py/dist/*.whl >/dev/null
# the WebAssembly modules, built with CI's path mapping, then the CLI that embeds the engine
pnpm install --frozen-lockfile >/dev/null
RUSTFLAGS="--remap-path-prefix=$HOME/.cargo=/home/runner/.cargo" node scripts/build-engine.mjs >/dev/null
node scripts/check-fresh-wasm.mjs || echo "warning: the fresh engine wasm differs from wasm/pins.json (run.py records engine_pin; the driver refuses an unpinned engine)"
pnpm run build >/dev/null
node scripts/build-cli.mjs >/dev/null
# static FLINT for the Rust oracle, from the checked tarball
P=$HOME/flint-prefix
if [ ! -f "$P/lib/libflint.a" ]; then
  rm -rf "$HOME/flint-src" && mkdir -p "$P/lib" "$HOME/flint-src" && cd "$HOME/flint-src"
  curl -fsSL -o flint.tar.gz "$FLINT_URL"
  echo "$FLINT_SHA256  flint.tar.gz" | sha256sum -c - >/dev/null
  tar xzf flint.tar.gz && cd flint-3.6.0
  ./configure --prefix="$P" --enable-static --disable-shared --with-blas >/dev/null
  make -j"$(nproc)" >/dev/null && make install >/dev/null
  for l in gmp mpfr; do ln -sf "$(find /usr/lib -name "lib$l.a" | head -1)" "$P/lib/"; done
  ln -sf "$(find /usr/lib -name libopenblas.a | head -1)" "$P/lib/libopenblas.a"
  cd "$ROOT"
fi
# the bench drivers: native, native-host, WASI and the Rust FLINT oracle
SAGEBRUSH_FLINT_PREFIX=$P python3 bench/core/run.py --build --dry-run --mem-cap none >/dev/null
echo "== built in $((SECONDS - t0)) s"
