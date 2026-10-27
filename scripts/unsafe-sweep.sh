#!/bin/bash
# The compiler half of the engine's unsafe boundary (#234 r2 U1): cargo check's JSON over every compile view,
# under the RUSTFLAGS the engine-unsafe-sweep job sets (they make the compiler report every unsafe site,
# whatever allows it).  scripts/unsafe-inventory.mjs --compiler then checks each site against the pinned items.
#   RUSTFLAGS=... scripts/unsafe-sweep.sh OUTDIR
# Views: the host workspace (all targets; flint and oracle, the test-only FLINT crates, as engine-rust excludes
# them); the packages whose features gate unsafe-relevant code, with all their features; the three wasm32
# modules; interrupt for x86_64-pc-windows-msvc (its cfg(windows) handler).  Each view's elapsed time goes
# to OUTDIR/timings.txt.  A view's own compile errors don't stop the others (each is collected separately).
set -uo pipefail
OUT=${1:?usage: unsafe-sweep.sh OUTDIR}
mkdir -p "$OUT"
[ -n "${RUSTFLAGS:-}" ] || { echo "RUSTFLAGS is empty: the sweep would report only unallowed sites" >&2; exit 2; }
cd "$(dirname "$0")/../engine"
t() { local n=$1; shift; local s=$(date +%s.%N) rc=0; "$@" > "$OUT/$n.json" 2> "$OUT/$n.err" || rc=$?; echo "$n rc=$rc seconds=$(echo "$(date +%s.%N) - $s" | bc)" | tee -a "$OUT/timings.txt"; }
s=$(date +%s.%N); rustup target add x86_64-pc-windows-msvc > "$OUT/rustup.log" 2>&1; echo "msvc-std-install rc=$? seconds=$(echo "$(date +%s.%N) - $s" | bc)" | tee -a "$OUT/timings.txt"
cargo metadata --format-version 1 --locked > "$OUT/metadata.json" 2> "$OUT/metadata.err" || { echo "cargo metadata failed (rejects)" >&2; cat "$OUT/metadata.err" >&2; exit 3; }
t host-default  cargo check --message-format=json --workspace --all-targets --exclude sagebrush-flint --exclude sagebrush-oracle
t host-features cargo check --message-format=json --all-targets --all-features -p sagebrush-ledger -p sagebrush-interrupt -p sagebrush-poly -p sagebrush-py
t wasm          cargo check --message-format=json --target wasm32-unknown-unknown -p sagebrush-web -p sagebrush-raster -p sagebrush-growth-probe --lib
t windows       cargo check --message-format=json --target x86_64-pc-windows-msvc -p sagebrush-interrupt --all-targets --all-features
