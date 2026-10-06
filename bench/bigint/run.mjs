// The benchmark compiled to WebAssembly (wasm32-wasip1, without GMP), run
// under Node's WASI, i.e. V8's WebAssembly as in Chrome:
//   cargo build --release --target wasm32-wasip1 --no-default-features
//   node run.mjs [-- --max-bits N ...]
import { readFileSync } from "node:fs";
import { WASI } from "node:wasi";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.removeAllListeners("warning"); // the WASI ExperimentalWarning would land in the CSV
const here = dirname(fileURLToPath(import.meta.url));
const wasi = new WASI({ version: "preview1", args: ["bigint-bench", ...process.argv.slice(2)], env: {} });
const mod = await WebAssembly.compile(readFileSync(join(here, "target/wasm32-wasip1/release/bigint-bench.wasm")));
const inst = await WebAssembly.instantiate(mod, wasi.getImportObject());
wasi.start(inst);
