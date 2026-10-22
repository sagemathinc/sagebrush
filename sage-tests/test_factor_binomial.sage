# Binomials x^k (a x^m + b) over ZZ and QQ, factored from their cyclotomic
# structure (engine/poly/src/binomial.rs), checked against Sage.  Larger n
# print summaries: the number of factors, their total degree, the largest
# coefficient, and the sum of their values at 2 and 3 modulo a prime.
# Expected output (test_factor_binomial.out): SageMath version 10.10, Release Date: 2026-09-28.
R.<x> = ZZ[]
for n in [240, 360, 1000]:
    for s in [-1, 1]:
        F = (x^n + s).factor()
        big = max(max(abs(c) for c in g.list()) for g, e in F)
        v2 = sum(g(2) for g, e in F) % 1000000007
        v3 = sum(g(3) for g, e in F) % 1000000007
        print(n, s, len(F), sum(g.degree() * e for g, e in F), big, v2, v3)
print((x^30 - 1).factor())
print((x^24 + 1).factor())
print((x^105 - 1).factor()[-1][0].degree())
for f in [x^4 - 64, 9*x^4 - 4, 8*x^6 + 27, 16*x^12 - 81, 2*x^6 - 128, 27*x^9 + 8,
          -x^5 + 32, x^4 + 4, x^5 - 2, 3*x^10 - 3, x^7*(x^30 - 1), 9*x^2 - 4,
          27*x^3 + 8, x^4 - 16, x^8 - 16, 4*x^20 - 9, x^6 + 8, -8*x^6 - 27,
          1024*x^10 - 59049]:
    print(f.factor())
print([g.degree() for g, e in (2^4200*x^2 - 1).factor()])
Q.<y> = QQ[]
print((y^8 - 1/16).factor())
print((4*y^6 + 27/2).factor())
