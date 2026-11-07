# How a polynomial over an inexact field prints (str and latex), per field, coefficient and degree:
# units, signs, parentheses, infinities, NaN, -0.0, as Sage 10.9 (1b stage 1)
R100 = RealField(100); C100 = ComplexField(100)
nan = float('nan'); inf = float('inf')
reals = [('1', 1), ('-1', -1), ('2', 2), ('-0.5', -0.5), ('1e20', 1e20), ('-1e20', -1e20), ('1e-20', 1e-20), ('-1e-20', -1e-20),
         ('inf', inf), ('-inf', -inf), ('nan', nan), ('1+2^-52', 1 + 2^-52), ('-0.0', -0.0), ('1e16', 1e16), ('123456.789', 123456.789)]
cplx = [('I', (0, 1)), ('-I', (0, -1)), ('2I', (0, 2)), ('1+I', (1, 1)), ('-1-I', (-1, -1)), ('-1+I', (-1, 1)), ('1-I', (1, -1)),
        ('1+0I', (1, 0)), ('-1+0I', (-1, 0)), ('1e-20I', (0, 1e-20)), ('1e20+1e20I', (1e20, 1e20)), ('nanI', (0, nan)), ('nan+0I', (nan, 0)),
        ('inf+0I', (inf, 0)), ('0+infI', (0, inf)), ('-0.5I', (0, -0.5)), ('0.5-0.5I', (0.5, -0.5))]
for bn, B in [('RR', RR), ('RDF', RDF), ('CC', CC), ('CDF', CDF), ('R100', R100), ('C100', C100)]:
    P = PolynomialRing(B, 't'); t = P.gen()
    vals = [(n, B(v)) for n, v in reals]
    if bn in ('CC', 'CDF', 'C100'):
        vals += [(n, B(*v)) for n, v in cplx]
    for n, c in vals:
        for d in (0, 1, 2):
            try:
                f = P([0]*d + [c]) + (t^3 if d == 0 else 0)
                g = P([0]*d + [c])
                print(bn, n, d, '|', g, '|', f, '|', latex(g), '|', g.degree(), '|', bool(g))
            except Exception as e:
                print(bn, n, d, '| ERR', type(e).__name__, str(e)[:60])
    # sums with a negative middle and leading -1
    for n, c in vals[:8]:
        try:
            print(bn, 'mid', n, '|', t^2 + c*t - 1, '|', -t^2 + c*t + c)
        except Exception as e:
            print(bn, 'mid', n, '| ERR', type(e).__name__)
    print(bn, 'bool nan', bool(B(nan)))
    print(bn, 'name t_1', PolynomialRing(B, 't_1').gen()^2 + 2, latex(PolynomialRing(B, 't_1').gen()^2 + 2))
    print(bn, 'name alpha', latex(PolynomialRing(B, 'alpha').gen()^2 + 1/3))
