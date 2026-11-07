# Zmod(n), finite fields and number fields with an inexact number, the operand orders test_ff_inexact leaves out
# (L34; grader's r823 survivors): s + b, b - s, b * s, s / b, s == b, and for a polynomial s - f, f * s, s == f,
# over the same bases and numbers. Sage 10.10 refuses each with the parents in operand order; == is False.
def show(label, f):
    try:
        print(label, "->", f())
    except Exception as e:
        print(label, "->", "%s: %s" % (type(e).__name__, e))
Bs = [GF(2), GF(7), Zmod(6), Zmod(46341), Zmod(46342), GF(2^31 - 1), Zmod(2^31), GF(2^64 - 59), GF(next_prime(2^64)), Zmod(2^64),
      GF(4, 'a'), GF(3^10, 'a'), GF(251^2, 'a'), GF(2^16, 'a'), GF(257^2, 'a'), GF(3^11, 'a'),
      NumberField(x^2 + 1, 'j'), NumberField(x^2 + 3, 'k'), NumberField(x^2 + 4, 'm'), NumberField(x^2 + x + 1, 'n'), NumberField(x^2 - 18, 'p'), NumberField(x^3 - 2, 'c')]
Ss = [RR(2), RDF(2), RealField(100)(2), CC(1, 1), CDF(2), ComplexField(100)(2), RR(2.5), float(2), complex(1, 1)]
# The other operand orders (grader's r823 survivors: radd, sub, mul, rsub, rdiv, eq reversed, and a real on the
# left, H-real): Sage names the parents in operand order, and a reflected operator is refused as b OP a.
for B in Bs:
    b = B(1) + B.gen() if B.degree() > 1 else B(3)
    f = B['t'].gen() + 1
    for s in Ss:
        L = "%s %r" % (B, s)
        show(L + " s + b", lambda: s + b)
        show(L + " b - s", lambda: b - s)
        show(L + " b * s", lambda: b * s)
        show(L + " s / b", lambda: s / b)
        show(L + " s == b", lambda: s == b)
        show(L + " s - f", lambda: s - f)
        show(L + " f * s", lambda: f * s)
        show(L + " s == f", lambda: s == f)
