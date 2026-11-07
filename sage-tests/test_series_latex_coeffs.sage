# latex() of power and Laurent series whose coefficients are not plain numbers, as Sage 10.9 typesets them: the
# coefficient's own latex (\\frac{1}{3}, a^{2}, w + 1, a p-adic number); a sum or difference in
# \\left(...\\right) before a monomial; an exact unit left out; a negative power as \\frac{c}{z^{k}}; no space
# before the monomial in a Laurent series. (Not here: RR, RDF and CC, whose series keep zero coefficients
# in Sage, and CC scalars times a series, which are separate.)
R.<a> = QQ[]
K.<w> = CyclotomicField(3)
cases = [(R, [a + 1, -a, a - 1, 2*a, a^2, -a - 1, R(-1), R(1), R(-2/3), a/3 + 1]),
         (K, [w + 1, -w, 2*w, K(-1), w/2]),
         (GF(4, 'u'), [GF(4, 'u').gen(), GF(4, 'u').gen() + 1]),
         (Qp(5, 3), [Qp(5, 3)(1), Qp(5, 3)(-1), Qp(5, 3)(5), Qp(5, 3)(1/5)])]
for B, cs in cases:
    P = PowerSeriesRing(B, 'y'); y = P.gen()
    L = LaurentSeriesRing(B, 'z'); z = L.gen()
    for c in cs:
        for f in [c*y + O(y^3), c + y + O(y^2), c*y^2, c*z^-1 + O(z), c*z^-2 + c + c*z + O(z^2), c*z + z^3]:
            try:
                print(B, '|', repr(c), '|', f, '|', latex(f))
            except Exception as e:
                print(B, '|', repr(c), '| ERR', type(e).__name__)
