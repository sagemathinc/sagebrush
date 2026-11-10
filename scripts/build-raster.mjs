// Build Sagebrush's PNG module (engine/raster: tiny-skia drawing of its plots'
// SVG, PNG reading with limits) for wasm32 and write wasm/sagebrush-raster.wasm,
// which is committed so that building sagebrush does not need Rust.  It is
// optimized for size (it is downloaded the first time a PNG is written or
// read) and stripped of its custom sections.  scripts/build-engine.mjs rebuilds
// it too, so the engine-wasm job's check-fresh-wasm.mjs holds it to its source.
//   Run: node scripts/build-raster.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installWasm } from "./install-engine-wasm.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// (its own target directory: its profile settings differ from the engine's, and sharing one would rebuild both
// each time.  The module's panic messages name the registry crates' source files, so the cargo home is written
// as CI's, /home/runner/.cargo, as scripts/build-all.sh does for the engine: a build here and CI's are the
// same bytes)
export function buildRaster(target = join(process.env.CARGO_TARGET_DIR ?? join(root, "engine", "target"), "raster")) {
  const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
  const remap = `--remap-path-prefix=${cargoHome}=/home/runner/.cargo`;
  // (the allocator built for speed, as std builds its own: the heap is the
  // engine's hottest code, and at opt-level z it costs some 2.6% of a render)
  execFileSync("cargo", ["build", "--release", "-p", "sagebrush-raster", "--target", "wasm32-unknown-unknown", "--config", "profile.release.package.dlmalloc.opt-level=3"], {
    cwd: join(root, "engine"),
    stdio: "inherit",
    env: { ...process.env, CARGO_TARGET_DIR: target, CARGO_PROFILE_RELEASE_OPT_LEVEL: "z", RUSTFLAGS: process.env.RUSTFLAGS ? `${remap} ${process.env.RUSTFLAGS}` : remap },
  });
  const built = join(target, "wasm32-unknown-unknown", "release", "sagebrush_raster.wasm");
  const stripped = built.replace(/\.wasm$/, ".stripped.wasm");
  writeFileSync(stripped, stripCustomSections(readFileSync(built)));
  new WebAssembly.Module(readFileSync(stripped)); // validate
  return installWasm(stripped, join(root, "wasm", "sagebrush-raster.wasm"));
}

// The module without its custom sections (names, producers, debug info).
function stripCustomSections(b) {
  const parts = [b.subarray(0, 8)];
  let i = 8;
  while (i < b.length) {
    const start = i;
    const id = b[i++];
    let size = 0, shift = 0, byte;
    do {
      byte = b[i++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    i += size;
    if (id !== 0) parts.push(b.subarray(start, i));
  }
  return Buffer.concat(parts);
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(`raster: ${buildRaster()} bytes`);
