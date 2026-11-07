# Polynomials over inexact fields against other rings, and board's #784 COPY rows (C1-C5) and the three
# behaviour rows (@sagebrush's rulings): Sage's exact errors, a call with keywords or no value, the zero's monic,
# and the mixed-ring refusals (wrong answers before: RR[t] / GF(7)[u] was 1) for one ring of each class family
# Sage names in p / q (GF(2), GF(p) and Zmod(n) below 2^64, GF(p) from 2^64, composite Zmod(n) from 2^64 "(using
# NTL)", GF(p^k), a number field without an embedding).
def show(label, f):
    try:
        print(label, "->", f())
    except Exception as e:
        print(label, "->", "%s: %s" % (type(e).__name__, e))
y = SR.var('y')
for K in [RR, RDF, CDF, RealField(100), ComplexField(100)]:
    R = K['t']; t = R.gen(); f = t + 1; u = K['u'].gen()
    show("%s gen(1)" % K, lambda: R.gen(1))
    show("%s t + u" % K, lambda: t + u)
    show("%s u * t" % K, lambda: u * t)
    show("%s t / u" % K, lambda: t / u)
    show("%s t == u" % K, lambda: t == u)
    show("%s f(1, 2)" % K, lambda: f(1, 2))
    show("%s f / complex(1, 2)" % K, lambda: f / complex(1, 2))
    if K is not CDF:
        # (CDF[t] answers complex(1, 2) / f, in its fraction field)
        show("%s complex(1, 2) / f" % K, lambda: complex(1, 2) / f)
    show("%s f ** (1/2)" % K, lambda: f ** (1/2))
    show("%s f ** y" % K, lambda: f ** y)
    show("%s f ** CDF(2)" % K, lambda: f ** CDF(2))
    show("%s f ** RR(2.5)" % K, lambda: f ** RR(2.5))
    show("%s f ** sqrt(2)" % K, lambda: f ** sqrt(2))
    show("%s f()" % K, lambda: f())
    show("%s f(x=2)" % K, lambda: f(x=2))
    show("%s f(2, x=3)" % K, lambda: f(2, x=3))
    show("%s f(t=2, x=3)" % K, lambda: f(t=2, x=3))
    show("%s f(1, 2, x=3)" % K, lambda: f(1, 2, x=3))
    show("%s R(0).monic()" % K, lambda: R(0).monic())
    show("%s R(0).monic().parent()" % K, lambda: R(0).monic().parent())
t = RR['t'].gen()
for B in [QQ, ZZ]:
    b = B['u'].gen() + 1
    show("RR[t] + %s[u]" % B, lambda: t + b)
    show("%s[u] + RR[t]" % B, lambda: b + t)
    show("RR[t] / %s[u]" % B, lambda: t / b)
    show("%s[u] / RR[t]" % B, lambda: b / t)
show("RR[t] / GF(7)[u]", lambda: t / GF(7)['u'].gen())
show("GF(4)[u] / RR[t]", lambda: GF(4, 'a')['u'].gen() / t)
show("RR[t] + GF(4)[u]", lambda: t + GF(4, 'a')['u'].gen())
for B in [GF(2), GF(7), Zmod(6), GF(2^64 - 59), Zmod(2^64 - 1), GF(next_prime(2^64)), Zmod(2^64), GF(9, 'b'), GF(8, 'd'), NumberField(x^2 + 1, 'j')]:
    for K in [RR, CDF]:
        a = K['t'].gen() + 1
        for v in ['t', 'u']:
            b = B[v].gen() + 1
            show("%s[t] + %s[%s]" % (K, B, v), lambda: a + b)
            show("%s[%s] - %s[t]" % (B, v, K), lambda: b - a)
            show("%s[t] * %s[%s]" % (K, B, v), lambda: a * b)
            show("%s[t] / %s[%s]" % (K, B, v), lambda: a / b)
            show("%s[%s] / %s[t]" % (B, v, K), lambda: b / a)
            show("%s[t] == %s[%s]" % (K, B, v), lambda: a == b)
            show("%s[t](%s[%s])" % (K, B, v), lambda: a(b))
            show("%s[%s](%s[t])" % (B, v, K), lambda: b(a))
        show("%s[t](%s(1))" % (K, B), lambda: a(B(1)))
        show("%s[t] + %s(1)" % (K, B), lambda: a + B(1))
        show("%s(1) * %s[t]" % (B, K), lambda: B(1) * a)
        show("%s[t] / %s(1)" % (K, B), lambda: a / B(1))
w = QuadraticField(2, 'w').gen()
show("RR[t] + QuadraticField(2)[u]", lambda: t + w * QuadraticField(2, 'w')['u'].gen())
show("RR[t] / QuadraticField(2)[u]", lambda: t / QuadraticField(2, 'w')['u'].gen())
