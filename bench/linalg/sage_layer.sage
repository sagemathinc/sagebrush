# The same operations in Sage (FLINT/PARI underneath), for comparison.
import time, sys
sys.path.insert(0, '.')
from cases import mat, qmat, poly
def t(f):
    s = time.perf_counter(); f(); return time.perf_counter() - s
R.<x> = ZZ[]
out = []
for n in [20, 50, 100]:
    M = matrix(ZZ, mat(n, n, 1009, 504)); out.append(("det ZZ %dx%d" % (n, n), t(lambda: M.det())))
for n in [10, 20, 40]:
    M = matrix(QQ, qmat(n)); out.append(("det QQ %dx%d" % (n, n), t(lambda: M.det())))
for n in [20, 40]:
    M = matrix(QQ, qmat(n)); out.append(("inverse QQ %dx%d" % (n, n), t(lambda: M.inverse())))
for n in [30, 60]:
    M = matrix(QQ, mat(n, n + 10, 1009, 504)); out.append(("rref QQ %dx%d" % (n, n + 10), t(lambda: M.echelon_form())))
for n in [30, 60]:
    M = matrix(ZZ, mat(n, n, 1009, 504)); out.append(("charpoly ZZ %dx%d" % (n, n), t(lambda: M.charpoly())))
for n in [100, 300, 1000]:
    f, g, h = R(poly(n, 23, 11, 1)), R(poly(n, 19, 9, 7)), R(poly(n // 2, 13, 6, 5))
    a, b = f * h, g * h
    out.append(("gcd ZZ[x] deg %d" % a.degree(), t(lambda: a.gcd(b))))
for n in [1000, 10000]:
    f, g = R(poly(n, 1000003, 500001, 1)), R(poly(n, 1000033, 500016, 7))
    out.append(("mul ZZ[x] deg %d" % (n - 1), t(lambda: f * g)))
for name, s in out:
    print("%-22s %10.4f s" % (name, s))
