// The dispatcher fixtures (designated_errors.jsonl, designated_ok.jsonl)
// against the WebAssembly engine: the same answers as natively, and no trap
// (a 32-bit usize must not change a request's meaning).
//   node engine/web/tests/wasm_designated.mjs [path/to/sagebrush-engine.wasm]
import { readFileSync } from "node:fs";
const here = new URL(".", import.meta.url);
const wasmPath = process.argv[2] ?? new URL("../../../wasm/sagebrush-engine.wasm", here).pathname;
const module = new WebAssembly.Module(readFileSync(wasmPath));
let w = null;
const fresh = () => (w = new WebAssembly.Instance(module, { sagebrush: { interrupted: () => 0 } }).exports);
fresh();
function call(line) {
  const b = new TextEncoder().encode(line);
  const p = w.sb_alloc(b.length);
  new Uint8Array(w.memory.buffer, p, b.length).set(b);
  try {
    const r = w.sb_call(p, b.length);
    return new TextDecoder().decode(new Uint8Array(w.memory.buffer, r, w.sb_reply_len()));
  } catch (e) {
    fresh(); // a trapped instance is unusable
    return "TRAP " + e.message;
  }
}
let fail = 0;
for (const [file, want] of [["designated_errors.jsonl", '{"error"'], ["designated_ok.jsonl", '{"ok"']]) {
  for (const line of readFileSync(new URL(file, here), "utf8").split("\n").filter((l) => l.trim())) {
    const r = call(line);
    if (!r.startsWith(want)) { fail++; console.log("FAIL " + line + " -> " + r.slice(0, 200)); }
  }
}
console.log(fail ? `${fail} failures` : "wasm: every designated request as expected");
process.exit(fail ? 1 : 0);
