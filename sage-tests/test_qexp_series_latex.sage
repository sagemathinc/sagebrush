# Newform.q_expansion is a power series over QQ (so latex() and \sage{} typeset it), and latex() of a power series
# writes its coefficients as Sage does: \frac{a}{b}, a coefficient 1 or -1 left out ("1 +  x"), "0 + \cdots" for a
# series with no nonzero term to its precision.  (sim run 11, X01; Laurent series are not covered here.)
f = Newforms(11, names='a')[0]
s = f.q_expansion(8)
print(s)
print(s.parent())
print(s.prec(), s.list(), s[2], s.valuation())
print(latex(s))
print(latex(f.q_expansion()))
print(latex(f.q_expansion(2)))
print(latex(f.q_expansion(1)))
for g in Newforms(37, names='a'):
    print(latex(g.q_expansion(7)))
for N in (14, 17):
    print(latex(Newforms(N, names='a')[0].q_expansion(9)))
print(latex(Newforms(1, 12, names='a')[0].q_expansion(5)))
print(s + 1, (s * s).prec())
R.<x> = PowerSeriesRing(QQ)
for e in [1 + x + x^2/2 + O(x^4), -x/3 + 5*x^3/7 + O(x^5), 2 - x + O(x^3), -1/2 + O(x^2), O(x^3), 1 - x^2 + O(x^4),
          1 - x/3 + O(x^3), 2/3*x + O(x^2), -x + O(x^2), x, R(0), 1 + x^10 + O(x^12), O(x^0), O(x), 3 + O(x^1),
          -x^3 + x^5, R(1)]:
    print(latex(e))
S.<t> = PowerSeriesRing(GF(7))
print(latex(3 + 6*t + t^2 + O(t^4)))
print(latex(-t + O(t^3)))
P.<u> = PowerSeriesRing(ZZ)
print(latex(-1 - u + O(u^2)))
print(latex(1 + 2*u^2))
print(latex(1 - 24*u + 252*u^2 + O(u^3)))
print(latex(-u + O(u^2)))
# prec as Sage converts it (Integer(prec)): Booleans, strings and integral reals pass; a negative one is refused
for p in [-1, True, False, 2.0, 2.5, 1/2, "3", int(4)]:
    try:
        t = f.q_expansion(p)
        print(repr(p), t, t.prec())
    except Exception as e:
        print(repr(p), type(e).__name__, e)
