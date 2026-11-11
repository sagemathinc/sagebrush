import test from "node:test";
import assert from "node:assert/strict";

// A stack overflow inside a call into the multiprecision core (design/mpmath-core.md §4.5): a JS error that
// unwinds through the core's frames leaves it mid-call, borrowed for good, so that every later call would answer
// 0 (a hook's results read from a call before, wrong values).  The binding retires the instance on any such
// error.  Deterministically, by no recursion limit: each call below is made at every depth from the stack's end
// up, one frame more each time, until one completes, so some attempt runs out of stack at each point of the call,
// the core's own frames included; then the session is used again and exact.
const DIST = __dirname + "/..";

test("a stack overflow at any point of a core call: the session exact after it", () => {
  process.env.SAGEBRUSH_MPMATH_BACKEND = "sagebrush";
  const c = require(DIST + "/src/compile.js");
  const Obj = require(DIST + "/src/runtime/object.js");
  c.R.importModule("sys").path.push(c.libDir());
  const mpmath = c.R.importModule("mpmath");
  const core = c.R.importModule("_sagebrush_mpcore");
  const fme = Obj.getattr(core, "from_man_exp");
  const mp = Obj.getattr(mpmath, "mp"), mpf = Obj.getattr(mp, "mpf");
  // (at 300 bits: a 201-bit mantissa kept whole, then 53 again)
  const at300 = (f: () => any) => {
    Obj.setattr(mp, "prec", 300);
    try {
      return f();
    } finally {
      Obj.setattr(mp, "prec", 53);
    }
  };
  const two = Obj.callObj(mpf, [2]), three = Obj.callObj(mpf, [3]);
  const div = Obj.getattr(two, "__truediv__");
  // (an mpf of 201 bits, packed: its limbs copied in before the core runs, the result's copied out after)
  const big = at300(() => Obj.callObj(mpf, [2n ** 200n + 1n])), bigAdd = Obj.getattr(big, "__add__");
  // (call at the stack's end, then one frame up at a time: the first that completes returns, and so on up)
  // (and again with each frame larger by 1 to 24 arguments, so that the stack's end moves by a word at a time
  // across the call, not by whole frames)
  const sweep = (call: () => any) => {
    let attempts = 0;
    for (let pad = 0; pad <= 24; pad++) {
      const args = Array.from({ length: pad }, (_, i) => "a" + i).join(", ");
      const deep = new Function("call", "count", `const deep = (${args}) => { try { deep(${args}); } catch {} count(); return call(); }; return deep;`)(call, () => attempts++);
      deep(...Array(pad).fill(0));
    }
    return attempts;
  };
  const exact = () => {
    assert.deepEqual([...fme(3, -1)], [0, 3, -1, 2]);
    assert.deepEqual([...Obj.getattr(Obj.callObj(mpf, [1.5]), "_mpf_")], [0, 3, -1, 2]);
    assert.deepEqual([...Obj.getattr(div(three), "_mpf_")], [0, 6004799503160661, -53, 53]);
    assert.deepEqual([...Obj.getattr(at300(() => bigAdd(big)), "_mpf_")], [0, 2n ** 200n + 1n, 1, 201]);
  };
  exact();
  for (const [what, call] of [
    ["a hook (from_man_exp)", () => fme(3, -1)],
    ["mpf's fast arithmetic", () => div(three)],
    ["mpf's fast arithmetic on limbs", () => at300(() => bigAdd(big))],
    ["a hook whose result is limbs", () => fme(2n ** 200n + 1n, 0)],
  ] as [string, () => any][]) {
    assert.ok(sweep(call) > 1, `${what}: the stack's end reached`);
    exact();
  }
});
