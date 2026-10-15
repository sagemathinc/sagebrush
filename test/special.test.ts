import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// lib/_special.py (the special functions MATLAB, scipy.special and Sage
// share) against mpmath's values at 40 digits: test/special-mpmath.json,
// from test/special_mpmath_gen.py.  Each function's tolerance is a little
// above the largest error measured in Sagebrush, as a fraction of
// max(floor, |value|); the large ones are where the function's own
// condition is large (|Im s| for zeta, |x| for E1 and Ei), as the
// docstrings say.
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
  faddeeva: [1.5e-15, 1e-300], erf: [1.5e-15, 1e-300], erfc: [1.5e-15, 1e-300], erfi: [1.5e-15, 1e-300],
  erfcx: [1.5e-15, 1e-300], erfinv: [1e-15, 1e-300], erfcinv: [1e-15, 1e-300],
  exp_integral_e1: [6e-14, 1e-300], exp_integral_ei: [1.2e-13, 1e-300], lambert_w: [1.5e-15, 1e-300],
  polylog: [2.5e-14, 1e-300], dilog: [4e-15, 1e-300],
  ellipk: [1e-15, 1e-300], ellipe: [1e-15, 1e-300], ellipj: [1.5e-15, 0], legendre_all: [2e-14, 0],
  gammainc: [6e-15, 1e-300], gammaincc: [6e-15, 1e-300], gammainc_scaled: [6e-15, 1e-300],
  besselj: [6e-15, 1e-300],
};
// (J_nu(x) oscillates for |x| > nu with an envelope near sqrt(2/(pi |x|)):
// there its error is measured against that, an absolute accuracy next to
// its zeros, and relative to |J| below the oscillations)
const besselFloor = (args: any[]): number => {
  const nu = Math.abs(num(args[0])), x = Math.abs(num(args[1]));
  return x > nu ? Math.sqrt(2 / (Math.PI * Math.max(1, x))) : 1e-300;
};
// (P's and Q's relative error grows with the size of their exponent, the
// rounding of log(x^a e^-x / Gamma(a+1)) or of a (lambda - 1 - log lambda),
// and beta's with |betaln|, as exp(betaln) turns its absolute error into a
// relative one: it is measured per unit max(1, |log |value||))
const LOG_SCALED = new Set(["gammainc", "gammaincc", "gammainc_scaled", "beta"]);
// (betaln of negative arguments, through _betaln_signed's reflections: a
// bound of its own, the positive arguments' staying as small as it is)
const NEG_TOL: Record<string, number> = { betaln: 2.5e-15 };
// (polygamma of orders above 20: a bound of its own, as Horner's rule over
// P_n's n/2 terms and the recurrence's n-fold powers round in proportion to
// n; 9574afa's values at these cases reach 2e-14 too)
const HIGH_ORDER_TOL = 2.5e-14;

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
    let e = Math.hypot(gr - wr, gi - wi) / Math.max(name === "besselj" ? besselFloor(args) : TOL[name][1], Math.hypot(wr, wi));
    if (LOG_SCALED.has(name) && wr !== 0) e /= Math.max(1, Math.abs(Math.log(Math.abs(wr))));
    if (name === "polygamma" && num(args[0]) > 20) {
      const key = "polygamma (n > 20)";
      worst[key] = Math.max(worst[key] ?? 0, e);
      return;
    }
    if (name in NEG_TOL && args.some((a) => !Array.isArray(a) && num(a) < 0)) {
      const key = name + " (negative arguments)";
      worst[key] = Math.max(worst[key] ?? 0, e);
      return;
    }
    if (TOL[name][2] !== undefined && Array.isArray(args[0])) {
      const key = name + " (complex s, per unit |Im s|)";
      worst[key] = Math.max(worst[key] ?? 0, e / Math.max(1, Math.abs(num(args[0][1]))));
      return;
    }
    worst[name] = Math.max(worst[name] ?? 0, e);
  });
  assert.ok("polygamma (n > 20)" in worst, "polygamma (n > 20) has no cases");
  assert.ok(worst["polygamma (n > 20)"] <= HIGH_ORDER_TOL, `polygamma (n > 20): ${worst["polygamma (n > 20)"]} > ${HIGH_ORDER_TOL}`);
  for (const [name, tol] of Object.entries(NEG_TOL)) {
    const key = name + " (negative arguments)";
    assert.ok(key in worst, key + " has no cases");
    assert.ok(worst[key] <= tol, `${key}: ${worst[key]} > ${tol}`);
  }
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
# (the incomplete gamma functions: their limits and edges, and what they do not cover)
print(repr(S.gammainc(0.0, 2.0)), repr(S.gammaincc(0.0, 2.0)), repr(S.gammainc(2.0, 0.0)), repr(S.gammaincc(2.0, float("inf"))),
      repr(S.gammainc_scaled(2.0, 0.0)), repr(S.gammainc_scaled(2.0, 0.0, True)), repr(S.gammainc(nan, 1.0)))
