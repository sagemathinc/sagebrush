// Build the Sagebrush engines (engine/web: modular symbols, a_p, ...) for
// wasm32 and write wasm/sagebrush-engine.wasm (and engine/nd's wasm/sagebrush-nd.wasm, scripts/build-nd.mjs, the PNG module's
// wasm/sagebrush-raster.wasm, scripts/build-raster.mjs, the multiprecision core's wasm/sagebrush-mp.wasm,
// scripts/build-mp.mjs, and the decision-tree kernel's wasm/sagebrush-skltree.wasm, scripts/build-skltree.mjs).  Their sha256 and length are pinned in wasm/pins.json, and the published
// modules are fetched by those pins (scripts/wasm-fetch.mjs), so building sagebrush does not need Rust.  Run: node scripts/build-engine.mjs
import { execFileSync } from "node:child_process";
import { foreignSources, installWasm, namesLocalCargoHome, remappedRustflags, withTargetLock } from "./install-engine-wasm.mjs";
import { buildNd } from "./build-nd.mjs";
import { buildRaster } from "./build-raster.mjs";
import { buildMp } from "./build-mp.mjs";
import { buildSkltree } from "./build-skltree.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.env.CARGO_TARGET_DIR ?? join(root, "engine", "target");
// (each module this checkout's own build: the target may be shared with other checkouts, scripts/engine-cache.mjs;
// a module whose dep-info names another checkout's sources is refused, the engine's before it is installed)
const own = (module, what) => {
  const foreign = foreignSources(module, root);
  if (foreign.length) {
    throw new Error(`${what}: ${module} isn't this checkout's build: its dep-info names ${foreign.slice(0, 3).join(" ")}${foreign.length > 3 ? ` (${foreign.length} sources)` : ""}`);
  }
};
const release = (dir, name) => join(dir, "wasm32-unknown-unknown", "release", `${name}.wasm`);
withTargetLock(target, () => {
  // (the Cargo home written as CI's: the module's panic messages name the crates' source files, so a build here gives
  // CI's bytes and its pin; the PNG and multiprecision builders do the same)
  execFileSync("cargo", ["build", "--release", "-p", "sagebrush-web", "--target", "wasm32-unknown-unknown"], {
    cwd: join(root, "engine"),
    stdio: "inherit",
    env: { ...process.env, CARGO_TARGET_DIR: target, RUSTFLAGS: remappedRustflags() },
  });
  const src = release(target, "sagebrush_web");
  own(src, "engine");
  new WebAssembly.Module(readFileSync(src)); // validate
  installWasm(src, join(root, "wasm", "sagebrush-engine.wasm"));
  console.log(`engine: ${readFileSync(src).length} bytes`);
  // (and the numerics core's module, numerics-core r4.2: check-fresh-wasm.mjs then holds both to their sources)
  console.log(`nd: ${buildNd(join(target, "nd"))} bytes`);
  own(release(join(target, "nd"), "sagebrush_nd"), "nd");
  // (and the PNG module, engine/raster, likewise held to its source)
  console.log(`raster: ${buildRaster(join(target, "raster"))} bytes`);
  own(release(join(target, "raster"), "sagebrush_raster"), "raster");
  // (and the multiprecision core, engine/mp, likewise held to its source)
  console.log(`mp: ${buildMp(join(target, "mp"))} bytes`);
  own(release(join(target, "mp"), "sagebrush_mp"), "mp");
  // (and the decision-tree kernel, engine/skltree, likewise held to its source)
  console.log(`skltree: ${buildSkltree(join(target, "skltree"))} bytes`);
  own(release(join(target, "skltree"), "sagebrush_skltree"), "skltree");
});
// (a module that still names this machine's Cargo home wasn't remapped, and can't equal its pin: refused)
for (const name of ["sagebrush-engine.wasm", "sagebrush-nd.wasm", "sagebrush-raster.wasm", "sagebrush-mp.wasm", "sagebrush-skltree.wasm"]) {
  if (namesLocalCargoHome(readFileSync(join(root, "wasm", name)))) {
    console.error(`wasm/${name} names this machine's Cargo home: its build didn't remap it to CI's (--remap-path-prefix)`);
    process.exit(1);
  }
}
