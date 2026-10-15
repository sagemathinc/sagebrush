"""lib/_special.py's public functions at the edges of the doubles (near
+-1e308, the subnormals, huge complex parts, large negative non-integers):
reports anything but a value, PoleError, NotCovered or a ValueError of
_special's own (a raw OverflowError, ZeroDivisionError, 'math domain
error', or a call taking more than 5 s); with --oracle, also every value
that disagrees with mpmath: a relative error above 1e-12 of max(1,
|log |value||), a 0 or inf where mpmath's value is within the doubles, a
finite value where it is not.  The oracle covers the functions in MPF
below, not faddeeva, polylog, the elliptic and Legendre functions or the
incomplete gamma functions (test/special.test.ts's fixture checks those),
and it skips a point where mpmath fails or takes more than 10 s.  Run
with CPython (and mpmath for --oracle):

    python3 scripts/special-edge-sweep.py lib/_special.py [--oracle]
"""
import importlib.util, math, sys, signal
path = next((a for a in sys.argv[1:] if not a.startswith("--")), "lib/_special.py")
spec = importlib.util.spec_from_file_location("_special", path)
S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)
ORACLE = "--oracle" in sys.argv
big = [1.7976931348623157e308, 1e308, 1e300, 1e200, 1e20]
small = [5e-324, 1e-310, 1e-300, 1e-200]
reals = [0.0, -0.0, 0.5, 1.0, 2.0, -1.5, -3.0] + big + [-v for v in big] + small + [-v for v in small]
cplx = [complex(a, b) for a in (0.0, 1e308, -1e308, 1.0, 1e-300, 1.7976931348623157e308) for b in (1e308, -1e308, 1e-300, 1.0, 1.7976931348623157e308)]
ones = [(v,) for v in reals + cplx]
# (large negative non-integers next to their partners, where log Gammas cancel)
negbig = [-999999999.5, -999999999999.5, -1e15 - 0.5, -123456.25, -20.5]
calls = {
    "loggamma": ones, "gamma": ones, "psi": ones, "zeta": ones, "faddeeva": ones, "erf": ones, "erfc": ones, "erfi": ones,
    "erfcx": ones, "erfinv": ones, "erfcinv": ones, "exp_integral_e1": ones, "exp_integral_ei": [(v,) for v in reals],
    "lambert_w": [(v, k) for v in reals + cplx for k in (0, -1, 1)], "dilog": ones, "ellipk": [(v,) for v in reals],
    "ellipe": [(v,) for v in reals],
    "polygamma": [(n, v) for n in (1, 2, 5, 50, 100) for v in reals + cplx + [1e3, 1e4, 1e7, 1e100]],
    "hurwitz_zeta": [(s, a) for s in (2.0, 0.5, -1.0, 1e300, -1e300) for a in [0.5, 1e300, 1e-300, 1e308]],
    "beta": [(a, b) for a in reals + negbig for b in (0.5, 2.0, 1e308, -1e308, 5e-324, 16.0, 1e9, 1e12, 3e12)]
    + [(a, -a + d) for a in negbig for d in (16.5, 1.25, -2.5, 0.75)] + [(a, b) for a in negbig for b in negbig],
    "betaln": [(a, b) for a in reals + negbig for b in (0.5, 2.0, 1e308, 5e-324, 1e12)] + [(a, -a + d) for a in negbig for d in (16.5, -2.5)],
    "polylog": [(n, v) for n in (-5, 0, 1, 2, 3, 10) for v in reals + cplx],
    "ellipj": [(u, m) for u in reals for m in (0.0, 0.5, 1.0, 1 - 1e-16, -1e308)],
    "legendre_all": [(n, x) for n in (0, 1, 2, 50) for x in (0.0, 1.0, -1.0, 5e-324, 1 - 1e-16)],
    "assoc_legendre_p": [(n, m, x) for n in (2, 50) for m in (0, 1, -1) for x in (0.0, 1.0, 5e-324, 1 - 1e-16)],
    "legendre_p": [(n, x) for n in (0, 3, 100) for x in (0.0, 1.0, 5e-324, -1.0)],
    "gammainc": [(a, x) for a in (0.0, 0.5, 1e308, 1e-300, 5e-324) for x in (0.0, 5e-324, 1e308, 1.7976931348623157e308, 1.0)],
    "gammaincc": [(a, x) for a in (0.0, 0.5, 1e308, 1e-300, 5e-324) for x in (0.0, 5e-324, 1e308, 1.7976931348623157e308, 1.0)],
    "besselj": [(nu, x) for nu in (0.0, 0.5, 3.0, -2.0, 170.5, 1e308, 1e20) for x in reals],
}
if ORACLE:
    import mpmath as M
    M.mp.dps = 60
    MPF = {
        "loggamma": M.loggamma, "gamma": M.gamma, "psi": M.digamma, "zeta": M.zeta, "erf": M.erf, "erfc": M.erfc, "erfi": M.erfi,
        "erfcx": lambda z: M.exp(M.mpmathify(z) ** 2) * M.erfc(z), "exp_integral_e1": M.e1, "exp_integral_ei": M.ei,
        "lambert_w": lambda z, k: M.lambertw(z, k), "polygamma": lambda n, z: M.polygamma(n, z), "hurwitz_zeta": M.zeta,
        "beta": M.beta, "betaln": lambda a, b: M.log(abs(M.beta(a, b))),
        # (on the cut x > 1 _special takes the limit from above, as complex(x, 0.0); mpmath's real x the one from below)
        "dilog": lambda z: M.conj(M.polylog(2, z)) if not isinstance(z, M.mpc) and z > 1 else M.polylog(2, z),
        "besselj": M.besselj,
    }
    # (the arguments' magnitudes span up to 1e630: digits enough that a + b and the like are exact;
    # polygamma(100, -1.5) cancels 70 digits in mpmath)
    DPS = {"beta": 700, "betaln": 700, "hurwitz_zeta": 80, "polygamma": 300}