print(" ".join(kind(f, *a) for f, a in [(S.gammainc, (-1.0, 2.0)), (S.gammaincc, (1.0, -2.0)), (S.gammainc, (complex(1, 1), 1.0)), (S.gammainc, (inf, 1.0))]))
# (the scaled forms where the prefactor under- or overflows, and the least subnormal x: daybreak's HARD-05E-1, CORR-05E-2)
print("%.12g %.12g" % (S.gammainc_scaled(1.0, 1000.0, True), S.gammainc_scaled(2.0, 1000.0, True)), repr(S.gammainc_scaled(0.0, 1000.0)),
      repr(S.gammainc(1.0, 5e-324)), repr(S.gammainc_scaled(1.0, 5e-324)), repr(S.gammaincc(1.0, 5e-324)), repr(S.gammainc(1.0, 1e-320)))
# (near the largest doubles, daybreak's CORR-9BD-1: at x = a both scaled forms are sqrt(pi a / 2) + 1/3, Temme's
# leading terms; at lambda = 0.9 the series' sum is 1/(1 - lambda) and for x - a >> sqrt(a) a F is a/(x - a), each to
# about 1e-300; the larger forms overflow; the continued fraction's coefficients n (n - a) overflow, refused)
import math
m = 1e308
r = math.sqrt(math.pi / 2) * math.sqrt(m)
print(S.gammainc(m, m), S.gammaincc(m, m), abs(S.gammainc_scaled(m, m) / r - 1) < 4e-16,
      abs(S.gammainc_scaled(m, m, True) / r - 1) < 4e-16, abs(S.gammainc_scaled(m, 0.9 * m) - 10) < 4e-15,
      S.gammainc_scaled(m, 0.9 * m, True), abs(S.gammainc_scaled(1.7e308, 1.79e308, True) * 0.09 / 1.7 - 1) < 4e-15,
      S.gammainc_scaled(1.7e308, 1.79e308), abs(S.gammainc_scaled(m, 0.3 * m) - 1 / 0.7) < 4e-15)
print(kind(S.gammaincc, 1e307, 1e308))
# (every series stops at its cap with NotCovered, never a silent value: each pushed outside the domain its caller keeps it in;
# _polylog_mu's cap is not probed here, as reaching it takes exact Bernoulli numbers to B_248, some 18 s)
print(" | ".join(kind(f, *a).split(" at ")[0] for f, a in [(S._erf_taylor, (30.0,)), (S._loggamma_near_2, (1.9,)), (S._psi_near_1, (1.9,)), (S._psi_near_2, (1.95,)),
                                          (S._polylog_series, (2, 1 + 0j))]))
# (arguments at the ends of the doubles, which raised OverflowError, ValueError or hung: each gives its value (checked
# against mpmath), its limit beyond the doubles (inf, 0), or NotCovered)
g = "%.12g"
print(S.loggamma(1e308), S.gamma(complex(1, 1e308)), S.polygamma(1, 1e300), S.polygamma(5, complex(1, 1e308)), S.beta(0.5, 5e-324),
      g % S.beta(-1.5, 1e308), S.beta(1e20, -1e308), g % S.beta(-2.5, 1e15), g % S.betaln(-1.5, 5e-324),
      "%.12g%+.12gj" % (S.lambert_w(5e-324, -1).real, S.lambert_w(5e-324, -1).imag), S.hurwitz_zeta(1e300, 0.5), S.hurwitz_zeta(1e300, 1.0),
      S.hurwitz_zeta(1e300, 2.0), g % S.dilog(complex(1, 1e-300)).real, g % S.beta(-3.0, 2.0))
