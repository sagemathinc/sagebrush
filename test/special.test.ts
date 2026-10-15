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
    if name == "legendre_all":
        a = [int(a[0]), a[1], ("unnorm", "sch", "norm")[int(a[2])]]
    try:
        v = getattr(S, name)(*a)
        if isinstance(v, (tuple, list)):
            out.append([repr(float(t)) for t in v])
            continue
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
  ellipk: [1e-15, 1e-300], ellipe: [1e-15, 1e-300], ellipj: [1.5e-15, 0], legendre_all: [2e-14, 0],
  besselj: [4e-14, 1e-300],
};
// (J_nu(x) oscillates for |x| > nu with an envelope near sqrt(2/(pi |x|)):
// there its error is measured against that, an absolute accuracy next to
// its zeros, and relative to |J| below the oscillations)
const besselFloor = (args: any[]): number => {
  const nu = Math.abs(num(args[0])), x = Math.abs(num(args[1]));
  return x > nu ? Math.sqrt(2 / (Math.PI * Math.max(1, x))) : 1e-300;
};

test("lib/_special.py agrees with mpmath within each function's stated error", () => {
  const worst: Record<string, number> = {};
  cases.forEach(([name, args, want], i) => {
    const g = got[i];
    assert.ok(Array.isArray(g), `${name}(${JSON.stringify(args)}) raised ${g}`);
    if (name === "ellipj" || name === "legendre_all") {
      // (several values: ellipj's sn, cn and dn each relative to max(1e-300,
      // |value|) times its condition 1 + |u f'/f|; a Legendre column
      // relative to its largest finite |value|, infinities exactly)
      const w = want.map(num), gv = g.map(num);
      assert.equal(gv.length, w.length);
      let e = 0;
      if (name === "ellipj") {
        const u = num(args[0]), m = num(args[1]);
        const [s, c, d] = w;
        const der = [c * d, -s * d, -m * s * c];
        w.forEach((v, k) => {
          e = Math.max(e, Math.abs(gv[k] - v) / Math.max(Math.abs(v), 1e-300) / (1 + Math.abs((u * der[k]) / (v || 1))));
        });
      } else {
        const big = Math.max(1e-300, ...w.filter(Number.isFinite).map(Math.abs));
        w.forEach((v, k) => {
          if (!Number.isFinite(v)) assert.equal(gv[k], v, `${name}(${JSON.stringify(args)})[${k}]`);
          else e = Math.max(e, Math.abs(gv[k] - v) / big);
        });
      }
      worst[name] = Math.max(worst[name] ?? 0, e);
      return;
    }
    const [gr, gi] = pair(g), [wr, wi] = pair(want);
    const e = Math.hypot(gr - wr, gi - wi) / Math.max(name === "besselj" ? besselFloor(args) : TOL[name][1], Math.hypot(wr, wi));
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
    except (ValueError, OverflowError) as e:
        return type(e).__name__ + ": " + str(e)
for f, a in [(S.loggamma, (0,)), (S.loggamma, (-3.0,)), (S.gamma, (complex(-2, 0),)), (S.psi, (-1.0,)),
             (S.polygamma, (2, 0.0)), (S.zeta, (1,)), (S.hurwitz_zeta, (1.0, 0.5)), (S.beta, (-2.0, 0.5)),
             (S.exp_integral_e1, (0.0,)), (S.exp_integral_ei, (0.0,)),
             (S.hurwitz_zeta, (-1.5, 0.5)), (S.hurwitz_zeta, (2.0, -0.5)), (S.zeta, (complex(0.5, 2e5),)),
             (S.polygamma, (101, 2.0)), (S.polygamma, (1.5, 2.0)), (S.beta, (1j, 2.0)), (S.erfinv, (0.5j,)),
             (S.lambert_w, (0.0, 1)), (S.lambert_w, (complex(0, 0), -1)), (S.lambert_w, (2.0, 0.5)),
             (S.polylog, (1, 1.0)), (S.polylog, (-2, complex(1, 0))), (S.polylog, (2.5, 0.3)), (S.polylog, (-21, 0.3)),
             (S.polylog, (-20, complex(1.0000000000000002, 1e-300))), (S.polylog, (-20, 0.999999999999999)),
             (S.ellipk, (1.0,)), (S.ellipk, (1.5,)), (S.ellipj, (1.0, 1.2)), (S.legendre_all, (2, 1.5)),
             (S.legendre_all, (2, 0.5, "bogus"))]:
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
# (E(1) = 1; the Condon-Shortley phase in each normalization; P_n^-m; P_n)
print(S.ellipe(1.0), S.ellipj(0.0, 0.5), S.legendre_all(1, 0.0), S.legendre_all(1, 0.0, "sch"), S.legendre_all(1, 0.0, "norm"))
print(repr(S.assoc_legendre_p(3, -2, 0.4)), repr(S.assoc_legendre_p(2, 3, 0.4)), repr(S.legendre_p(5, 0.3)))
# (negative orders beyond P_n^k's range: mpmath's P_200^-138(0.3) = -5.5622967120952512e-314, subnormal, and
# P_150^-100(0.3) = 5.6958944681799030e-216; ellipj after an exact reduction of a large u, daybreak's CORR-027-1)
v = S.assoc_legendre_p(150, -100, 0.3)
print(repr(S.assoc_legendre_p(200, -138, 0.3)), abs(v - 5.6958944681799030e-216) < 1e-14 * 5.7e-216)
print(" ".join("%.12f" % t for t in S.ellipj(314159265358979328.0, 0.9999999990686774)))
# (at x = 0 the recurrence alternates exact zeros with large values, which were left unscaled)
col = S.legendre_all(200, 0.0)
print(all(t == t for t in col), col[151], col[150] != 0)
# (_ldexp rounds once, as CPython's math.ldexp: Sagebrush's math.ldexp gives nan, 0.0 and inf for these)
print(repr(S._ldexp(-0.0, 1027)), repr(S._ldexp(2.0 ** 60, -1100)), kind(lambda: S._ldexp(1.0, 1024)), repr(S._ldexp(3.0, -1075)))
# (Bessel J: its edges, the side of the cut for negative x, and what it does not cover)
print(repr(S.besselj(0.0, 0.0)), repr(S.besselj(2.5, 0.0)), repr(S.besselj(-3.0, 0.0)), repr(S.besselj(1.0, inf)), "%.12gj" % S.besselj(0.5, -2.0).imag, repr(S.besselj(nan, 1.0)))
print(" ".join(kind(f, *a) for f, a in [(S.besselj, (-0.5, 1.0)), (S.besselj, (1.0, 1 + 2j)), (S.besselj, (inf, 1.0)), (S.besselj, (6e5, 6e5))]))
# (the least subnormal x, daybreak's CORR-088-3: J_(1/2) ~ sqrt(2x/pi), J_1 and J_2 round to 0; huge finite orders,
# API-088-4: J below the doubles is 0, and the turning point at 1e308 is refused, never an OverflowError)
print("%.14g" % S.besselj(0.5, 5e-324), repr(S.besselj(1.0, 5e-324)), repr(S.besselj(2.0, 5e-324)), repr(S.besselj(1e308, 1.0)),
      repr(S.besselj(500.0, 1.0)), kind(S.besselj, 1e308, 1e308).split(" (")[0], kind(S.besselj, 8e307, 8e307).split(" (")[0])
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
    "PoleError", "NotCovered: ellipk: Sagebrush covers m <= 1", "NotCovered: ellipj: Sagebrush covers 0 <= m <= 1",
    "NotCovered: legendre_all: Sagebrush covers real x in [-1, 1]",
    "ValueError: legendre_all: normalization must be one of unnorm, sch, norm",
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
    "1.0 (0.0, 1.0, 1.0) [0.0, -1.0] [0.0, 1.0] [0.0, 0.8660254037844386]",
    // (exactly: P_3^-2(0.4) = 15 x (1 - x^2)/120 = 0.042, P_5(0.3) = (63x^5 - 70x^3 + 15x)/8 = 0.34538625)
    "0.042 0.0 0.34538625",
    "-5.562296712e-314 True",
    // (mpmath at 100 digits: 0.99999408321166589, -0.0034399915203138161, 0.0034401268830356724)
    "0.999994083212 -0.003439991520 0.003440126883",
    "True -0.0 True",
    "-0.0 8.487983164e-314 OverflowError: math range error 1e-323",
    // (J_(1/2)(-2) = e^(i pi/2) J_(1/2)(2) = i sqrt(2/(2 pi)) sin 2 = 0.5130161365618278i)
    "1.0 0.0 -0.0 0.0 0.513016136562j nan",
    "NotCovered: besselj: Sagebrush covers negative orders only when they are integers " +
      "NotCovered: besselj: Sagebrush covers real orders and arguments NotCovered: besselj: Sagebrush covers finite orders " +
      "NotCovered: besselj: Sagebrush covers orders and arguments for which the recurrence needs at most 500000 steps (here about 601042)",
    "1.7735048886036e-162 0.0 0.0 0.0 0.0 " +
      "NotCovered: besselj: Sagebrush covers orders and arguments for which the recurrence needs at most 500000 steps " +
      "NotCovered: besselj: Sagebrush covers orders and arguments for which the recurrence needs at most 500000 steps",
  ]);
});
