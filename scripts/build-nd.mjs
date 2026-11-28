// Build engine/nd as the browser/Node WebAssembly module wasm/sagebrush-nd.wasm (numerics-core r4.2, B1):
// SIMD128, threads (atomics, a shared imported memory up to 4 GiB) and an exported stack pointer, so that
// each worker instance runs on its own stack. Pinned and fetched, like wasm/sagebrush-engine.wasm (wasm/pins.json),
// so that building sagebrush does not require Rust; scripts/build-engine.mjs rebuilds it too, so the engine-wasm job's
// check-fresh-wasm.mjs holds it to its source.  Run: node scripts/build-nd.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installWasm, remappedRustflags, relaunchUnderTargetLock } from "./install-engine-wasm.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FLAGS = [
  "-C target-feature=+simd128,+atomics,+bulk-memory,+mutable-globals",
  "-C link-arg=--shared-memory",
  "-C link-arg=--import-memory",
  "-C link-arg=--max-memory=4294967296",
  "-C link-arg=--export=__stack_pointer",
  // (the precompiled core library, whose panic paths the bounds checks pull in, was not compiled with the
  // atomics feature, and stable Rust cannot rebuild it: wasm-ld would refuse a shared memory. Those paths keep
  // no state shared between threads (a panic is an abort, `unreachable`), so linking them is sound)
  "-C link-arg=--no-check-features",
].join(" ");

// (its own target directory: these RUSTFLAGS differ from the engine's, and sharing one would rebuild both each time)
export function buildNd(target = join(process.env.CARGO_TARGET_DIR ?? join(root, "engine", "target"), "nd")) {
  execFileSync("cargo", ["build", "--release", "--target", "wasm32-unknown-unknown", "-p", "sagebrush-nd"], {
    cwd: join(root, "engine"),
    stdio: "inherit",
    // (its own flags, not the caller's, after the Cargo home written as CI's: nd names no registry file today, but a
    // dependency that panics with its path would otherwise make a local build differ from the pin, #1899)
    env: { ...process.env, RUSTFLAGS: remappedRustflags({ ...process.env, RUSTFLAGS: FLAGS }), CARGO_TARGET_DIR: target },
  });
  const built = join(target, "wasm32-unknown-unknown", "release", "sagebrush_nd.wasm");
  new WebAssembly.Module(readFileSync(built)); // validate
  return installWasm(built, join(root, "wasm", "sagebrush-nd.wasm"));
}

// (run on its own: holding the target's lock as build-engine.mjs does, install-engine-wasm.mjs relaunchUnderTargetLock)
if (import.meta.url === `file://${process.argv[1]}`) {
  const locked = relaunchUnderTargetLock(process.env.CARGO_TARGET_DIR ?? join(root, "engine", "target"), [process.execPath, process.argv[1], ...process.argv.slice(2)]);
  if (locked !== null) process.exit(locked);
  console.log(`wasm/sagebrush-nd.wasm: ${buildNd()} bytes`);
}