# (zeta near 0, @sagebrush-sage's report: the functional equation lost about eps/|s|, zeta(1e-16) was -0.4504 and
# zeta(-1e-17) raised PoleError; now Euler-Maclaurin at s for |s| < 0.05.  mpmath's values at 30 digits)
zref = [(1e-16, -0.50000000000000009189), (-1e-17, -0.49999999999999999081), (complex(1e-5, 1e-5), complex(-0.50000918938533004512, -9.1895859696938894166e-6)),
        (0.03, -0.52849887255537702034), (-0.049, -0.45726839624509547995), (complex(-0.02, 0.03), complex(-0.48116447625400678751, -0.026374490214081654222)),
        (5e-324, -0.5)]
print([abs(S.zeta(z) - r) <= 3e-15 * abs(r) for z, r in zref], repr(S.zeta(1e-16)), repr(S.zeta(5e-324)))
# (the error functions on the axes, exactly: erf(iy) = i erfi(y), erfi(iy) = i erf(y), erfc(iy) = 1 - i erfi(y), and on
# the real axis their real values, each zero part with the argument's sign: @sagebrush-sage's report of erf(2i) =
# 1.1e-16 + 18.56i and erfi(i) = 1.1e-19 + 0.84i)
print(repr(S.erf(2j)), repr(S.erfi(1j)), repr(S.erfc(2j)), repr(S.erf(complex(-0.0, 2))), repr(S.erf(complex(1.5, -0.0))),
      repr(S.erfi(complex(0.7, 0.0))), repr(S.erfc(complex(0.5, 0.0))))
# (astra's CORR-957-2, the complex reciprocal: psi'(1e308 + 1e308i) = 1/w to within 1e-308, 5e-309 - 5e-309i, not 0j; and
# the value-comparing sweep's: Gamma of a tiny negative x is -inf, not -0.0; erf next to 1e308 (1 + 1e-309i) and the
# erfc whose phase there is beyond the doubles; E1 and erfcx near 1e308, subnormal, against mpmath's values)
print(repr(S.polygamma(1, complex(1e308, 1e308))), repr(S.gamma(-5e-324)), repr(S.gamma(-1e-310)), repr(S.erf(complex(1e308, 1e308))),
      repr(S.erfc(complex(-1e308, 1e308))), kind(S.erfc, complex(1e308, 1e308)).split(" at ")[0], kind(S.erf, complex(1e8, 2e8)).split(" at ")[0])
sub = [(S.exp_integral_e1(1e308j), complex(-4.5339649050164911158e-309, 8.9130893768703339812e-309)),
       (S.erfcx(complex(1e308, 1e308)), complex(2.8209479177387814038e-309, -2.8209479177387814038e-309))]
print([abs(v - r) < 1e-321 for v, r in sub])
# (astra's CORR-7E4-1 and 7E4-2, in the CLI: the reflection's overflowing terms (inf <= inf accepted nan + inf i), E1 of
# a growing argument beyond the doubles (0j, as Sagebrush's cmath.log is inf there), and next to a zero of the dominant
# terms, where the recurrence was off by 54 times the value: each refused)
print(" | ".join(kind(S.polygamma, n, z).split(" at ")[0] for n, z in [(2, complex(-1, 1e-150)), (100, complex(-1, 0.01)),
      (100, complex(-1e20, 0.01)), (100, complex(-0.5, 0.046793214736766446)), (100, complex(-0.5, 1.0000000000000002))]))
print(" | ".join(kind(S.exp_integral_e1, z).split(" at ")[0] for z in [complex(-1.7e308, 1.7e308), complex(-1.7e308, -1.7e308)]),
      repr(S.exp_integral_e1(complex(1.7e308, 1.7e308))))
# (astra's review of 31f1ea2: E1 where e^-z overflows but e^-z/z does not, against mpmath at 400 digits; each was
# refused as overflowing)
e1ref = [(complex(-716, 1), complex(-6.8253476368320043e307, 1.0597220277097455e308)),
         (complex(-1400, 1e300), complex(8.4132785550751173e307, 5.9188051048798075e307))]
