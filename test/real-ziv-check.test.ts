import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// The Ziv check of RealNumberMP's functions (lib/_sage_real.py _ziv_checked),
// driven by synthetic methods whose error at a working precision Wf is
// 2^-(Wf/4): the value at 2W is then on the wrong side of a rounding
// boundary while |a - b| (the W and 2W values' difference) still covers it,
// so only the rule that takes |a - b| as the error retries and rounds right;
// a value that stays on a boundary is refused after the last doubling.
const TS = (src: string) =>
  execFileSync(process.execPath, [__dirname + "/../src/cli.js", "--sage", "-c", src], { encoding: "utf8", timeout: 120000 });

const FAKE = [
  "import _sage_real as sr",
  "from fractions import Fraction as Q",
  "def make(T):",
  "    def fake(self):",
  "        F = self._R",
  "        return F(T - Q(1, 2 ** (F._prec // 4)))",
  "    return fake",
].join("\n");

test("the Ziv check retries while |a - b| covers a boundary, then rounds right", () => {
  // 1 + 2^-20 is the midpoint of RealField(20)'s numbers 1 and 1 + 2^-19;
  // the value, 2^-40 above it, rounds up; at W = 52 the 2W value is 2^-26
  // below the value, under the midpoint
  const out = TS(FAKE + "\n" + [
    "sr.RealNumberMP._fake = make(1 + Q(1, 2 ** 20) + Q(1, 2 ** 40))",
    "f = sr._ziv_checked('_fake')",
    "R = RealField(20)",
    "print(f(R(5)) == R(1) + R(2) ^ -19, f(R(5)).sign_mantissa_exponent())",
  ].join("\n"));
  assert.equal(out, "True (1, 524289, -19)\n");
});

test("the Ziv check fails closed on a value that stays on a boundary", () => {
  const out = TS(FAKE + "\n" + [
    "sr.RealNumberMP._fake = make(1 + Q(1, 2 ** 20))",
    "f = sr._ziv_checked('_fake')",
    "try:",
    "    print(f(RealField(20)(5)))",
    "except NotImplementedError as _err:",
    "    print('refused')",
  ].join("\n"));
  assert.equal(out, "refused\n");
});

// (the TESTS reviewer's case: a coarse and a finer value both wrong, then
// settled; the rule rejects both disagreeing intervals and visits the widths
// 40/80, 80/160, 160/320, where the margin-only rule returned 9/8)
test("the Ziv check rejects two disagreeing intervals before settling", () => {
  const out = TS([
    "import _sage_real as r",
    "from fractions import Fraction as F",
    "R = r.RealField_(8, 'RNDN')",
    "calls = []",
    "def fake(x):",
    "    w = x._R._prec",
    "    calls.append(w)",
    "    return x._R(1 if w == 40 else F(9, 8) if w == 80 else F(5, 4))",
    "r.RealNumberMP._fake = fake",
    "got = r._ziv_checked('_fake')(R(1))",
    "print(got == R(F(5, 4)), calls, r._ziv_depth)",
  ].join("\n"));
  assert.equal(out, "True [40, 80, 80, 160, 160, 320] [0]\n");
});
