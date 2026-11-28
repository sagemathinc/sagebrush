# A number field element's value under its embedding, as Sage converts it:
# its polynomial in the generator by Horner's rule in the target field, at
# the generator's value there (each part the center of AA's interval);
# comparisons and signs with a complex embedding or none
def show(label, f):
    try:
        print(label, "|", f())
    except Exception as e:
        print(label, "|", type(e).__name__, e)
x = polygen(QQ, 'x')
fields = [(x^2 - 2, 1.4), (x^2 - 2, -1.4), (x^3 - 2, 1.2), (x^3 - x - 1, 1.3), (x^4 - 10*x^2 + 1, -3.1), (x^4 - 10*x^2 + 1, 0.3), (x^2 - 3, -1.7), (x^5 - 3, 1.2)]
for f, e in fields:
    K = NumberField(f, 'a', embedding=e); a = K.gen()
    for z in [a, -a, a - 1, a^2 - 2, 1/(a + 3), a^3/7 - a/5, K(0), K(1/3)]:
        show("%s at %s: %s: float, RDF, RR, CC" % (f, e, z), lambda: (float(z), RDF(z), RR(z), CC(z)))
        show("%s at %s: %s: RealField(24), (100), (200)" % (f, e, z), lambda: (RealField(24)(z), RealField(100)(z), RealField(200)(z)))
        show("%s at %s: %s: sign, < 0, > 1" % (f, e, z), lambda: (z.sign(), z < 0, z > 1))
K = NumberField(x^2 - 2, 'a', embedding=1.4); a = K.gen()
for p in [10, 24, 40, 64, 80, 113, 150, 300]:
    show("RealField(%d)(a), ComplexField(%d)(a/3 + 1)" % (p, p), lambda: (RealField(p)(a), ComplexField(p)(a/3 + 1)))
show("RealField(200)(a)^2 - 2 tiny", lambda: abs(RealField(200)(a)^2 - 2) < RealField(200)(2)^-180)
show("past the doubles: float, RR", lambda: (float(K(10)^400), RR(K(10)^400), float(a*10^400), RR(a*10^400), float(-a*10^400)))
show("below the doubles: float, RR", lambda: (float(K(10)^-400), RR(K(10)^-400), float(a/10^400), RR(a/10^400)))
show("RDF, CDF past the doubles", lambda: (RDF(a*10^400), CDF(a*10^400)))
# complex embeddings
for f, e in [(x^2 + 1, CC(0, -1)), (x^2 + x + 1, CC(-0.5, 0.8)), (x^3 - 2, CC(-0.6, 1.1)), (x^4 + 1, CC(0.7, -0.7))]:
    K = NumberField(f, 'b', embedding=e); b = K.gen()
    for z in [b, b + 1, b^2/3 - 1, K(2)]:
        show("%s at %s: %s: CC, CDF, complex" % (f, e, z), lambda: (CC(z), CDF(z), complex(z)))
        show("%s at %s: %s: ComplexField(100)" % (f, e, z), lambda: ComplexField(100)(z))
        show("%s at %s: %s: float" % (f, e, z), lambda: float(z))
        show("%s at %s: %s: RR" % (f, e, z), lambda: RR(z))
        show("%s at %s: %s: < 1, > 1, < -1, <= 0, >= 0, > b" % (f, e, z), lambda: (z < 1, z > 1, z < -1, z <= 0, z >= 0, z > b))
        show("%s at %s: %s: sign" % (f, e, z), lambda: z.sign())
# no embedding
for f in [x^2 - 5, x^2 + 3*x + 1, x^2 + x + 1, x^2 + 7, x^3 - 2, x^4 + 1]:
    K = NumberField(f, 'c'); c = K.gen()
    for z in [c, -c, c - 3, K(1/3), K(-2)]:
        show("%s: %s: < 0, > 0, < 100, > -100, < K(1), >= c" % (f, z), lambda: (z < 0, z > 0, z < 100, z > -100, z < K(1), z >= c))
        show("%s: %s: sign" % (f, z), lambda: z.sign())
        show("%s: %s: float, RR, CC" % (f, z), lambda: (float(z), RR(z), CC(z)))
