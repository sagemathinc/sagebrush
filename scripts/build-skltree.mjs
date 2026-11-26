// Build Sagebrush's decision-tree kernel (engine/skltree; the design note sklearn-trees r3) for wasm32 and
// write wasm/sagebrush-skltree.wasm, which is pinned (wasm/pins.json) and fetched so that building sagebrush
// does not need Rust.  Single-threaded, with no SIMD (the tree arithmetic must give scikit-learn's bits on
// every host: no vector code, no fused multiply-adds, which WebAssembly has only in relaxed SIMD) and no
// atomics or shared memory, so it instantiates on any page; test/skltree-wasm.test.ts holds the shipped
// bytes to that, opcode by opcode.  Optimized for speed (it grows trees), with the allocator as the PNG
// module's, and stripped of its custom sections.  Its panic messages name the registry crates' source files,
// so the cargo home is written as CI's, /home/runner/.cargo (remappedRustflags, as the other builders do): a
// build here and CI's are the same bytes.  Run: node scripts/build-skltree.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installWasm, remappedRustflags, stripCustomSections } from "./install-engine-wasm.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// (its own target directory: its RUSTFLAGS differ from the engine's)
export function buildSkltree(target = join(process.env.CARGO_TARGET_DIR ?? join(root, "engine", "target"), "skltree")) {
  const features = "-C target-feature=-simd128,-relaxed-simd";
  const own = process.env.RUSTFLAGS ? `${features} ${process.env.RUSTFLAGS}` : features;
  execFileSync("cargo", ["build", "--release", "-p", "sagebrush-skltree", "--target", "wasm32-unknown-unknown", "--config", "profile.release.package.dlmalloc.opt-level=3"], {
    cwd: join(root, "engine"),
    stdio: "inherit",
    env: { ...process.env, CARGO_TARGET_DIR: target, RUSTFLAGS: remappedRustflags({ ...process.env, RUSTFLAGS: own }) },
  });
  const built = join(target, "wasm32-unknown-unknown", "release", "sagebrush_skltree.wasm");
  const stripped = built.replace(/\.wasm$/, ".stripped.wasm");
  writeFileSync(stripped, stripCustomSections(readFileSync(built)));
  new WebAssembly.Module(readFileSync(stripped)); // validate
  return installWasm(stripped, join(root, "wasm", "sagebrush-skltree.wasm"));
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(`skltree: ${buildSkltree()} bytes`);
