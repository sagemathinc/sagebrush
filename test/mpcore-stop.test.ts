import test from "node:test";
import assert from "node:assert/strict";

// Stop in the multiprecision binding's word loops (design/mpmath-core.md §4.5),
// deterministically, by no clock: the binding's Stop polls (ops.pollInterrupt,
// called through the module object) are wrapped so that the first one made
// from the loop a row is about (the binding's frame that polls: wordsOf,
// manOf, or the fast path's copy-out, f) requests Ctrl-C, then polls as usual.  Each loop
// (an int's limbs, a result's copy-out, an int made from limbs) is stopped
// with a KeyboardInterrupt, and the session is then used again and exact.
// The numbers have 2^17 words, so each loop polls at least once.
const DIST = __dirname + "/..";

test("Stop in the mpmath binding's word loops: a KeyboardInterrupt, then the session exact again", () => {
  process.env.SAGEBRUSH_MPMATH_BACKEND = "sagebrush";
  const c = require(DIST + "/src/compile.js");
  const O = require(DIST + "/src/runtime/ops.js");
  const { requestCtrlC } = require(DIST + "/src/runtime/interrupt.js");
  c.R.importModule("sys").path.push(c.libDir());
  const poll = O.pollInterrupt;
  let armed: string | null = null;
  let fired = 0;
  O.pollInterrupt = () => {
    // (the frame that called this poll: the stack's third line, after Error and this wrapper)
    const caller = String(new Error().stack).split("\n")[2] ?? "";
    if (armed !== null && caller.includes("mpcore.js") && new RegExp(`at ${armed} `).test(caller)) {
      armed = null;
      fired++;
      requestCtrlC();
    }
    return poll();
  };
  // (each run is a fresh __main__: the setup, then the row)
  const SETUP = [
        "from mpmath import mp, libmp",
        "from mpmath.libmp import libmpf",
        "B = 64 * 2**16 - 1",
        "T = (0, (1 << B) - 1, 0, B)",
        "mp.prec = 2 * B + 8",
        "X = mp.make_mpf(T)",
        "def stopped(f):",
        "    try:",
        "        f()",
        "    except KeyboardInterrupt:",
        "        return True",
        "    return False",
        "def exact():",
        "    mp.prec = 53",
        "    assert (mp.mpf(1) / 3)._mpf_ == (0, 6004799503160661, -54, 53)",
        "    mp.prec = 2 * B + 8",
      ].join("\n");
  const run = (code: string) => {
    try {
      c.execModule(SETUP + "\n" + code, "<mpcore-stop>", "__main__");
    } catch (e) {
      throw new Error(c.R.formatException(e));
    }
  };
  try {
    // (row, the loop's frame, the code; X * X also makes X's big form, in wordsOf, which the copy-out row's
    // arming doesn't match)
    const rows: [string, string, string][] = [
      ["an int's limbs (libmp)", "wordsOf", "libmpf.mpf_add(T, libmp.fone, 0, 'n')"],
      ["a big form made from a tuple", "wordsOf", "mp.make_mpf(T) + mp.make_mpf(T)"],
      ["a result copied out", "f", "X * X"],
      ["an int made from limbs (libmp)", "manOf", "libmpf.mpf_mul(T, T, 0, 'n')"],
      ["a big form's _mpf_", "manOf", "(X * X)._mpf_"],
    ];
    // (mpmath imported, and its import-time conversions done, before anything is armed)
    run("exact()");
    for (const [what, frame, expr] of rows) {
      armed = frame;
      const before = fired;
      run(`assert stopped(lambda: ${expr}), ${JSON.stringify(what)}\nexact()`);
      assert.equal(fired, before + 1, `${what}: ${frame}'s poll requested the Stop`);
      // (the same call, unstopped, completes)
      run(`assert not stopped(lambda: ${expr})\nexact()`);
    }
  } finally {
    O.pollInterrupt = poll;
  }
});
