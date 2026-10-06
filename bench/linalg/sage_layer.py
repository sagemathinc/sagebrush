"""The Sage layer before (pure-Python Fraction elimination, Euclid over QQ)
and after (sagebrush.linalg / sagebrush.poly in the Rust engine).
Usage: python sage_layer.py   (with sagebrush installed)"""
import sys, time
from fractions import Fraction as _F
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from cases import mat, qmat, poly
from sagebrush.sage import *


def old_det(rows):
    m = [[_F(x) for x in r] for r in rows]
    n = len(m)
    d = _F(1)
    for c in range(n):
        p = next((i for i in range(c, n) if m[i][c] != 0), None)
        if p is None:
            return 0
        if p != c:
            m[c], m[p] = m[p], m[c]
            d = -d
        d *= m[c][c]
        for i in range(c + 1, n):
            f = m[i][c] / m[c][c]
            if f:
                for j in range(c, n):
                    m[i][j] -= f * m[c][j]
    return d


def old_rref(rows):
    m = [[_F(x) for x in r] for r in rows]
    nr, nc = len(m), len(m[0])
    r = 0
    for c in range(nc):
        p = next((i for i in range(r, nr) if m[i][c] != 0), None)
        if p is None:
            continue
        m[r], m[p] = m[p], m[r]
        inv = 1 / m[r][c]
        m[r] = [x * inv for x in m[r]]
        for i in range(nr):
            if i != r and m[i][c] != 0:
                f = m[i][c]
                m[i] = [a - f * b for a, b in zip(m[i], m[r])]
        r += 1
    return m


def old_gcd(a, b):
    # Euclid over QQ, as the layer did
    a = [_F(x) for x in a]
    b = [_F(x) for x in b]
    def rem(a, b):
        r = list(a)
        while len(r) >= len(b) and any(r):
            c = r[-1] / b[-1]
            s = len(r) - len(b)
            for j, y in enumerate(b):
                r[s + j] -= c * y
            r.pop()
            while r and r[-1] == 0:
                r.pop()
        return r
    while b:
        a, b = b, rem(a, b)
    return a


def t(f, limit=60.0):
    s = time.perf_counter()
    r = f()
    return time.perf_counter() - s, r


R = PolynomialRing(ZZ, "x")
rows = []
print("%-22s %12s %12s %9s" % ("operation", "before", "after", "speedup"), flush=True)


class Rows(list):
    def append(self, row):
        name, (to, _), (tn, _) = row
        print("%-22s %12s %12s %9s" % (name, "-" if to is None else "%.4f s" % to, "%.4f s" % tn, "-" if to is None else "%.0fx" % (to / tn)), flush=True)


rows = Rows()
for n in [20, 50, 100]:
    A = mat(n, n, 1009, 504)
    M = matrix(ZZ, A)
    rows.append(("det ZZ %dx%d" % (n, n), t(lambda: old_det(A)) if n <= 50 else (None, None), t(lambda: M.det())))
for n in [10, 20, 40]:
    Q = qmat(n)
    M = matrix(QQ, Q)
    rows.append(("det QQ %dx%d" % (n, n), t(lambda: old_det(Q)), t(lambda: M.det())))
for n in [20, 40]:
    Q = qmat(n)
    M = matrix(QQ, Q)
    rows.append(("inverse QQ %dx%d" % (n, n), t(lambda: old_rref([r + [int(i == j) for j in range(n)] for i, r in enumerate(Q)])) if n <= 20 else (None, None), t(lambda: M.inverse())))
for n in [30, 60]:
    A = mat(n, n + 10, 1009, 504)
    M = matrix(ZZ, A)
    rows.append(("rref QQ %dx%d" % (n, n + 10), t(lambda: old_rref(A)) if n <= 30 else (None, None), t(lambda: M.change_ring(QQ).echelon_form())))
for n in [30, 60]:
    M = matrix(ZZ, mat(n, n, 1009, 504))
    rows.append(("charpoly ZZ %dx%d" % (n, n), (None, None), t(lambda: M.charpoly())))
for n in [100, 300, 1000]:
    f, g, h = poly(n, 23, 11, 1), poly(n, 19, 9, 7), poly(n // 2, 13, 6, 5)
    fh, gh = (R(f) * R(h)).list(), (R(g) * R(h)).list()
    rows.append(("gcd ZZ[x] deg %d" % (len(fh) - 1), t(lambda: old_gcd(fh, gh)) if n <= 100 else (None, None), t(lambda: R(fh).gcd(R(gh)))))
for n in [1000, 10000]:
    f, g = R(poly(n, 1000003, 500001, 1)), R(poly(n, 1000033, 500016, 7))
    rows.append(("mul ZZ[x] deg %d" % (n - 1), (None, None), t(lambda: f * g)))

