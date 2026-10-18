"""The Sage layer against Sage: the same Python code (no preparser) run with
sagebrush.sage's names and with Sage's (bench/linalg/README.md, The Sage
layer). The inputs are those of bench/linalg/cases.py. Each call works on a
copy of the matrix, which has no cached results (Sage caches det, charpoly
and echelon forms on the matrix)."""

from . import _bench_common
from ._sage import Sage
from ._timing import sample
from .suite import Case, Suite

ZZMAT = "M = matrix(ZZ, mat({n}, {m}, 1009, 504))"
QQMAT = "M = matrix(QQ, [[QQ(a) / b for a, b in row] for row in qmat_parts({n})])"
QQRECT = "M = matrix(QQ, mat({n}, {m}, 1009, 504))"
POLYS = ("R = PolynomialRing(ZZ, 'x')\n"
         "f, g, h = R(poly({n}, 23, 11, 1)), R(poly({n}, 19, 9, 7)), R(poly({n} // 2, 13, 6, 5))\n"
         "a, b = f * h, g * h")
PRODUCT = "R = PolynomialRing(ZZ, 'x')\nf, g = R(poly({n}, 1000003, 500001, 1)), R(poly({n}, 1000033, 500016, 7))"

# (label, setup, call, answer, tier)
CASES = []
for n in (20, 50, 100):
    CASES.append((f"det ZZ {n}x{n}", ZZMAT.format(n=n, m=n), "copy(M).det()", "fpq([r])",
                  "quick" if n <= 50 else "standard"))
for n in (10, 20, 40):
    CASES.append((f"det QQ {n}x{n}", QQMAT.format(n=n), "copy(M).det()", "fpq([r])",
                  "quick" if n <= 20 else "standard"))
for n in (20, 40):
    CASES.append((f"inverse QQ {n}x{n}", QQMAT.format(n=n), "copy(M).inverse()", "fpq(r.list())",
                  "quick" if n == 20 else "standard"))
for n in (30, 60):
    CASES.append((f"rref QQ {n}x{n + 10}", QQRECT.format(n=n, m=n + 10), "copy(M).echelon_form()",
                  "fpq(r.list())", "quick" if n == 30 else "standard"))
for n in (30, 60):
    CASES.append((f"charpoly ZZ {n}x{n}", ZZMAT.format(n=n, m=n), "copy(M).charpoly()", "fpq(r.list())",
                  "quick" if n == 30 else "standard"))
for n in (100, 300, 1000):
    CASES.append((f"gcd ZZ[x] degree {n + n // 2 - 2}", POLYS.format(n=n), "a.gcd(b)", "fpq(r.list())",
                  "quick" if n <= 300 else "standard"))
for n in (1000, 10000):
    CASES.append((f"product ZZ[x] degree {n - 1}", PRODUCT.format(n=n), "f * g", "fpq(r.list())",
                  "quick" if n == 1000 else "standard"))


class Ours:
    ours = True
    name = "sagebrush"
    short = "sb"
    label = "sagebrush.sage (the Sage layer, under this Python)"

    def __init__(self):
        self.ns = None

    def available(self):
        return True

    def version(self):
        return None

    def run(self, case, repeat, timeout):
        if self.ns is None:
            from sagebrush import sage

            self.ns = {k: getattr(sage, k) for k in sage.__all__}
            self.ns.update(vars(_bench_common))
        ns = dict(self.ns)
        exec(case.params["setup"], ns)
        t = sample(eval("lambda: " + case.params["call"], ns), repeat)
        ns["r"] = t.answer
        t.answer = eval(case.params["answer"], ns)
        return t

    def close(self):
        pass


class SageEngine(Sage):
    def __init__(self):
        super().__init__(label="Sage (its default algorithms)")

    def run(self, case, repeat, timeout):
        p = case.params
        return self.time(p["setup"], p["call"], p["answer"], repeat, timeout)


class SageLayerSuite(Suite):
    name = "sagelayer"
    title = "exact linear algebra and Z[x] through the Sage layer, against Sage (one core)"
    claim = ("README.md (In the Sage layer: det, rref and inverse ... close to Sage itself); "
             "bench/linalg/README.md, The Sage layer")

    def cases(self):
        return [Case(label, {"setup": setup, "call": call, "answer": answer}, tier)
                for label, setup, call, answer, tier in CASES]

    def engines(self):
        return [Ours(), SageEngine()]


SAGELAYER = SageLayerSuite()