print([abs(S.exp_integral_e1(z) - r) <= 1e-13 * abs(r) for z, r in e1ref])
# (Bessel J: its edges, the side of the cut for negative x, and what it does not cover)
print(repr(S.besselj(0.0, 0.0)), repr(S.besselj(2.5, 0.0)), repr(S.besselj(-3.0, 0.0)), repr(S.besselj(1.0, inf)), "%.12gj" % S.besselj(0.5, -2.0).imag, repr(S.besselj(nan, 1.0)))
print(" ".join(kind(f, *a) for f, a in [(S.besselj, (-0.5, 1.0)), (S.besselj, (1.0, 1 + 2j)), (S.besselj, (inf, 1.0)), (S.besselj, (6e5, 6e5))]))
# (the least subnormal x, daybreak's CORR-088-3: J_(1/2) ~ sqrt(2x/pi), J_1 and J_2 round to 0; huge finite orders,
# API-088-4: J below the doubles is 0, and the turning point at 1e308 is refused, never an OverflowError)
print("%.14g" % S.besselj(0.5, 5e-324), repr(S.besselj(1.0, 5e-324)), repr(S.besselj(2.0, 5e-324)), repr(S.besselj(1e308, 1.0)),
      repr(S.besselj(500.0, 1.0)), kind(S.besselj, 1e308, 1e308).split(" (")[0], kind(S.besselj, 8e307, 8e307).split(" (")[0])
# (astra's notes on 826f1de: exponentials beyond the doubles times small factors, which are doubles; each part of
# e^(710 + 0.785i) a double though its modulus is not; real zeta below s = -260, where math.exp raised OverflowError;
# against mpmath at 400 digits)
big = [(S.erfc(complex(0.1, 26.646012834943992)), complex(3.871464092850159e306, -2.7234841033085135e306), 1e-15),
       (S.erf(complex(-0.4555275171297095, 26.66212742352627)), complex(6.941103718233293e306, 5.98557067321044e306), 1e-15),
       (S._cexp(complex(710, 0.7853981633974483)), complex(1.5796728482882015e308, 1.5796728482882013e308), 1e-15),
       (S.exp_integral_e1(complex(-716.5, 1)), complex(-1.1245214950119198e308, 1.7459663900313909e308), 1e-13),
       (S.gamma(complex(171.6, 1)), complex(6.589928500099849e307, -1.4374077427156274e308), 3e-13),
       (S.zeta(-259.7), 5.384417346157599e307, 3e-13), (S.zeta(-258.5), 9.643336244800007e305, 3e-13)]
# (compared part by part: abs() of these moduli is beyond the doubles)
part = lambda v: (complex(v).real, complex(v).imag)
print([max(abs(a - b) for a, b in zip(part(v), part(r))) <= tol * max(map(abs, part(r))) for v, r, tol in big],
      repr(S.zeta(-261.5)), repr(S.zeta(-300.5)),
      kind(S.zeta, complex(-280, 3)).split(" at ")[0], kind(S.erfc, complex(0.1, 26.8)).split(" at ")[0])
# (astra's CORR-BDA-1: next to the diagonal at 1.1e10, y^2 - x^2 rounds to 49152 with a correction of -7220.9; the
# correction exponentiated alone underflowed and the five functions gave 0, 1 or tiny values, all beyond the doubles,
# refused; and the helpers' contract: e^-1000 1.7e308 = 8.629130125834076e-127, e^710 0 = 0)
z = complex(10991984838.86061, 10991984838.860611)
print(" | ".join(kind(f, a).split(" at ")[0] for f, a in [(S.erfc, z), (S.erf, z), (S.erfi, 1j * z), (S.faddeeva, z.conjugate()),
                                                          (S.erfcx, -1j * z.conjugate())]))
print(abs(S._exp_mul(-1000.0, 1.7e308) / 8.62913012583407619e-127 - 1) < 1e-14, abs(S._cexp_mul(complex(-1000.0, 0), 1.7e308).real / 8.62913012583407619e-127 - 1) < 1e-14,
      repr(S._exp_mul(710.0, 0.0)), repr(S._cexp_mul(complex(710.0, 1), 0.0)))
