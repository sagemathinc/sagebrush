# A series divided by an inexact number, and CDF's own division, as Sage 10.9 (the grader's r766): a series
# divides by multiplying with the inverse, and CDF divides as GSL does (1/CDF(49) is 0.020408163265306117, so
# (49 + 49*x)/CDF(49) is 0.9999999999999998 + ...); RDF and RR at full precision; CC divided by a series.
# Not here: CDF's integer powers (CDF(49)^-1, CDF(49)^2), whose rule is separate.
R.<x> = PowerSeriesRing(QQ)
L.<t> = LaurentSeriesRing(QQ)
for c in [CDF(49), RDF(49), RR(49), CDF(10), RDF(10), CDF(3), CDF(1,2), CDF(3,4), CDF(0.1,0.3)]:
    print(c, '|', (49 + 49*x + O(x^3))/c, '|', (3 + 7*x + O(x^3))/c, '|', (49*t^-1 + 2 + O(t^2))/c)
for t2 in [CC(1,2)/(1 + x + O(x^3)), CC(1,2)/(t^-1 + 2 + O(t^2)), CDF(1,2)/(1 + x + O(x^3)), RDF(3)/(1 + x + O(x^3))]:
    print(t2, '|', t2.parent())
for z in [CDF(49), CDF(3), CDF(10), CDF(1,2), CDF(3,4), CDF(0,7), CDF(-2,5), CDF(1e-300, 1), CDF(1e300, 1e300), CDF(0.1, 0.3)]:
    print(z, '|', CDF(1)/z, '|', ~z, '|', CDF(7, 1)/z, '|', 49/z, '|', z*(1/z), '|', z/2, '|', 2/z)
# boundaries, with each part's bits (daybreak3's review of #766): ~z is GSL's inverse, 1/z and a/z GSL's
# division, both with s = 1/|z| infinite for z = 0, so a division by 0 is NaN + NaN*I and ~CDF(infinity, 1) is NaN
# with imaginary part -0.0. Not here: CDF(-0.0, 0)'s print (Sage's 0.0) and a series divided by CDF(0) or
# CDF(infinity, 1) (Sage drops the NaN coefficients: O(x^3)).
inf = float('inf'); nan = float('nan')
def parts(w):
    return '%s %s' % (float(w.real()).hex(), float(w.imag()).hex())
def op(f):
    try:
        w = f()
        return '%s [%s]' % (w, parts(w))
    except Exception as e:
        return 'ERR ' + type(e).__name__
for z in [CDF(inf, 1), CDF(1, inf), CDF(0), CDF(0, -0.0), CDF(1e-310), CDF(1e-310, 1e-310), CDF(5e-324), CDF(inf, inf), CDF(nan, 1), CDF(1e308, 1e308), CDF(-inf, 0), CDF(3, 4)]:
    print(z, '| ~z', op(lambda: ~z), '| 1/z', op(lambda: 1/z), '| CDF(1)/z', op(lambda: CDF(1)/z), '| CDF(7,1)/z', op(lambda: CDF(7, 1)/z), '| z/2', op(lambda: z/2), '| z/CDF(0)', op(lambda: z/CDF(0)))
for f in [lambda: CDF(1, 2)/(1 + x + O(x^3))]:
    try:
        w = f()
        print(w, '|', w.parent())
    except Exception as e:
        print('ERR', type(e).__name__)
