import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// T_p on S_k(Gamma0(N)) by twisted traces (the engine's cusp_hecke_matrix)
// through the real WebAssembly engine (sb_alloc, sb_call, sb_free): the
// same matrices as natively, the same meter units (pinned natively in
// engine/modsym/tests/hecke_q.rs: the setups' candidates are deterministic
// and the parallel jobs' units are added at their joins), no prime set
// aside, and a level with a square factor (roots of unity of order 2).

function instance() {
  const bytes = readFileSync(join(__dirname, "..", "..", "wasm", "sagebrush-engine.wasm"));
  return new WebAssembly.Instance(new WebAssembly.Module(bytes), { sagebrush: { interrupted: () => 0 } }).exports as any;
}

function call(e: any, request: string): any {
  const req = new TextEncoder().encode(request);
  const p = e.sb_alloc(req.length);
  new Uint8Array(e.memory.buffer, p, req.length).set(req);
  const r = e.sb_call(p, req.length);
  const out = new TextDecoder().decode(new Uint8Array(e.memory.buffer, r, e.sb_reply_len()));
  e.sb_free(p, req.length);
  return JSON.parse(out);
}

const hecke = (e: any, n: number, k: number, q: number, prec: number) => {
  const r = call(e, JSON.stringify({ fn: "cusp_hecke_matrix", n, k, q, prec }));
  assert.ok(r.ok, JSON.stringify(r));
  return r.ok;
};

test("cusp_hecke_matrix in WebAssembly: matrices, units and statistics", () => {
  const e = instance();
  // S_2(37) at T_3 and S_2(11) at T_2: the units pinned natively, and
  // T_2 = -2 on S_2(11)
  const h = hecke(e, 37, 2, 3, 8);
  assert.equal(h.dim, 2);
  assert.deepEqual(h.units.map(Number), [577, 0, 79, 0, 112, 709, 3922, 0, 0, 0]);
  assert.equal(h.stats.e, 1);
  assert.deepEqual(h.stats.rejected, { dimension: 0, degree: 0, separation: 0, minor: 0 });
  const h11 = hecke(e, 11, 2, 2, 4);
  assert.deepEqual(h11.units.map(Number), [90, 0, 44, 0, 10, 133, 1194, 0, 0, 0]);
  assert.deepEqual([h11.matrix, h11.den], [[["-2"]], "1"]);
  // a square factor: 36 = 6^2, e = lambda(6) = 2
  const h36 = hecke(e, 36, 2, 5, 14);
  assert.equal(h36.stats.e, 2);
  assert.equal(h36.dim, 1);
  assert.deepEqual([h36.matrix, h36.den], [[["0"]], "1"]);
});