class Timeout(Exception):
    pass
def alarm(*a):
    raise Timeout()
signal.signal(signal.SIGALRM, alarm)
DMAX = 1.7976931348623157e308
def compare(name, args, v):
    """None, or why v disagrees with mpmath"""
    with M.workdps(DPS.get(name, 60)):
        r = MPF[name](*[M.mpf(x) if isinstance(x, float) else (M.mpc(x) if isinstance(x, complex) else x) for x in args])
    ar = abs(r)
    if not M.isfinite(ar):
        return None if not math.isfinite(abs(complex(v))) else "finite where mpmath has %s" % r
    av = abs(complex(v))
    if ar > DMAX:
        return None if not math.isfinite(av) else "%r where mpmath has %s (beyond the doubles)" % (v, M.nstr(r, 15))
    if not math.isfinite(av):
        return "%r where mpmath has %s" % (v, M.nstr(r, 15))
    if ar < M.mpf("2.2250738585072014e-308"):
        # (subnormal or 0: the same relative measure, to within 1e-321)
        ok = abs(M.mpc(v) - r) <= 1e-12 * ar * max(1, abs(M.log(ar))) + M.mpf("1e-321") if ar else av == 0
        return None if ok else "%r where mpmath has %s" % (v, M.nstr(r, 15))
    if av == 0:
        return "0 where mpmath has %s" % M.nstr(r, 15)
    err = abs(M.mpc(v) - r) / ar / max(1, abs(M.log(ar)))
    return None if err <= 1e-12 else "%r vs mpmath %s: %.2e" % (v, M.nstr(r, 15), float(err))
bad = []
for name, pts in calls.items():
    f = getattr(S, name, None)
    if f is None:
        continue
    for args in pts:
        signal.alarm(5)
        try:
            v = f(*args)
        except (S.PoleError, S.NotCovered):
            v = None
        except ValueError as e:
            if "math domain error" in str(e) or "math range error" in str(e):
                bad.append((name, args, "ValueError", str(e)))
            v = None
        except Timeout:
            bad.append((name, args, "TIMEOUT", ""))
            v = None
        except Exception as e:
            bad.append((name, args, type(e).__name__, str(e)[:80]))
            v = None
        finally:
            signal.alarm(0)
        if ORACLE and v is not None and name in MPF and not isinstance(v, (list, tuple)):
            signal.alarm(10)
            try:
                why = compare(name, args, v)
                if why:
                    bad.append((name, args, "WRONG", why))
            except Timeout:
                pass   # (mpmath too slow here: not judged)
            except Exception:
                pass   # (mpmath has no value here: not judged)
            finally:
                signal.alarm(0)
for b in bad:
    print(b)
print(len(bad), "problems")
