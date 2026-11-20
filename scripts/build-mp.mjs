// Build Sagebrush's multiprecision core (engine/mp; design/mpmath-core.md) for
// wasm32 and write wasm/sagebrush-mp.wasm, which is pinned (wasm/pins.json) and fetched so that
// building sagebrush does not need Rust.  Optimized for size (it is
// downloaded the first time mpmath runs on it, under the hard cap of
// design §6.2) and stripped of its custom sections.  Its panic messages name
// the registry crates' source files, so the cargo home is written as CI's,
// /home/runner/.cargo (as scripts/build-all.sh does for the engine): a build
// here and CI's are the same bytes.  Run: node scripts/build-mp.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installWasm, stripCustomSections } from "./install-engine-wasm.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// (its own target directory: its profile settings differ from the engine's)
export function buildMp(target = join(process.env.CARGO_TARGET_DIR ?? join(root, "engine", "target"), "mp")) {
  const remap = `--remap-path-prefix=${process.env.CARGO_HOME ?? join(homedir(), ".cargo")}=/home/runner/.cargo`;
  // (the allocator built for speed, as the PNG module's)
  execFileSync("cargo", ["build", "--release", "-p", "sagebrush-mp", "--target", "wasm32-unknown-unknown", "--config", "profile.release.package.dlmalloc.opt-level=3"], {
    cwd: join(root, "engine"),
    stdio: "inherit",
    env: { ...process.env, CARGO_TARGET_DIR: target, CARGO_PROFILE_RELEASE_OPT_LEVEL: "z", RUSTFLAGS: process.env.RUSTFLAGS ? `${remap} ${process.env.RUSTFLAGS}` : remap },
  });
  const built = join(target, "wasm32-unknown-unknown", "release", "sagebrush_mp.wasm");
  const stripped = built.replace(/\.wasm$/, ".stripped.wasm");
  writeFileSync(stripped, stripCustomSections(readFileSync(built)));
  new WebAssembly.Module(readFileSync(stripped)); // validate
  return installWasm(stripped, join(root, "wasm", "sagebrush-mp.wasm"));
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(`mp: ${buildMp()} bytes`);
