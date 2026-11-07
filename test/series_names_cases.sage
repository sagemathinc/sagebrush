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
show(lambda: LaurentSeriesRing(QQ, 0, 'x'))
# (the multivariate power series rings Sage makes from names by keyword or a count after a count, SERIES-NAME-WORK-4,
# and a count of 0 given by names=, L39)
show(lambda: PowerSeriesRing(QQ, 0, '1'))
show(lambda: PowerSeriesRing(QQ, 2, 'x', names=-1))
show(lambda: PowerSeriesRing(QQ, 2, 'x', names=0))
show(lambda: PowerSeriesRing(QQ, 2, names=['x', 'y', 'z']))
show(lambda: PowerSeriesRing(QQ, 2, 2, names='x,y'))
show(lambda: PowerSeriesRing(QQ, 'x,y', -1))
show(lambda: LaurentSeriesRing(QQ, 2, 'x', names=0))
import _sage_series
print(sorted(k[2] for k in _sage_series._RINGS if k[0] == "P"))
# A huge count makes no list of names (SERIES-NAME-WORK-3): with the materializer and range() made to fail, the
# Laurent series ring is in the first generated name and the power series ring is refused, at once.
import _sage_mpoly, builtins
def _no_list(*a, **k):
    raise AssertionError("names materialized")
_sage_mpoly._normalize_names = _no_list
_range = builtins.range
builtins.range = lambda *a: _no_list() if a and abs(a[-1]) > 10^6 else _range(*a)
show(lambda: LaurentSeriesRing(QQ, 10^15, 'x'))
show(lambda: PowerSeriesRing(QQ, 10^15, 'x'))
show(lambda: PowerSeriesRing(QQ, 10^15, 'a{b'))
show(lambda: LaurentSeriesRing(QQ, 10^15, 'x,y'))
builtins.range = _range