# (astra's note on f938c7d: each part of the multiplier scaled by its own exponent, so a small part beside a huge one
# survives; and both parts of each product, cos and sin, by their own)
v = S._cexp_mul(complex(-1000.0, 0.5), complex(1e-300, 1.7e308))
r = complex(-4.137025358263756e-127, 7.572774122714864e-127)   # (mpmath at 400 digits)
print(repr(S._cexp_mul(0j, complex(1e308, 1e-100))), abs(v - r) <= 1e-15 * abs(r))
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
    "1.0 0.0 0.0 0.0 1.0 inf nan",
    "NotCovered: gammainc: Sagebrush covers a >= 0 NotCovered: gammaincc: Sagebrush covers x >= 0 " +
      "NotCovered: gammainc: Sagebrush covers real arguments NotCovered: gammainc: Sagebrush covers finite a",
    "0.001 0.002002 inf 5e-324 1.0 1.0 1e-320",
    "0.5 0.5 True True True inf True inf True",
    "NotCovered: gammainc: the continued fraction overflowed at a = 1e+307, x = 1e+308",
    "NotCovered: erf: the Taylor series did not converge | NotCovered: loggamma: the series about 2 did not converge | " +
      "NotCovered: psi: the series about 1 did not converge | NotCovered: psi: the series about 2 did not converge | " +
      "NotCovered: polylog: the series did not converge",
    // (mpmath at 400 digits: B(-1.5, 1e308) = 2.36327180120735e462, beyond the doubles (30 digits round 1e308 - 1.5 to
    // 1e308 and give 2.36); B(-2.5, 1e15) = -2.98932864874555e37, log B(-1.5, 2^-1074) =
    // 744.440071921381, W_-1(2^-1074) = -751.061568323038 - 3.14578107543527i, Li_2(1 + 1e-300 i) = pi^2/6 + ...)
    "inf 0j 1e-300 0j inf inf 0.0 -2.98932864875e+37 744.440071921 -751.061568323-3.14578107544j inf 1.0 0.0 1.64493406685 0.166666666667",
    "[True, True, True, True, True, True, True] -0.5000000000000001 -0.5",
    // (mpmath: erfi(2) = 18.5648024145755526, erf(1) = 0.842700792949714869)
    "18.564802414575553j 0.8427007929497149j (1-18.564802414575553j) (-0+18.564802414575553j) (0.9661051464753108-0j) " +
      "(0.9402829338335074+0j) (0.4795001221869535-0j)",
    "(5e-309-5e-309j) -inf -inf (1-0j) (2-0j) NotCovered: erfc: the phase of e^(-z^2) is beyond the doubles " +
      "NotCovered: erf, erfc, erfi: |erfc z| is beyond the doubles",
    "[True, True]",
    "NotCovered: polygamma: |psi^(n)(z)| is beyond the doubles here | NotCovered: polygamma: |psi^(n)(z)| is beyond the doubles here | " +
      "NotCovered: polygamma: Sagebrush covers Re z >= -1e6 when |Im z| < 1 | " +
      "NotCovered: polygamma: the recurrence cancels beyond the doubles' accuracy | " +
      "NotCovered: polygamma: the reflection cancels beyond the doubles' accuracy",
    "NotCovered: exp_integral_e1: e^-z/z, E1's leading term, is beyond the doubles | " +
      "NotCovered: exp_integral_e1: e^-z/z, E1's leading term, is beyond the doubles 0j",
    "[True, True]",
    // (J_(1/2)(-2) = e^(i pi/2) J_(1/2)(2) = i sqrt(2/(2 pi)) sin 2 = 0.5130161365618278i)
    "1.0 0.0 -0.0 0.0 0.513016136562j nan",
    "NotCovered: besselj: Sagebrush covers negative orders only when they are integers " +
      "NotCovered: besselj: Sagebrush covers real orders and arguments NotCovered: besselj: Sagebrush covers finite orders " +
      "NotCovered: besselj: Sagebrush covers orders and arguments for which the recurrence needs at most 500000 steps (here about 601042)",
    "1.7735048886036e-162 0.0 0.0 0.0 0.0 " +
      "NotCovered: besselj: Sagebrush covers orders and arguments for which the recurrence needs at most 500000 steps " +
      "NotCovered: besselj: Sagebrush covers orders and arguments for which the recurrence needs at most 500000 steps",
    "[True, True, True, True, True, True, True] -inf -inf NotCovered: zeta: |zeta(s)| is beyond the doubles " +
      "NotCovered: erf, erfc, erfi: |erfc z| is beyond the doubles",
    "NotCovered: erf, erfc, erfi: |erfc z| is beyond the doubles | NotCovered: erf, erfc, erfi: |erfc z| is beyond the doubles | " +
      "NotCovered: erf, erfc, erfi: |erfc z| is beyond the doubles | NotCovered: faddeeva: |w(z)| is beyond the doubles | " +
      "NotCovered: faddeeva: |w(z)| is beyond the doubles",
    "True True 0.0 0j",
    "(1e+308+1e-100j) True",
  ]);
});