show("QuadraticField(5, None): c < 0, c > 2, c < 3", lambda: (lambda c: (c < 0, c > 2, c < 3))(QuadraticField(5, 'c', embedding=None).gen()))
# embeddings exactly close: decided exactly, not by their doubles
f = (x - 1)^2 - QQ(2)/QQ(2)^200
ep = QQbar(1) + QQbar(2).sqrt()/QQbar(2)^100; em = QQbar(1) - QQbar(2).sqrt()/QQbar(2)^100
Kp = NumberField(f, 'u', embedding=ep); Km = NumberField(f, 'u', embedding=em)
show("Kp is Km, Kp == Km", lambda: (Kp is Km, Kp == Km))
show("Kp: u > 1, (u - 1).sign(); Km: u > 1, (u - 1).sign()", lambda: (Kp.gen() > 1, (Kp.gen() - 1).sign(), Km.gen() > 1, (Km.gen() - 1).sign()))
show("Kp is NumberField(f, 'u', embedding=ep)", lambda: Kp is NumberField(f, 'u', embedding=ep))
# the embedding's kind, as Sage's codomain: numbers through the real or the
# complex lazy field, AA and QQbar exact; each another field
f = x^2 - 2
base = {k: NumberField(f, 'a', embedding=e) for k, e in [("RLF", 1.4), ("CLF", CC(1.4)), ("AA", AA(2).sqrt()), ("QQbar", QQbar(2).sqrt())]}
for n, e in [("1.41", 1.41), ("RR", RR(1.4)), ("RealField(100)", RealField(100)(1.4)), ("RDF", RDF(1.4)), ("QQ", QQ(7/5)), ("1", 1), ("CC", CC(1.4)), ("CDF", CDF(1.4)), ("AA", AA(2).sqrt()), ("QQbar", QQbar(2).sqrt())]:
    show("embedding=%s is: RLF, CLF, AA, QQbar" % n, lambda: tuple(NumberField(f, 'a', embedding=e) is base[k] for k in ["RLF", "CLF", "AA", "QQbar"]))
show("RLF == AA, CLF == QQbar", lambda: (base["RLF"] == base["AA"], base["CLF"] == base["QQbar"]))
for n, e in [("RLF", 1.26), ("CLF", CC(1.26)), ("AA", AA(2)^(1/3)), ("QQbar", QQbar(2)^(1/3))]:
    K = NumberField(x^3 - 2, 'c', embedding=e); c = K.gen()
    for z in [c, c/3 + QQ(1)/3, c^2/7 - 1]:
        show("x^3 - 2 by %s: %s: < 2, > 2" % (n, z), lambda: (z < 2, z > 2))
        show("x^3 - 2 by %s: %s: sign" % (n, z), lambda: z.sign())
        show("x^3 - 2 by %s: %s: float, RR, RealField(100), CC, RealField(30)" % (n, z), lambda: (float(z), RR(z), RealField(100)(z), CC(z), RealField(30)(z)))
for n, K in base.items():
    a = K.gen()
    show("x^2 - 2 by %s: a < 2, a.sign(), float(a/3 + 1/3), RealField(24)(a/3 + 1/3)" % n, lambda: (a < 2, a.sign(), float(a/3 + QQ(1)/3), RealField(24)(a/3 + QQ(1)/3)))
Q2 = QuadraticField(2, 'a')
show("float(QuadraticField(2).gen()/3 + 1/3), RR", lambda: (float(Q2.gen()/3 + QQ(1)/3), RR(Q2.gen()/3 + QQ(1)/3)))
for n, e in [("AA", AA(2).sqrt()), ("CC", CC(1.4)), ("-AA", -AA(2).sqrt()), ("RR", RR(1.4))]:
    show("QuadraticField(2, embedding=%s): is QuadraticField(2), repr" % n, lambda: (lambda K: (K is Q2, K))(QuadraticField(2, 'a', embedding=e)))
# QQ[...]'s fields: through RLF or CLF
for n, K in [("QQ[AA(2).sqrt()]", QQ[AA(2).sqrt()]), ("QQ[QQbar(2)^(1/3)]", QQ[QQbar(2)^(1/3)]), ("QQ[QQbar(-3).sqrt()]", QQ[QQbar(-3).sqrt()])]:
    g = K.gen()
    show("%s: g < 2, g > 1, CC(g + 1)" % n, lambda: (g < 2, g > 1, CC(g + 1)))
    show("%s: float(g/3 + 1/3)" % n, lambda: float(g/3 + QQ(1)/3))
