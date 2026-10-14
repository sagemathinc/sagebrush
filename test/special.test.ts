import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// lib/_special.py (the special functions MATLAB, scipy.special and Sage
// share) against mpmath's values at 40 digits: test/special-mpmath.json,
// from test/special_mpmath_gen.py.  Each function's tolerance is a little
// above the largest error measured in Sagebrush, as a fraction of
// max(floor, |value|); the large ones are where the function's own
// condition is large (|Im s| for zeta, |z|^2 for the error functions near
// their growth, |x| for E1 and Ei), as the docstrings say.
const cases: [string, any[], any][] = JSON.parse(readFileSync(__dirname + "/../../test/special-mpmath.json", "utf8"));

const program = `
import json, sys
import _special as S
cases = json.loads(sys.stdin.read())
def dec(v):
    return complex(float(v[0]), float(v[1])) if isinstance(v, list) else float(v)
out = []
for name, args, want in cases:
    a = [dec(x) for x in args]
    if name == "polygamma":
        a[0] = int(a[0])
    try:
        v = getattr(S, name)(*a)
        out.append([repr(complex(v).real), repr(complex(v).imag)])
    except Exception as e:
        out.append("!" + type(e).__name__ + ": " + str(e))
print(json.dumps(out))
`;

const got: any[] = JSON.parse(
  execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", program], {
    input: JSON.stringify(cases),
    encoding: "utf8",
    maxBuffer: 1 << 26,
  }),
);

const num = (r: string): number => (r === "inf" ? Infinity : r === "-inf" ? -Infinity : r === "nan" ? NaN : Number(r));
const pair = (v: any): [number, number] => (Array.isArray(v) ? [num(v[0]), num(v[1])] : [num(v), 0]);

// [tolerance, floor, complex tolerance]: for complex s, zeta's and
// hurwitz_zeta's error is an absolute one of about c |Im s| eps of
// max(1, |value|) (the phases' rounding), so for them it is measured per
// unit max(1, |Im s|), against the third number
const TOL: Record<string, [number, number, number?]> = {
  loggamma: [2e-14, 1], gamma: [6e-14, 1e-300], psi: [3e-15, 1], polygamma: [8e-15, 1e-300],
  zeta: [3e-14, 1, 2.5e-15], hurwitz_zeta: [3e-14, 1, 5e-15], beta: [3e-14, 1e-300], betaln: [1e-15, 1],
  faddeeva: [4e-15, 1e-300], erf: [6e-15, 1e-300], erfc: [8e-15, 1e-300], erfi: [1.5e-13, 1e-300],
  erfcx: [6e-14, 1e-300], erfinv: [1e-15, 1e-300], erfcinv: [1e-15, 1e-300],
  exp_integral_e1: [6e-14, 1e-300], exp_integral_ei: [1.2e-13, 1e-300], lambert_w: [1.5e-15, 1e-300],
  polylog: [2.5e-14, 1e-300], dilog: [4e-15, 1e-300],
};

test("lib/_special.py agrees with mpmath within each function's stated error", () => {
  const worst: Record<string, number> = {};
  cases.forEach(([name, args, want], i) => {
    const g = got[i];
    assert.ok(Array.isArray(g), `${name}(${JSON.stringify(args)}) raised ${g}`);
    const [gr, gi] = pair(g), [wr, wi] = pair(want);
    const e = Math.hypot(gr - wr, gi - wi) / Math.max(TOL[name][1], Math.hypot(wr, wi));
    if (TOL[name][2] !== undefined && Array.isArray(args[0])) {
      const key = name + " (complex s, per unit |Im s|)";
      worst[key] = Math.max(worst[key] ?? 0, e / Math.max(1, Math.abs(num(args[0][1]))));
      return;
    }
    worst[name] = Math.max(worst[name] ?? 0, e);
  });
  for (const name of Object.keys(TOL)) {
    assert.ok(name in worst, name + " has no cases");
    assert.ok(worst[name] <= TOL[name][0], `${name}: ${worst[name]} > ${TOL[name][0]}`);
    if (TOL[name][2] !== undefined) {
      const key = name + " (complex s, per unit |Im s|)";
      assert.ok(key in worst, key + " has no cases");
      assert.ok(worst[key] <= TOL[name][2]!, `${key}: ${worst[key]} > ${TOL[name][2]}`);
    }
  }
});

