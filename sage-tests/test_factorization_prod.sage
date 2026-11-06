# Factorization.prod(): the product, as value(), and prod(F) of a factorization
# (Sage's prod uses F.prod(), its z unused), for each kind of factorization.
def t(label, f):
    try:
        print(label, repr(f()))
    except Exception as e:
        print(label, type(e).__name__, str(e)[:200])
F = factor(360)
t("ZZ prod", lambda: (F.prod(), prod(F), F.prod() == F.value()))
t("ZZ neg", lambda: (factor(-12).prod(), prod(factor(-12))))
t("ZZ one", lambda: (factor(1).prod(), prod(factor(1))))
t("QQ", lambda: (factor(-9/20).prod(), prod(factor(-9/20))))
R.<x> = QQ[]
G = factor(2*x^2 - 2)
t("QQ[x]", lambda: (G.prod(), prod(G)))
t("ZZ[x]", lambda: (factor(ZZ['x'](4*x^2 - 4)).prod(), prod(factor(ZZ['x'](4*x^2 - 4)))))
S.<a, b> = QQ[]
t("QQ[a,b]", lambda: (factor(a^2 - b^2).prod(), prod(factor(3*a^2 - 3*b^2))))
K.<i> = NumberField(x^2 + 1)
T.<y> = K[]
t("K[y]", lambda: (factor(y^2 + 1).prod(), prod(factor(2*y^2 + 2))))
U.<z> = GF(7)[]
t("GF(7)[z]", lambda: (factor(3*z^2 - 3).prod(), prod(factor(z^3 - 1))))
V.<w> = GF(9)[]
t("GF(9)[w]", lambda: (factor(w^2 - 1).prod(), prod(factor(w^4 - 1))))
t("prod(F, 2)", lambda: prod(F, 2))
t("doctests", lambda: (factor(-360).prod(), prod(factor(-360)), factor(-9/20).prod()))
