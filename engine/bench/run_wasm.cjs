// sagebrush.modsym from Node via WebAssembly (engine/web, the committed
// wasm/sagebrush-engine.wasm, through its JSON ABI): node run_wasm.cjs N q
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const [n, q] = process.argv.slice(2).map(Number);
const mod = new WebAssembly.Module(readFileSync(join(__dirname, "..", "..", "wasm", "sagebrush-engine.wasm")));
const w = new WebAssembly.Instance(mod, { sagebrush: { interrupted: () => 0 } }).exports;
const t = performance.now();
const req = new TextEncoder().encode(JSON.stringify({ fn: "hecke_charpoly", n, q, p: 67108859 }));
const p = w.sb_alloc(req.length);
new Uint8Array(w.memory.buffer, p, req.length).set(req);
const r0 = w.sb_call(p, req.length); // (read the buffer after the call: the call may grow the memory)
const reply = JSON.parse(new TextDecoder().decode(new Uint8Array(w.memory.buffer, r0, w.sb_reply_len())));
const ms = performance.now() - t;
if (!reply.ok) throw new Error(JSON.stringify(reply));
const r = reply.ok;
console.log(`N=${n} q=${q} dim=${r.dim} eisenstein_root=${r.eisenstein_root ? "True" : "False"} charpoly_hash=${r.hash}`);
console.log(`times: total ${ms.toFixed(0)} ms`);
