import test from "node:test";
import assert from "node:assert/strict";

// The multiprecision core's memory bound (design/mpmath-core.md §4.5): the core may grow its memory by at most
// MAX_PAGES (engine/wasmheap's bound, set by mp_begin); a growth past it is refused at its source.  A refusal
// is the call's MemoryError naming "The multiprecision core's working memory", never a TypeError or an
// internal-error message, and the session is exact after it.  The test reaches the live core by wrapping
// WebAssembly.Instance (each instance the binding makes), so that it can lower the bound (mp_begin again: from
// now on at most that many more pages) and, for the trap row, drive one.
const DIST = __dirname + "/..";

test("a refused growth in the core: MemoryError naming its working memory, then the session exact", () => {
  const Orig = WebAssembly.Instance;
  let live: any = null;
  let trapNext = false;
  let refuseCopy = false;
  // (each instance's exports, mp_run wrapped: when armed, the bound is set to no growth, a growth is asked for
  // and refused (recorded by the heap, as an infallible allocation's would be), and the call traps as such an
  // allocation's handle_alloc_error does: trapped() must read the refusal and raise MemoryError)
  (WebAssembly as any).Instance = function (m: WebAssembly.Module, imp: any) {
    const x = new Orig(m, imp).exports as any;
    const e: any = Object.assign({}, x);
    // (when armed, the next mpf copied in from the IO buffer has no room: its limbs are there already, and the
    // bound is set to no growth before the core copies them into a register)
    e.mp_set_fx = (...a: any[]) => {
      if (refuseCopy) {
        refuseCopy = false;
        x.mp_begin(0);
      }
      return x.mp_set_fx(...a);
    };
    e.mp_run = (...a: any[]) => {
      if (trapNext) {
        trapNext = false;
        x.mp_begin(0);
        assert.equal(x.mp_io(1 << 24), 0, "the growth refused");
        throw new WebAssembly.RuntimeError("unreachable");
      }
      return x.mp_run(...a);
    };
    live = x;
    return { exports: e };
  };
  try {
    process.env.SAGEBRUSH_MPMATH_BACKEND = "sagebrush";
    const c = require(DIST + "/src/compile.js");
    c.R.importModule("sys").path.push(c.libDir());
    const run = (code: string) => {
      try {
        c.execModule(code, "<mpcore-memory>", "__main__");
      } catch (e) {
        throw new Error(c.R.formatException(e));
      }
    };
    const SETUP = [
      "from mpmath import mp",
      "from mpmath.libmp import libmpf",
      "def refused(f):",
      "    try:",
      "        f()",
      "    except MemoryError as e:",
      "        assert \"The multiprecision core's working memory\" in str(e), str(e)",
      "        return True",
      "    return False",
      "def exact():",
      "    mp.prec = 53",
      "    assert (mp.mpf(1) / 3)._mpf_ == (0, 6004799503160661, -54, 53)",
      "    assert libmpf.mpf_add(T, libmpf.fone, 53, 'n') == (0, 1, 2097152, 1)",
      "B = 2**21",
      "T = (0, (1 << B) - 1, 0, B)",
      "U = (0, (1 << (8 * B)) - 1, 0, 8 * B)",
    ].join("\n");
    run(SETUP + "\nexact()");
    assert.ok(live, "the core is loaded");
    // (1) a big mantissa's copy into the core, refused (2^24 bits, U's first use: more than any block freed so far): the
    // core's MemoryError (it was a TypeError, the malformed tuple's, before), then the bound restored and the
    // session exact
    refuseCopy = true;
    run(SETUP + "\nassert refused(lambda: libmpf.mpf_add(U, libmpf.fone, 53, 'n'))");
    assert.equal(refuseCopy, false, "the copy was reached");
    live.mp_begin(16384);
    run(SETUP + "\nexact()");
    // (2) a trap after a refused growth (driven, as above: no Python input reaches an infallible allocation
    // past the bound within a test's time): MemoryError, not an internal error; the binding retires the
    // instance and the next call makes a new one, exact
    const before = live;
    trapNext = true;
    run(SETUP + "\nmp.prec = 53\nassert refused(lambda: mp.mpf(1) / 3)");
    run(SETUP + "\nexact()");
    assert.notEqual(live, before, "a new instance after the trap");
  } finally {
    (WebAssembly as any).Instance = Orig;
  }
});
