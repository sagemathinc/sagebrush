# A series' coefficient at or past its precision is not known: f[n] is an IndexError there, not 0; and over QQ a
# coefficient is an element of QQ, as Sage (friction W38)
def show(label, f):
    try:
        v = f()
        print(label, '|', v, '|', v.parent() if hasattr(v, 'parent') else type(v).__name__)
    except Exception as e:
        print(label, '| ERR', type(e).__name__, repr(str(e)[:120]))
R = PowerSeriesRing(ZZ, 'Q', default_prec=5); Q = R.gen()
f = Q.add_bigoh(5)*(1 - Q)**24
g = 1 + 2*Q + O(Q^3)
S.<t> = PowerSeriesRing(QQ)
h = 1/(1 - t)
L.<z> = LaurentSeriesRing(QQ)
for n, F in [('f', lambda: f), ('f[5]', lambda: f[5]), ('f[4]', lambda: f[4]), ('f[-1]', lambda: f[-1]), ('f[0]', lambda: f[0]), ('g[2]', lambda: g[2]), ('g[3]', lambda: g[3]), ('g[10]', lambda: g[10]), ('g[-1]', lambda: g[-1]),
             ('h[19]', lambda: h[19]), ('h[20]', lambda: h[20]), ('h[25]', lambda: h[25]), ('(t^2)[5]', lambda: (t^2)[5]), ('S(1)[3]', lambda: S(1)[3]), ('g.list()', lambda: g.list()), ('g.padded_list(5)', lambda: g.padded_list(5)),
             ('g.coefficients()', lambda: g.coefficients()), ('Laurent [2]', lambda: (z^-1 + 1 + O(z^2))[2]), ('Laurent [-2]', lambda: (z^-1 + 1 + O(z^2))[-2]), ('Laurent [-1]', lambda: (z^-1 + 1 + O(z^2))[-1]),
             ('Laurent [1]', lambda: (z^-1 + 1 + O(z^2))[1]), ('(1/3 + t + O(t^2))[0]', lambda: (1/3 + t + O(t^2))[0]), ('(1/3 + t + O(t^2))[1]', lambda: (1/3 + t + O(t^2))[1]), ('exp', lambda: exp(t + O(t^4))),
             ('compose', lambda: (1 + t + O(t^3))(t^2)), ('substitute', lambda: (1 + t + t^2)(2))]:
    show(n, F)
