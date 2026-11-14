import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// n() of a constant expression whose double evaluation gives NaN asks the
// 53-bit MP evaluation (lib/_sage_expr.py Expression.n).  These two answers are
// Sagebrush's own, not Sage's, so they are pinned here rather than in
// sage-tests/test_exp_field.sage, whose output must equal Sage's:
// - a complex value past CC's doubles is refused, not given as NaN + NaN*I
//   (Sage, whose CC has MPFR's exponent range, gives 3.14159265358979e400*I);
// - an MP value that is NaN too never stands in for the doubles' answer: the
//   doubles' NaN + NaN*I is kept (Sage raises RuntimeError for sin(Infinity)).
const CLI = __dirname + "/../src/cli.js";

function sage(code: string): { out: string; err: string } {
  const r = spawnSync(process.execPath, [CLI, "--sage", "-c", code], { encoding: "utf8", timeout: 120_000 });
  return { out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

test("n(): a complex value past CC's doubles is refused, not NaN", () => {
  const r = sage("print(N(10^400*I*pi))");
  assert.equal(r.out, "");
  assert.match(r.err.split("\n").pop() ?? "", /^NotImplementedError: the value in CC is 3\.14159265358979e400\*I, past the double range of CC's numbers in sagebrush$/);
});

test("n(): an MP NaN never replaces the doubles' answer", () => {
  const r = sage("x = N(SR('10^400*pi*sin(Infinity)')); print(x, '|', x.parent())");
  assert.equal(r.out, "NaN + NaN*I | Complex Field with 53 bits of precision", r.err);
});

test("n(): a real value past the doubles is the MP value in RR", () => {
  const r = sage("x = N(10^400*pi); print(x, '|', x.parent())");
  assert.equal(r.out, "3.14159265358979e400 | Real Field with 53 bits of precision", r.err);
});