test("lib/_special.py raises PoleError at poles, NotCovered where it does not compute a value, ValueError where there is none", () => {
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", `
import _special as S
import numpy as np
def kind(f, *a):
    try:
        v = f(*a)
        return repr(v)
    except S.PoleError:
        return "PoleError"
    except ValueError as e:
        return type(e).__name__ + ": " + str(e)
for f, a in [(S.loggamma, (0,)), (S.loggamma, (-3.0,)), (S.gamma, (complex(-2, 0),)), (S.psi, (-1.0,)),
             (S.polygamma, (2, 0.0)), (S.zeta, (1,)), (S.hurwitz_zeta, (1.0, 0.5)), (S.beta, (-2.0, 0.5)),
             (S.exp_integral_e1, (0.0,)), (S.exp_integral_ei, (0.0,)),
             (S.hurwitz_zeta, (-1.5, 0.5)), (S.hurwitz_zeta, (2.0, -0.5)), (S.zeta, (complex(0.5, 2e5),)),
             (S.polygamma, (101, 2.0)), (S.polygamma, (1.5, 2.0)), (S.beta, (1j, 2.0)), (S.erfinv, (0.5j,)),
             (S.lambert_w, (0.0, 1)), (S.lambert_w, (complex(0, 0), -1)), (S.lambert_w, (2.0, 0.5)),
             (S.polylog, (1, 1.0)), (S.polylog, (-2, complex(1, 0))), (S.polylog, (2.5, 0.3)), (S.polylog, (-21, 0.3)),
             (S.polylog, (-20, complex(1.0000000000000002, 1e-300))), (S.polylog, (-20, 0.999999999999999))]:
    print(kind(f, *a))
print(S.hurwitz_zeta(-3.0, 0.25), S.beta(-3.0, 2.0), S.beta(-0.5, -0.5), S.loggamma(complex(-2.5, -0.0)).imag)
print(S.erfinv(2.0), S.erfinv(-1.0), S.erfcinv(0.0), S.exp_integral_e1(-2.0).imag)
print(S.psi(np.array([1.0, 2.0])).shape, S.beta(np.array([[1.0], [2.0]]), np.array([1.0, 2.0, 3.0])).shape)
# (NotCovered is also a NotImplementedError, for Sage mode)
try:
    S.hurwitz_zeta(2.0, 1 + 1j)
except NotImplementedError as e:
    print("NotImplementedError", isinstance(e, ValueError), str(e))
# (special values and nonfinite arguments, daybreak's HARD-A15-5 and CORR-A15-1)
inf, nan = float("inf"), float("nan")
print(repr(S.zeta(0.0)), repr(S.zeta(-0.0)), repr(S.zeta(0j)), repr(S.zeta(-2.0)), repr(S.zeta(inf)), repr(S.faddeeva(0.0)), repr(S.erfi(-0.0)))
print(" ".join(kind(f, a) for f, a in [(S.loggamma, -inf), (S.gamma, -inf), (S.zeta, -inf), (S.psi, -inf), (S.loggamma, inf),
                                        (S.gamma, inf), (S.faddeeva, nan), (S.faddeeva, inf), (S.zeta, nan), (S.erf, complex(inf, 1)),
                                        (S.exp_integral_e1, complex(nan, 0)), (lambda s: S.hurwitz_zeta(s, 1.0), nan)]))
# (real arguments give real values)
print(" ".join(type(v).__name__ for v in (S.zeta(2.5), S.zeta(-1.5), S.zeta(0.3), S.hurwitz_zeta(2.0, 0.5), S.hurwitz_zeta(-0.5, 2.0),
                                          S.loggamma(2.5), S.psi(-0.5), S.polygamma(2, -0.5), S.gamma(-0.5), S.erfcx(-1.0),
                                          S.exp_integral_e1(2.0), S.exp_integral_ei(-2.0), S.beta(-0.5, 2.0))), S.zeta(np.array([2.0, -1.0])).dtype)
# (Lambert W on its cuts: the side is the zero imaginary part's sign)
for z, k in [(-1.0, 0), (complex(-1, -0.0), 0), (-0.2, -1), (complex(-0.2, -0.0), -1), (complex(-0.2, -0.0), 1), (-0.2, 1), (1.0, 0), (0.0, 0)]:
    print(repr(S.lambert_w(z, k)))
print(repr(S.lambert_w(nan)), kind(S.lambert_w, complex(inf, 1)))
# (polylog on its cut (1, inf), from above and from below, and real below 1)
print(repr(S.polylog(2, 50.0)), repr(S.polylog(2, complex(50, -0.0))), repr(S.dilog(-1.0)), repr(S.polylog(2, 1.0)))
`], { encoding: "utf8" });
  assert.deepEqual(out.trim().split("\n"), [
    "PoleError", "PoleError", "PoleError", "PoleError", "PoleError", "PoleError", "PoleError", "PoleError",
    "PoleError", "PoleError",
    "NotCovered: hurwitz_zeta: Sagebrush covers Re s > -1 and the integers s <= -1",
    "NotCovered: hurwitz_zeta: Sagebrush covers real a > 0",
    "NotCovered: zeta: Sagebrush covers |Im s| <= 100000",
    "NotCovered: polygamma: Sagebrush covers n <= 100",
    "ValueError: polygamma: n must be an integer >= 0",
    "NotCovered: beta: Sagebrush covers real arguments",
    "NotCovered: erfinv: Sagebrush covers real arguments",
    "PoleError", "PoleError", "ValueError: lambert_w: k must be an integer",
    "PoleError", "PoleError", "NotCovered: polylog: Sagebrush covers integer orders s",
    "NotCovered: polylog: Sagebrush covers integer orders -20 <= s <= 100",
    // (next to the pole the true values, about 1.3e347 and 2.5e333, exceed the double range)
    "NotCovered: polylog: Sagebrush covers values within the double range (|Li_s(z)| is too large here)",
    "NotCovered: polylog: Sagebrush covers values within the double range (|Li_s(z)| is too large here)",
    // (zeta(-3, 1/4) = -B_4(1/4)/4 exactly; B(-3, 2) = 1/((-3)(-2)); Gamma(-1) in the denominator)
    "-0.0004557291666666667 0.16666666666666666 0.0 9.42477796076938",
    "nan -inf inf -3.141592653589793",
    "(2,) (2, 3)",
    "NotImplementedError True hurwitz_zeta: Sagebrush covers real a > 0",
    // (zeta(0) = -1/2, DLMF 25.6.1; the trivial zeros start at -2)
    "-0.5 -0.5 (-0.5+0j) 0.0 1.0 (1+0j) -0.0",
    "ValueError: loggamma has no limit at -inf ValueError: gamma has no limit at -inf ValueError: zeta has no limit at -inf " +
      "ValueError: psi has no limit at -inf inf inf (nan+nanj) 0j nan NotCovered: erf: Sagebrush covers finite complex arguments " +
      "(nan+nanj) nan",
    "float float float float float float float float float float float float float float64",
    // (mpmath's limits from above and below the cuts)
    "(-0.31813150520476413+1.3372357014306895j)", "(-0.31813150520476413-1.3372357014306895j)",
    "-2.542641357773526", "(-3.722320484923165-7.387230210574593j)", "(-2.542641357773526-0j)",
    "(-3.722320484923165+7.387230210574593j)", "0.5671432904097838", "0.0",
    "nan NotCovered: lambert_w: Sagebrush covers finite arguments (and +inf for k = 0)",
    // (mpmath: Li_2(50 + 0i) = -4.382194762821773 + 12.289982734527328i; -pi^2/12; pi^2/6)
    "(-4.382194762821774+12.289982734527328j) (-4.382194762821774-12.289982734527328j) -0.8224670334241129 1.6449340668482264",
  ]);
});
