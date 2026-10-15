// Build Sagebrush's PNG module (engine/raster: tiny-skia drawing of its plots'
// SVG, PNG reading with limits) for wasm32 and write wasm/sagebrush-raster.wasm,
// which is committed so that building sagebrush does not need Rust.  It is
// optimized for size (it is downloaded the first time a PNG is written or
// read) and stripped of its custom sections.  Run: node scripts/build-raster.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.env.CARGO_TARGET_DIR ?? join(root, "engine", "target");
execFileSync("cargo", ["build", "--release", "-p", "sagebrush-raster", "--target", "wasm32-unknown-unknown"], {
  cwd: join(root, "engine"),
  stdio: "inherit",
  env: { ...process.env, CARGO_TARGET_DIR: target, CARGO_PROFILE_RELEASE_OPT_LEVEL: "z" },
});
const wasm = readFileSync(join(target, "wasm32-unknown-unknown", "release", "sagebrush_raster.wasm"));
const out = join(root, "wasm", "sagebrush-raster.wasm");
writeFileSync(out, stripCustomSections(wasm));
new WebAssembly.Module(readFileSync(out)); // validate
console.log(`raster: ${readFileSync(out).length} bytes`);

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
