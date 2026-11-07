# Zmod(n), finite fields and number fields (their elements and polynomials) with an inexact number: RR, RDF,
# RealField(p), CC, CDF, ComplexField(p), a Python float or complex (L34; @sagebrush's ruling). Sage has no
# common parent and refuses, in both orders and for a value; == is False. Before, GF(7)['t'].gen() + 1 + RR(2)
# was t + 3, GF(2)['t'].gen() * 2.0 was 0 and GF(7)(1) + CC(2) was 3.00000000000000. One base of each class
# family Sage names for a Python float, at the boundaries: IntegerMod_int to 46341, IntegerMod_int64 to 2^31 - 1,
# IntegerMod_gmp; givaro below 2^16 elements, NTL's GF(2^k) and PARI's from there; Gaussian, square-root and other
# quadratic fields, higher degree; the polynomial classes of GF(2), flint below 2^64, NTL from 2^64, ZZ_pEX.
def show(label, f):
    try:
        print(label, "->", f())
    except Exception as e:
        print(label, "->", "%s: %s" % (type(e).__name__, e))
Bs = [GF(2), GF(7), Zmod(6), Zmod(46341), Zmod(46342), GF(2^31 - 1), Zmod(2^31), GF(2^64 - 59), GF(next_prime(2^64)), Zmod(2^64),
      GF(4, 'a'), GF(3^10, 'a'), GF(251^2, 'a'), GF(2^16, 'a'), GF(257^2, 'a'), GF(3^11, 'a'),
      NumberField(x^2 + 1, 'j'), NumberField(x^2 + 3, 'k'), NumberField(x^2 + 4, 'm'), NumberField(x^2 + x + 1, 'n'), NumberField(x^2 - 18, 'p'), NumberField(x^3 - 2, 'c')]
Ss = [RR(2), RDF(2), RealField(100)(2), CC(1, 1), CDF(2), ComplexField(100)(2), RR(2.5), float(2), complex(1, 1)]
for B in Bs:
    b = B(1) + B.gen() if B.degree() > 1 else B(3)
    f = B['t'].gen() + 1
    for s in Ss:
        L = "%s %r" % (B, s)
        show(L + " b + s", lambda: b + s)
        show(L + " s - b", lambda: s - b)
        show(L + " s * b", lambda: s * b)
        show(L + " b / s", lambda: b / s)
        show(L + " b == s", lambda: b == s)
        show(L + " f + s", lambda: f + s)
        show(L + " s + f", lambda: s + f)
        show(L + " f - s", lambda: f - s)
        show(L + " s * f", lambda: s * f)
        show(L + " f / s", lambda: f / s)
        show(L + " s / f", lambda: s / f)
        show(L + " f == s", lambda: f == s)
        show(L + " f(s)", lambda: f(s))
