# The series and p-adic rings Sage 10.10 makes multivariate, refused here before any ring is built or cached
# (test/series-names.test.ts; #776 RING-NAME-NORMALIZATION-2; L32 multivariate power series, L38 multivariate
# polynomials over p-adic rings): Sage gives Multivariate Power Series Ring in x, y over Rational Field, and so on.
def show(f):
    try:
        print(f())
    except Exception as e:
        print("%s: %s" % (type(e).__name__, e))
show(lambda: PowerSeriesRing(QQ, 'x,y'))
show(lambda: PowerSeriesRing(GF(7), ('x', 'y')))
show(lambda: PowerSeriesRing(ZZ, ['x', 'y']))
show(lambda: PowerSeriesRing(QQ, 2, 'x'))
show(lambda: PowerSeriesRing(QQ, 1, 'x'))
show(lambda: PowerSeriesRing(QQ, names=('x', 'y')))
show(lambda: QQ[['x,y']])
show(lambda: QQ[['x', 'y']])
show(lambda: Qp(5)['x,y'])
show(lambda: Zp(5)[('x', 'y')])
show(lambda: Zp(5)[['x,y']])
import _sage_series
print(sorted(k[2] for k in _sage_series._RINGS if k[0] == "P"))
