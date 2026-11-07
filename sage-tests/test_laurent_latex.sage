# latex() of a Laurent series as Sage writes it: a negative power as \frac{c}{z^{k}} (the sign inside), no space
# between a coefficient and its monomial (2z), a unit coefficient left out, O(1), 0 + \cdots
L.<z> = LaurentSeriesRing(QQ)
for e in [z^-2 + 1/3 + z + O(z^3), z^-2 + 1 + O(z), z^-1/2 - 3 + 2*z + O(z^2), -z^-3 + O(z^0), 2*z^-1, -z^-1, 3*z^-2 - z^-1,
          -2/3*z^-4 + z^2, z + z^2, -z, 5*z^3 - 1/2*z^5 + O(z^7), L(0), O(z^-2), O(z^2), z^-5 + O(z^-3), 7 + O(z),
          -1/2 + z^-1, z^-10, 4*z^-1 - 4*z, z^2/3, -z^2/3 + O(z^4), 1 + O(z^0), z^-1 + O(z^0), -z^-1 + 2 - z]:
    print(repr(str(latex(e))))
M.<w> = LaurentSeriesRing(ZZ)
for e in [w^-1 - 2 + 3*w + O(w^2), -w^-2, 12*w^-3 + O(w)]:
    print(repr(str(latex(e))))
G.<t> = LaurentSeriesRing(GF(7))
for e in [3*t^-1 + 6 + t + O(t^3), -t^-2]:
    print(repr(str(latex(e))))
