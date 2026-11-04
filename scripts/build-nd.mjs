// Build engine/nd as the browser/Node WebAssembly module wasm/sagebrush-nd.wasm (numerics-core r4.2, B1):
// SIMD128, threads (atomics, a shared imported memory up to 4 GiB) and an exported stack pointer, so that
// each worker instance runs on its own stack. Committed, like wasm/sagebrush-engine.wasm, so that building
// sagebrush does not require Rust.  Run: node scripts/build-nd.mjs
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.env.CARGO_TARGET_DIR ?? join(root, "engine", "target");
const flags = [
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
execFileSync("cargo", ["build", "--release", "--target", "wasm32-unknown-unknown", "-p", "sagebrush-nd"], {
  cwd: join(root, "engine"),
  stdio: "inherit",
  env: { ...process.env, RUSTFLAGS: flags, CARGO_TARGET_DIR: target },
});
const built = join(target, "wasm32-unknown-unknown", "release", "sagebrush_nd.wasm");
const bytes = readFileSync(built);
new WebAssembly.Module(bytes); // validate
copyFileSync(built, join(root, "wasm", "sagebrush-nd.wasm"));
console.log(`wasm/sagebrush-nd.wasm: ${bytes.length} bytes`);
