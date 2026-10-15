"""lib/_special.py's public functions at the edges of the doubles (near
+-1e308, the subnormals, huge complex parts): reports anything but a value,
PoleError, NotCovered or a ValueError of _special's own, so a raw
OverflowError, ZeroDivisionError, 'math domain error', or a call taking
more than 5 s.  Run with CPython:

    python3 scripts/special-edge-sweep.py lib/_special.py
"""
import importlib.util, itertools, math, sys, signal
spec = importlib.util.spec_from_file_location("_special", sys.argv[1] if len(sys.argv) > 1 else "lib/_special.py")
S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)
big = [1.7976931348623157e308, 1e308, 1e300, 1e200, 1e20]
small = [5e-324, 1e-310, 1e-300, 1e-200]
reals = [0.0, -0.0, 0.5, 1.0, 2.0, -1.5, -3.0] + big + [-v for v in big] + small + [-v for v in small]
cplx = [complex(a, b) for a in (0.0, 1e308, -1e308, 1.0, 1e-300) for b in (1e308, -1e308, 1e-300, 1.0)]
ones = [(v,) for v in reals + cplx]
ints = [0, 1, 2, 5, 50, 100]
calls = {
    "loggamma": ones, "gamma": ones, "psi": ones, "zeta": ones, "faddeeva": ones, "erf": ones, "erfc": ones, "erfi": ones,
    "erfcx": ones, "erfinv": ones, "erfcinv": ones, "exp_integral_e1": ones, "exp_integral_ei": [(v,) for v in reals],
    "lambert_w": [(v, k) for v in reals + cplx for k in (0, -1, 1)], "dilog": ones, "ellipk": [(v,) for v in reals],
    "ellipe": [(v,) for v in reals],
    "polygamma": [(n, v) for n in (1, 2, 5) for v in reals + cplx],
    "hurwitz_zeta": [(s, a) for s in (2.0, 0.5, -1.0, 1e300, -1e300) for a in [0.5, 1e300, 1e-300, 1e308]],
    "beta": [(a, b) for a in reals for b in (0.5, 2.0, 1e308, -1e308, 5e-324)],
    "betaln": [(a, b) for a in reals for b in (0.5, 2.0, 1e308, 5e-324)],
    "polylog": [(n, v) for n in (-5, 0, 1, 2, 3, 10) for v in reals + cplx],
    "ellipj": [(u, m) for u in reals for m in (0.0, 0.5, 1.0, 1 - 1e-16, -1e308)],
    "legendre_all": [(n, x) for n in (0, 1, 2, 50) for x in (0.0, 1.0, -1.0, 5e-324, 1 - 1e-16)],
    "assoc_legendre_p": [(n, m, x) for n in (2, 50) for m in (0, 1, -1) for x in (0.0, 1.0, 5e-324, 1 - 1e-16)],
    "legendre_p": [(n, x) for n in (0, 3, 100) for x in (0.0, 1.0, 5e-324, -1.0)],
    "gammainc": [(a, x) for a in (0.0, 0.5, 1e308, 1e-300, 5e-324) for x in (0.0, 5e-324, 1e308, 1.7976931348623157e308, 1.0)],
    "gammaincc": [(a, x) for a in (0.0, 0.5, 1e308, 1e-300, 5e-324) for x in (0.0, 5e-324, 1e308, 1.7976931348623157e308, 1.0)],
    "besselj": [(nu, x) for nu in (0.0, 0.5, 3.0, -2.0, 170.5, 1e308, 1e20) for x in reals],
}
class Timeout(Exception):
    pass
def alarm(*a):
    raise Timeout()
signal.signal(signal.SIGALRM, alarm)
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
            pass
        except ValueError as e:
            if "math domain error" in str(e) or "math range error" in str(e):
                bad.append((name, args, "ValueError", str(e)))
        except Timeout:
            bad.append((name, args, "TIMEOUT", ""))
        except Exception as e:
            bad.append((name, args, type(e).__name__, str(e)[:80]))
        finally:
            signal.alarm(0)
for b in bad:
    print(b)
print(len(bad), "problems")
