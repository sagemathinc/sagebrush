// The wasm column's runner: a wasm32-wasip1 module (bench/core/native built
// for WASI) under Node's WASI, with the driver protocol's arguments.
//   node wasi_run.mjs MODULE CASE N MODE K
// No preopened directories and no environment: the module sees only its
// arguments, a clock and stdout/stderr.  Its exit code passes through.
import { readFile } from "node:fs/promises";
import { WASI } from "node:wasi";

const [file, ...args] = process.argv.slice(2);
const wasi = new WASI({ version: "preview1", args: [file, ...args], env: {}, returnOnExit: true });
const module = await WebAssembly.compile(await readFile(file));
const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
process.exitCode = wasi.start(instance);
