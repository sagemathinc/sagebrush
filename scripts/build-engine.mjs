// Build the Sagebrush engines (engine/web: modular symbols, a_p, ...) for
// wasm32 and write wasm/sagebrush-engine.wasm (and engine/nd's wasm/sagebrush-nd.wasm, scripts/build-nd.mjs, and the PNG module's
// wasm/sagebrush-raster.wasm, scripts/build-raster.mjs), which is committed so that
// building sagebrush does not need Rust.  Run: node scripts/build-engine.mjs
import { execFileSync } from "node:child_process";
import { installWasm } from "./install-engine-wasm.mjs";
import { buildNd } from "./build-nd.mjs";
import { buildRaster } from "./build-raster.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.env.CARGO_TARGET_DIR ?? join(root, "engine", "target");
execFileSync("cargo", ["build", "--release", "-p", "sagebrush-web", "--target", "wasm32-unknown-unknown"], {
  cwd: join(root, "engine"),
  stdio: "inherit",
  env: { ...process.env, CARGO_TARGET_DIR: target },
});
const src = join(target, "wasm32-unknown-unknown", "release", "sagebrush_web.wasm");
new WebAssembly.Module(readFileSync(src)); // validate
installWasm(src, join(root, "wasm", "sagebrush-engine.wasm"));
console.log(`engine: ${readFileSync(src).length} bytes`);
// (and the numerics core's module, numerics-core r4.2: check-fresh-wasm.mjs then holds both to their sources)
console.log(`nd: ${buildNd(join(target, "nd"))} bytes`);
// (and the PNG module, engine/raster, likewise held to its source)
console.log(`raster: ${buildRaster(join(target, "raster"))} bytes`);
