R.<x> = ZZ[]
S.<y> = PolynomialRing(QQ)
print(R, S, R.gen(), parent(x))
f = (x-1)^2*(2*x+3)*(x^2+1)
print(f, f.roots(), f.roots(multiplicities=False), f.degree(), f.list(), f.coefficients())
g = (2*y^2 - 2)*(3*y+1)
print(g.factor(), g.roots(), (y^2/2 + 1/3), (y^2/2+1/3).factor())
print((x^4-1).factor().unit(), list((x^4-1).factor()), len((12*x+12).factor()))
print(f.discriminant(), (x^3-2).discriminant(), (x^2+1).resultant(x^2-1), gcd(x^4-1, x^6-1), f.derivative(), f(2), f(x+1))
print((x^2-1) // (x-1), (x^3+1) % (x-1), (x^2-1)/(x-1))
print(x.is_irreducible(), (x^2+1).is_irreducible(), (x^2-1).is_irreducible())
print(ZZ, QQ, ZZ['t'], QQ['z'])
for h in [x^3 - x^2 - 6*x, (x-3)*(x+2)*(x-5)*(x+7), (x^2+1)*(x^2-2)*(x^2+3*x+1)*(x-1)*(x+1), 12*(x+1)*(x-1)^2, -(x^2-1), (3*x+1)*(2*x-1)*(x+5), (x-1)^3*(x+1)^2*(x+5), 60*(x+1), 90*x, -6*(x+1), 360*(x^2+1)^2*(x-1), 4*x, R(12), R(-1), -x, 7*(x+1)^2*(x-1)^2]:
    print(h.factor())
print(ModularSymbols(389,2,sign=1).hecke_polynomial(2).factor())
print(factor(x^6 - 1), ZZ(5), QQ(3))

# cyclotomic and classical hard cases
for n in [12, 15, 30, 36, 60, 105]:
    print(n, (x^n - 1).factor())
print((x^16 + 1).factor(), (x^4 - 10*x^2 + 1).factor(), (x^8 - 40*x^6 + 352*x^4 - 960*x^2 + 576).factor())

# deterministic pseudo-random products (a small LCG, so Sage and sagebrush agree)
seed = 12345
def rnd(m):
    global seed
    seed = (1103515245*seed + 12345) % 2^31
    return seed % m
for trial in range(60):
    f = R(1)
    for j in range(1 + rnd(4)):
        d = 1 + rnd(5)
        g = R([rnd(21) - 10 for i in range(d)] + [1 + rnd(3)])
        f *= g^(1 + rnd(2))
    F = f.factor()
    print(F, F.value() == f, [r for r in f.roots()])

# over QQ
for h in [(y^2 - 1/4)*(2*y + 1/3), y^3/7 - 1, 3*(y - 1/2)^2*(y^2 + 2)]:
    print(h.factor(), h.roots(), h.monic())

# Hecke polynomials
for N in [37, 67, 389]:
    print(N, ModularSymbols(N, 2, sign=1).hecke_polynomial(2).factor())
