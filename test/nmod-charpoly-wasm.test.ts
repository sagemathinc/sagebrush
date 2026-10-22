import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// engine/web's nmod_charpoly through the real WebAssembly ABI (sb_alloc,
// sb_call, sb_free): the largest admitted request (NMOD_MAX_N = 512) grows
// the instance's memory by less than the closed-form bound of
// engine/web/src/lib.rs (17 MiB), with headroom: 24 MiB; and a request
// past NMOD_MAX_REQUEST is refused without parsing it.
function instance() {
  const bytes = readFileSync(join(__dirname, "..", "..", "wasm", "sagebrush-engine.wasm"));
  return new WebAssembly.Instance(new WebAssembly.Module(bytes), { sagebrush: { interrupted: () => 0 } }).exports as any;
}

function call(e: any, request: string): string {
  const req = new TextEncoder().encode(request);
  const p = e.sb_alloc(req.length);
  new Uint8Array(e.memory.buffer, p, req.length).set(req);
  const r = e.sb_call(p, req.length);
  const out = new TextDecoder().decode(new Uint8Array(e.memory.buffer, r, e.sb_reply_len()));
  e.sb_free(p, req.length);
  return out;
}

test("nmod_charpoly's largest admitted request stays within its memory bound in wasm", (t) => {
  const e = instance();
  const small = call(e, '{"fn":"nmod_charpoly","m":"1,2;3,4","p":"7","wire":"csv"}');
  if (small.includes("unknown fn")) return t.skip("this engine build predates nmod_charpoly (rebuilt at merge)");
  assert.equal(small, '{"ok":"5,2,1"}');
  const n = 512, p = 9223372036854775783n; // the largest prime below 2^63: 19-digit entries
  let seed = 1n;
  const rows: string[] = [];
  for (let i = 0; i < n; i++) {
    const row: string[] = [];
    for (let j = 0; j < n; j++) {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) % p;
      row.push(String(seed));
    }
    rows.push(row.join(","));
  }
  const req = `{"fn":"nmod_charpoly","m":"${rows.join(";")}","p":"${p}","wire":"csv"}`;
  const before = e.memory.buffer.byteLength;
  const reply = call(e, req);
  const grown = e.memory.buffer.byteLength - before;
  assert.ok(reply.startsWith('{"ok":"'), reply.slice(0, 200));
  assert.equal(reply.split(",").length, n + 1);
  // (memory never shrinks: the growth bounds the peak above what was resident)
  assert.ok(grown < 24 << 20, `grew by ${grown} bytes`);
  // 513 rows: refused
  const over = `{"fn":"nmod_charpoly","m":"${Array(n + 1).fill("0").join(";")}","p":"7"}`;
  assert.match(call(e, over), /rows, more than 512/);
  // past NMOD_MAX_REQUEST: refused before serde
  const huge = `{"fn":"nmod_charpoly","p":"7","m":"${"0".repeat(n * n * 20 + n + 4097)}"}`;
  const before2 = e.memory.buffer.byteLength;
  assert.match(call(e, huge), /the request has \d+ bytes/);
  console.log(`nmod_charpoly wasm: grew ${grown} bytes for n = ${n}; the oversized request grew ${e.memory.buffer.byteLength - before2} (its own bytes)`);
});
