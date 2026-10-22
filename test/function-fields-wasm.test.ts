import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function instance() {
  const bytes = readFileSync(join(__dirname, "..", "..", "wasm", "sagebrush-engine.wasm"));
  return new WebAssembly.Instance(
    new WebAssembly.Module(bytes),
    { sagebrush: { interrupted: () => 0 } },
  ).exports as any;
}

function call(e: any, entry: "sb_call" | "sb_sym_call", request: string): string {
  const req = new TextEncoder().encode(request);
  const p = e.sb_alloc(req.length);
  new Uint8Array(e.memory.buffer, p, req.length).set(req);
  const r = e[entry](p, req.length);
  const out = new TextDecoder().decode(new Uint8Array(e.memory.buffer, r, e.sb_reply_len()));
  e.sb_free(p, req.length);
  return out;
}

test("R0a's rebuilt wasm baseline and retained-reply envelope fit the 64 MiB partition", () => {
  const e = instance();
  const resident = e.memory.buffer.byteLength;
  assert.ok(resident <= 12 << 20, `resident wasm memory is ${resident} bytes`);

  // R0a itself is in the compiled Magma adapter and owns no wasm allocation.
  // Exercise the shared ABI's maximal prior-reply slot independently: the
  // symbolic identity call returns a canonical payload just below 4 MiB.
  const name = "r".repeat((4 << 20) - 64);
  const old = call(e, "sb_sym_call", `sym\x1f${name}`);
  assert.ok(old.length < 4 << 20);
  assert.ok(old.length > (4 << 20) - 128);
  const afterOld = e.memory.buffer.byteLength;

  // The next request replaces the retained reply.  WebAssembly memory never
  // shrinks, so this is also an upper bound for the measured peak.
  assert.equal(call(e, "sb_call", '{"fn":"nmod_charpoly","m":"1","p":"7"}'), '{"ok":["6","1"]}');
  const peak = e.memory.buffer.byteLength;
  assert.ok(peak < 64 << 20, `wasm peak is ${peak} bytes`);
  console.log(`function fields R0a wasm: resident ${resident}, prior-reply ${afterOld}, peak ${peak} bytes`);
});
