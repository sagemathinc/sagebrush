# n() of a symbolic number of ComplexField(p), and ComplexField arithmetic
# with a real of a directed-rounding RealField.  CC's numbers are doubles in
# sagebrush: n(), n(53) and N() of a value past them are refused (doctests
# in lib/_sage_expr.py), so those rows are not here; the other precisions
# keep such a value.
def show(label, f):
    try:
        v = f(); print(label, "|", v, "|", v.parent())
    except Exception as e:
        print(label, "|", type(e).__name__)
C = ComplexField(100)
# within the doubles: every way in (a zero imaginary part leaves a real)
for name, z in [("C(1/3, 2)", C(1/3, 2)), ("C(1, 0)", C(1, 0)), ("C(-2, 0)", C(-2, 0)), ("C(0, 1)", C(0, 1)),
                ("C(2^-1000, 1)", C(2^-1000, 1)), ("C(1, -2^1000)", C(1, -2^1000))]:
    s = SR(z)
    show("n %s" % name, lambda: s.n())
    show("n(53) %s" % name, lambda: s.n(53))
    show("N %s" % name, lambda: N(s))
    show("n(100) %s" % name, lambda: s.n(100))
    show("digits=5 %s" % name, lambda: s.n(digits=5))
    show("digits=16 %s" % name, lambda: s.n(digits=16))
    show("N digits=15 %s" % name, lambda: N(s, digits=15))
    show("n 2*pi*z %s" % name, lambda: (2*pi*s).n())
# functions of such a number, within the doubles
for name, z in [("C(1/3, 2)", SR(C(1/3, 2))), ("C(2^-1000, 1)", SR(C(2^-1000, 1)))]:
    for fn, f in [("polylog", lambda: z * polylog(2, 1/2)), ("dilog", lambda: z * dilog(1/2)), ("psi", lambda: z * psi(2)),
                  ("log_gamma", lambda: z * log_gamma(3/2)), ("arctan2", lambda: z * arctan2(1, 2)), ("sinh", lambda: sinh(z)),
                  ("sqrt", lambda: sqrt(z)), ("z^z", lambda: z^z), ("binomial", lambda: z * binomial(1/2, 3)),
                  ("sign", lambda: z * sign(-2)), ("csc", lambda: csc(z)), ("lambert_w", lambda: z * lambert_w(1))]:
        show("n %s %s" % (fn, name), lambda: f().n())
# a part past the doubles: kept at any precision but CC's
for name, z in [("C(2^-1100, 1)", C(2^-1100, 1)), ("C(1, 2^-1100)", C(1, 2^-1100)),
                ("C(2^1100, 1)", C(2^1100, 1)), ("C(1, -2^1100)", C(1, -2^1100)), ("C(2^-1100, 2^-1100)", C(2^-1100, 2^-1100))]:
    s = SR(z)
    show("n(100) %s" % name, lambda: s.n(100))
    show("digits=5 %s" % name, lambda: s.n(digits=5))
    show("digits=16 %s" % name, lambda: s.n(digits=16))
    show("N digits=15 %s" % name, lambda: N(s, digits=15))
    show("n(100) 2*pi*z %s" % name, lambda: (2*pi*s).n(100))
# a real of RealField(q, rnd) meets ComplexField(p) in ComplexField(min(p, q)),
# rounded to nearest there whatever q's rounding
for rnd in ['RNDU', 'RNDD', 'RNDZ', 'RNDN']:
    for (cp, rp) in [(2, 2), (2, 4), (4, 2), (100, 20), (100, 100), (20, 100)]:
        F = ComplexField(cp); R = RealField(rp, rnd=rnd)
        show("C%d(1)/R%d%s(3)" % (cp, rp, rnd), lambda: F(1) / R(3))
        show("R%d%s(3)/C%d(1)" % (rp, rnd, cp), lambda: R(3) / F(1))
        show("C%d(1)+R%d%s(1/3)" % (cp, rp, rnd), lambda: F(1) + R(1/3))
        show("C%d(1,1)*R%d%s(1/3)" % (cp, rp, rnd), lambda: F(1, 1) * R(1/3))
        show("C%d(1)-R%d%s(1/3)" % (cp, rp, rnd), lambda: F(1) - R(1/3))
