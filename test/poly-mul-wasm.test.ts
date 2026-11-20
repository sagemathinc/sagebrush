import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// poly_mul's product through the real WebAssembly ABI (sb_alloc, sb_call),
// where its NTT runs on 32-bit digits: the host's interrupt flag is asked at
// least once per 2^16 butterflies across the split, the transforms, Garner
// and the repacking, and a Stop at the middle of a run traps (the host then
// discards the instance; a fresh instance computes the same product).

function instance(interrupted: () => number = () => 0) {
  const bytes = readFileSync(join(__dirname, "..", "..", "wasm", "sagebrush-engine.wasm"));
  return new WebAssembly.Instance(new WebAssembly.Module(bytes), { sagebrush: { interrupted } }).exports as any;
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

test("poly_mul's 32-bit NTT asks the host at least every 2^16 butterflies, and a Stop mid-run traps", () => {
  // (2^17 x 2^17 one-digit coefficients: 2^17 points of u64 words, 2^18 of
  // 32-bit digits, three primes)
  const a = Array(1 << 17).fill("f").join(",");
  const b = Array(1 << 17).fill("-7").join(",");
  const req = `{"fn":"poly_mul","a":"${a}","b":"${b}"}`;
  let asked = 0;
  const e = instance(() => (asked++, 0));
  const full = call(e, req);
  if (full.includes("unknown fn")) return;
  assert.ok(full.startsWith('{"ok":"'), full.slice(0, 200));
  // three primes, three transforms of 2^18 points and 18 stages: 9 * 2^17 * 18 butterflies
  const butterflies = 9 * (1 << 17) * 18;
  assert.ok(asked >= butterflies / (1 << 16), `asked ${asked} times for ${butterflies} butterflies`);
  let k = 0;
  const half = asked >> 1;
  const e2 = instance(() => (k++ >= half ? 1 : 0));
  assert.throws(() => call(e2, req), WebAssembly.RuntimeError);
  assert.equal(call(instance(), req), full);
  console.log(`poly_mul 2^17 x 2^17 in wasm: ${asked} host checks`);
});
