// An ideal compared with an element (Sage mode): I == f is I == R.ideal(f)
// for f in I's ring R (or a scalar of its base ring), built by R's own
// ideal() and compared as ideals, so it admits no work R.ideal(f) == I
// would not: the same answers, and the same refusals with the same
// messages, univariate and multivariate.  An element of another ring is
// unequal before any conversion.  The answers are Sage 10.10's
// (sage-tests/test_ideal_element_eq has the full table).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(__dirname, "..", "src", "cli.js");
const dir = mkdtempSync(join(tmpdir(), "sb-ideq-"));

function sage(code: string) {
  const f = join(dir, "t" + Math.random().toString(36).slice(2) + ".sage");
  writeFileSync(f, code);
  return spawnSync(process.execPath, [cli, "--sage", f], { encoding: "utf8" });
}

// (I == f and I == R.ideal(f) side by side, or the error each raises)
const both = [
  "def both(I, f):",
  "    def one(g):",
  "        try:",
  "            return repr(g())",
  "        except Exception as e:",
  "            return '%s: %s' % (type(e).__name__, e)",
  "    a, b = one(lambda: I == f), one(lambda: I == I.ring().ideal(f))",
  "    print(a == b, a)",
].join("\n");

test("I == f answers as I == R.ideal(f), univariate and multivariate", () => {
  const r = sage([
    both,
    "R.<t> = QQ[]; P.<u> = ZZ[]; S.<x,y> = QQ[]; G.<c,d> = GF(7)[]",
    "both(R.ideal(2*t), t); both(R.ideal(t^2), t); both(R.ideal(1), 3); both(R.ideal(0), 0); both(R.ideal(0), t)",
    "both(P.ideal(2*u), u); both(P.ideal(-u), u); both(P.ideal(2), -2); both(P.ideal(2), 4)",
    "both(S.ideal(x), 2*x); both(S.ideal(x, x^2), x); both(S.ideal(x, y), x); both(G.ideal(3*c), c)",
  ].join("\n"));
  assert.equal(r.stderr, "");
  assert.equal(r.stdout, [
    "True True", "True False", "True True", "True True", "True False",
    "True False", "True True", "True True", "True False",
    "True True", "True True", "True False", "True True", "",
  ].join("\n"));
});

test("I == f refuses as I == R.ideal(f) does, with the same message", () => {
  const r = sage([
    both,
    // (Groebner bases over ZZ are not implemented: an error, never a guess;
    // Sage answers False here)
    "A.<a,b> = ZZ[]; both(A.ideal(2*a), a)",
    // (Zmod(6): content 1 on both sides and neither leading coefficient a
    // unit: deciding needs the modulus's factorization, which #102 does not
    // do (a known gap): refused, both orders)
    "Z.<z> = Zmod(6)[]; both(Z.ideal(2*z + 3), 3*z + 2); both(Z.ideal(3*z + 2), 2*z + 3)",
  ].join("\n"));
  assert.equal(r.stderr, "");
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^True NotImplementedError: ideal equality for an ideal over ZZ \(Groebner bases over ZZ are not implemented/);
  for (const l of lines.slice(1)) {
    assert.equal(l, "True NotImplementedError: equality of ideals of a polynomial ring over Zmod(6), neither generator with a unit leading coefficient, is not supported yet (it needs the factorization of the modulus)");
  }
});

test("Zmod(n)[t]: the cheap sufficient checks first, with no factoring (CORR-SAGE102-R1-1)", () => {
  const r = sage([
    both,
    "R.<t> = Zmod(2^130)[]; I = R.ideal(2*t)",
    "print(I == I, I == 2*t, I == R.ideal(-2*t), I == -2*t, 2*t == I, R.ideal(2*t) == R.ideal(6*t), R.ideal(2*t) == 6*t + 2)",
  ].join("\n"));
  assert.equal(r.stderr, "");
  assert.equal(r.stdout, "True True True True True True False\n");
});

