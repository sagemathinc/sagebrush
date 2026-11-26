import test from "node:test";
import assert from "node:assert/strict";
import { RetiredDebt, type Register } from "../src/runtime/retired-debt";

// The retired instances' debt (src/runtime/retired-debt.ts, the engine's R_ret mechanism for the runtime's other
// modules; the design note sklearn-trees r3 §6, LIMITS' L2): charged at retirement, at the memory's size then;
// removed only when BOTH the memory and its last buffer are reported collected; repeats and unknown ids are no-ops;
// an inexact sum fails closed for good; without finalizers the debt only grows.
function fake(): { reg: Register; ids: Map<object, number> } {
  const ids = new Map<object, number>();
  return { reg: (target, id) => void ids.set(target, id), ids };
}

test("a retired memory stays charged until both it and its buffer are collected", () => {
  const { reg, ids } = fake();
  const d = new RetiredDebt(reg);
  const mem = new WebAssembly.Memory({ initial: 3 });
  const buf = mem.buffer;
  d.retire(mem);
  assert.equal(d.bytes(), 3 * 65536);
  const id = ids.get(mem)!;
  assert.equal(ids.get(buf), id);
  d.collected(id, "memory");
  d.collected(id, "memory");
  assert.equal(d.bytes(), 3 * 65536, "the buffer is still alive");
  d.collected(id, "buffer");
  assert.equal(d.bytes(), 0);
  assert.equal(d.count, 0);
  d.collected(id, "buffer");
  d.collected(999, "memory");
  assert.equal(d.bytes(), 0);
  // (the size at retirement: a memory that grew first is charged at its grown size)
  const m2 = new WebAssembly.Memory({ initial: 1 });
  m2.grow(4);
  d.retire(m2);
  assert.equal(d.bytes(), 5 * 65536);
});

test("an inexact sum fails closed for good; without finalizers nothing is ever removed", () => {
  const d = new RetiredDebt(null);
  d.sum = 2 ** 53 - 65536;
  d.retire(new WebAssembly.Memory({ initial: 2 }));
  assert.equal(d.overflow, true);
  assert.equal(d.bytes(), Infinity);
  const n = new RetiredDebt(null);
  n.retire(new WebAssembly.Memory({ initial: 1 }));
  n.retire(new WebAssembly.Memory({ initial: 1 }));
  assert.equal(n.bytes(), 2 * 65536);
  assert.equal(n.count, 2);
});
