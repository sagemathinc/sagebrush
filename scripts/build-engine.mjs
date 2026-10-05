// Build the Sagebrush engines (engine/web: modular symbols, a_p, ...) for
// wasm32 and write wasm/sagebrush-engine.wasm, which is committed so that
// building sagebrush does not need Rust.  Run: node scripts/build-engine.mjs
import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
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
copyFileSync(src, join(root, "wasm", "sagebrush-engine.wasm"));
console.log(`engine: ${readFileSync(src).length} bytes`);