test("Zmod(n)[t]: the work is charged to ff.work before it starts, exact at the limit (LIMIT-SAGE102-ZMOD-1)", () => {
  // (S.WORK set here as the limits file would set it: _zmod_ideal_eq reads it
  // per comparison; the spy counts the divisions that actually start)
  const run = (W: number, setup: string, expr: string) => sage([
    "import _sage_frac as F, _sage_ffsub as S",
    "calls = [0]; orig = F._divmod_unit_lc",
    "def spy(*a):\n    calls[0] += 1\n    return orig(*a)",
    "F._divmod_unit_lc = spy",
    "S.WORK = " + W,
    setup,
    "try:\n    print(" + expr + ", calls[0])\nexcept NotImplementedError as e:\n    print('refused', e, calls[0])",
  ].join("\n"));
  // the unit-leading branch: (a) = (a (1 + 2t)), a = t^4999 + 1 over Zmod(4):
  // 6 (2 la + 1) + 2 (2 la + 4) + 2 (2 la + 15) = 20 la + 44 cops, la = 5000
  const big = "R.<t> = Zmod(4)[]; a = t^4999 + 1; b = a * (1 + 2*t)";
  let r = run(100044, big, "R.ideal(a) == R.ideal(b)");
  assert.equal(r.stdout, "True 1\n");
  r = run(100043, big, "R.ideal(a) == R.ideal(b)");
  assert.equal(r.stdout, "refused equality of ideals of a polynomial ring over Zmod(4) is not supported yet (work) 0\n");
  // through the content (2t vs 2t + 2: decided over Zmod(2), one budget):
  // 24 + 8 at Zmod(4), then 16 + 12 + 16 at Zmod(2)
  const small = "R.<t> = Zmod(4)[]";
  r = run(76, small, "R.ideal(2*t) == R.ideal(2*t + 2)");
  assert.equal(r.stdout, "False 1\n");
  r = run(75, small, "R.ideal(2*t) == R.ideal(2*t + 2)");
  assert.equal(r.stdout, "refused equality of ideals of a polynomial ring over Zmod(4) is not supported yet (work) 0\n");
});

test("Zmod(n)[t]: exact ideal equality, units and zero divisors (CORR-SAGE102-1)", () => {
  const r = sage([
    both,
    // (astra's vectors, as Sage 10.10: sage-tests/test_ideal_zmod_eq has the table)
    "R.<t> = Zmod(4)[]; both(R.ideal(t), t + 1); both(R.ideal(t), 2*t); both(R.ideal(1), 1 + 2*t)",
    "S.<s> = Zmod(6)[]; both(S.ideal(s), s + 1); both(S.ideal(2*s), 4*s); both(S.ideal(2), 3)",
    // (deliberately not as Sage, which says False: t + 2t^2 = t (1 + 2t)
    // and 1 + 2t is a unit, (1 + 2t)^2 = 1, so the ideals are equal)
    "both(R.ideal(t), t + 2*t^2); print((t + 2*t^2) * (1 + 2*t) == t, (1 + 2*t)^2 == 1)",
  ].join("\n"));
  assert.equal(r.stderr, "");
  assert.equal(r.stdout, [
    "True False", "True False", "True True",
    "True False", "True True", "True False",
    "True True", "True True", "",
  ].join("\n"));
});

test("another ring's element is unequal before any conversion; a large generator compares by its coefficients", () => {
  const r = sage([
    "R.<t> = QQ[]; S = PolynomialRing(QQ, 't,w')",
    // (R(f) of this one, an element of QQ[t,w] in R's variable, is refused
    // by the dense-conversion limit, 2^20 coefficients; I == f does not
    // convert it: unequal, as in Sage)
    "f = S.gen(0)^(2^20)",
    "print(R.ideal(t) == f)",
    "try:\n    R(f)\nexcept NotImplementedError as e:\n    print('R(f):', e)",
    // (associates of degree 4000: one pass over the coefficients, no division)
    "g = R([QQ(k + 1) / (k + 2) for k in range(4001)])",
    "print(R.ideal(3*g) == g, R.ideal(3*g) == g + 1, R.ideal(g) == t*g)",
  ].join("\n"));
  assert.equal(r.stderr, "");
  assert.equal(r.stdout, [
    "False",
    "R(f): a polynomial of degree 1048576 exceeds sagebrush's limit of 1048576 coefficients for this conversion",
    "True False False", "",
  ].join("\n"));
});
