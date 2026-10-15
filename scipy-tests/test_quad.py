# quad, dblquad, tplquad, nquad: QUADPACK's QAGS and QAGI, so the values, the
# error estimates and neval must be SciPy's exactly.  (Except for integrands
# with sin and cos: Sagebrush's differ from glibc's in the last bit for a few
# percent of arguments (NUMPY.md), so those are compared within a tolerance.)
import math
import warnings
import numpy as np
from scipy.integrate import quad, dblquad, tplquad, nquad, IntegrationWarning
from _check import check


def show(label, f, a, b, trig=False, **kw):
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        r = quad(f, a, b, **kw)
    if kw.get("full_output"):
        info = r[2]
        extra = r[3:] if len(r) > 3 else ()
        r = r[:2] + ({"neval": info["neval"], "last": info["last"]},) + tuple(m.split("\n")[0] for m in extra)
    if trig:
        check(label, r[:2], 1e-12, 1e-14)
        r = r[2:]
    print(label, r, [(x.category.__name__, str(x.message).split("\n")[0]) for x in w])


show("x^2", lambda x: x**2, 0, 1)
show("x^2 flipped", lambda x: x**2, 2, 0)
show("a == b", lambda x: x**2, 1, 1)
show("exp(-x^2) R", lambda x: np.exp(-x**2), -np.inf, np.inf)
show("1/(1+x^2) [0,inf)", lambda x: 1 / (1 + x**2), 0, np.inf)
show("exp(x) (-inf,0]", lambda x: math.exp(x), -np.inf, 0)
show("exp(-x) [3,inf)", lambda x: math.exp(-x), 3, math.inf)
show("1/sqrt(x)", lambda x: 1 / math.sqrt(x), 0, 1)
show("log(x)", lambda x: math.log(x), 0, 1)
show("x^-0.9", lambda x: x**-0.9, 0, 1)
show("sinc", lambda x: math.sin(x) / x if x else 1.0, 0, 50, trig=True)
show("|x-0.3|", lambda x: abs(x - 0.3), -1, 2)
show("cos(100x)", lambda x: math.cos(100 * x), 0, math.pi, trig=True)
show("step", lambda x: 1.0 if x > 0.25 else 0.0, 0, 1)
show("1/x divergent", lambda x: 1 / x, 0, 1)
show("sin(x)/x^2 full", lambda x: math.sin(x) ** 2 / x**2 if x else 1.0, 0, np.inf, full_output=1, trig=True)
show("x^2 full", lambda x: x**2, 0, 1, full_output=1)
show("limit 3", lambda x: math.cos(30 * x) ** 2, 0, 10, limit=3, trig=True)
show("limit 3 full", lambda x: math.cos(30 * x) ** 2, 0, 10, limit=3, full_output=1, trig=True)
show("args", lambda x, a, b: a * x + b, 0, 2, args=(3, 1))
show("one arg", lambda x, a: a * x, 0, 2, args=4)
show("epsrel 1e-3", lambda x: math.exp(math.sin(x)), 0, 20, epsrel=1e-3, epsabs=0, trig=True)
show("epsabs 1e-12", lambda x: math.exp(math.sin(x)), 0, 20, epsabs=1e-12, epsrel=0, trig=True)
show("gaussian 1e-14", lambda x: math.exp(-x * x / 2) / math.sqrt(2 * math.pi), -5, 5, epsabs=1e-14, epsrel=1e-14)
show("numpy scalar", lambda x: np.float64(x) ** 3, -1, 2)
show("complex", lambda x: np.exp(1j * x), 0, 1, complex_func=True)
show("x^4 e^-x", lambda x: x**4 * math.exp(-x), 0, np.inf)
show("1/x^2 [1,inf)", lambda x: 1 / x**2, 1, np.inf)
show("log(x)/(1+x^2) [0,inf)", lambda x: math.log(x) / (1 + x * x), 0, np.inf)
try:
    quad(lambda x: x, 0, 1, epsabs=0, epsrel=1e-30)
except ValueError as e:
    print("ValueError", e)
r = quad(lambda x: x, 0, 1, full_output=1)[2]
print(sorted(r), r["neval"], r["last"], r["alist"][:1], r["blist"][:1], r["rlist"][:1], r["elist"][:1], r["iord"][:1])
for f, a, b in [(lambda x: math.sqrt(x) * math.log(x) if x else 0.0, 0, 1), (lambda x: 1 / (1 + x * x), 0, math.inf),
                (lambda x: x**-0.9, 0, 1), (lambda x: abs(x - 0.3), -1, 2)]:
    r = quad(f, a, b, full_output=1)[2]
    n = r["last"]
    print(n, r["iord"][:n], r["alist"][:n], r["blist"][:n], r["rlist"][:n], r["elist"][:n])

print(dblquad(lambda y, x: x * y, 0, 1, lambda x: 0, lambda x: x))
print(dblquad(lambda y, x: math.exp(-x - y), 0, np.inf, 0, np.inf))
print(dblquad(lambda y, x, a: a * x * x + y, 0, 1, -1, 2, args=(3,)))
print(tplquad(lambda z, y, x: x * y * z, 0, 1, 0, lambda x: 1 - x, 0, lambda x, y: 1 - x - y))
print(nquad(lambda x, y: x * y, [[0, 1], [0, 2]]))
print(nquad(lambda x, y, c: c * x + y, [lambda y, c: [0, y], [0, 1]], args=(2,)))
print(nquad(lambda x, y: math.exp(-x * x - y * y), [[-np.inf, np.inf], [-np.inf, np.inf]], opts={"epsabs": 1e-10}))
print(nquad(lambda x, y: x * y, [[0, 1], [0, 1]], full_output=True))
