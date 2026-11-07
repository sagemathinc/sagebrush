# Zmod(n), finite fields and number fields compared with an inexact number of EQUAL value (L34; grader's r823
# eq survivors): Sage 10.10 has no common parent, so == is False and != True in both orders, for an element and a
# constant polynomial alike.
def show(label, f):
    try:
        print(label, "->", f())
    except Exception as e:
        print(label, "->", "%s: %s" % (type(e).__name__, e))
Bs = [GF(2), GF(7), Zmod(6), Zmod(46341), Zmod(46342), GF(2^31 - 1), Zmod(2^31), GF(2^64 - 59), GF(next_prime(2^64)), Zmod(2^64),
      GF(4, 'a'), GF(3^10, 'a'), GF(251^2, 'a'), GF(2^16, 'a'), GF(257^2, 'a'), GF(3^11, 'a'),
      NumberField(x^2 + 1, 'j'), NumberField(x^2 + 3, 'k'), NumberField(x^2 + 4, 'm'), NumberField(x^2 + x + 1, 'n'), NumberField(x^2 - 18, 'p'), NumberField(x^3 - 2, 'c')]
Ss = [RR(2), RDF(2), RealField(100)(2), CC(1, 1), CDF(2), ComplexField(100)(2), RR(2.5), float(2), complex(1, 1)]
# == with EQUAL values (grader's r823 eq survivors): Sage 10.10 is False even when the inexact number equals
# the element or the constant polynomial (no common parent), in both orders.
Es = [RR(2), RDF(2), RealField(100)(2), CC(2), CDF(2), ComplexField(100)(2), float(2), complex(2)]
for B in Bs:
    b = B(2)
    f = B['t'](2)
    for s in Es:
        L = "%s %r" % (B, s)
        show(L + " B(2) == s", lambda: b == s)
        show(L + " s == B(2)", lambda: s == b)
        show(L + " B(2) != s", lambda: b != s)
        show(L + " f2 == s", lambda: f == s)
        show(L + " s == f2", lambda: s == f)
