// Build engine/nd as the browser/Node WebAssembly module wasm/sagebrush-nd.wasm (numerics-core r4.2, B1):
// SIMD128, threads (atomics, a shared imported memory up to 4 GiB) and an exported stack pointer, so that
// each worker instance runs on its own stack. Committed, like wasm/sagebrush-engine.wasm, so that building
// sagebrush does not require Rust; scripts/build-engine.mjs rebuilds it too, so the engine-wasm job's
// check-fresh-wasm.mjs holds it to its source.  Run: node scripts/build-nd.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installWasm } from "./install-engine-wasm.mjs";

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

// The two modules (numerics-core P2a): the deterministic SIMD128 one, and the relaxed-SIMD FMA one that
// browsers validating relaxed SIMD load instead (web/threads/page.ts). Each has its own target directory:
// their RUSTFLAGS differ from each other's and from the engine's, and sharing one would rebuild all each time.
export const MODULES = [
  { file: "sagebrush-nd.wasm", dir: "nd", flags: FLAGS },
  { file: "sagebrush-nd-fma.wasm", dir: "nd-fma", flags: FLAGS.replace("+simd128,", "+simd128,+relaxed-simd,") },
];

export function buildNd(target = join(process.env.CARGO_TARGET_DIR ?? join(root, "engine", "target"), "nd")) {
  const sizes = {};
  for (const m of MODULES) {
    // (the first module keeps `target` itself, as before; the others get sibling directories)
    const dir = m.dir === "nd" ? target : `${target}-${m.dir.slice(3)}`;
    execFileSync("cargo", ["build", "--release", "--target", "wasm32-unknown-unknown", "-p", "sagebrush-nd"], {
      cwd: join(root, "engine"),
      stdio: "inherit",
      env: { ...process.env, RUSTFLAGS: m.flags, CARGO_TARGET_DIR: dir },
    });
    const built = join(dir, "wasm32-unknown-unknown", "release", "sagebrush_nd.wasm");
    new WebAssembly.Module(readFileSync(built)); // validate
    sizes[m.file] = installWasm(built, join(root, "wasm", m.file));
  }
  return sizes;
}

if (import.meta.url === `file://${process.argv[1]}`) for (const [f, n] of Object.entries(buildNd())) console.log(`wasm/${f}: ${n} bytes`);
