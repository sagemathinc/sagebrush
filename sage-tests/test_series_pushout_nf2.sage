# a QQ, ZZ, GF(5) or QQ['y'] polynomial meeting a series over K['x'] in x, K a number field, as Sage 10.9 (daybreak3's second
# review of #760): QQ['x'] and ZZ['x'] coerce into K['x'] (constants: S(q) is the series x of valuation 0, q*t is x*x);
# GF(5)['x'] and QQ['y'] do not, so S(q) reads their coefficients (the series x, valuation 1) and arithmetic refuses.
def show(label, f):
    try:
        v = f()
        try:
            l = v.list()
        except Exception as e:
            l = 'ERR %s' % type(e).__name__
        try:
            val = v.valuation()
        except Exception as e:
            val = 'ERR %s' % type(e).__name__
        print(label, '|', v, '|', l, '|', val, '|', v.parent())
    except Exception as e:
        print(label, '| ERR', type(e).__name__)
for Kname in ["QuadraticField(2, 'r')", "CyclotomicField(3)"]:
    K = sage_eval(Kname)
    for kind in ['Power', 'Laurent']:
        S = (PowerSeriesRing if kind == 'Power' else LaurentSeriesRing)(K['x'], 'x', default_prec=3); t = S.gen()
        for qname, qf in [("QQ[x].gen", lambda: QQ['x'].gen()), ("ZZ[x].gen", lambda: ZZ['x'].gen()), ("QQ[x](x^2+1/2)", lambda: QQ['x'].gen()^2 + 1/2), ("GF5[x].gen", lambda: GF(5)['x'].gen()), ("QQ[y].gen", lambda: QQ['y'].gen())]:
            q = qf()
            tag = '%s %s %s' % (Kname, kind, qname)
            show(tag + ' S(q)', lambda: S(q))
            show(tag + ' q*t', lambda: q*t)
            show(tag + ' t*q', lambda: t*q)
            show(tag + ' q+t', lambda: q + t)
            show(tag + ' t+q', lambda: t + q)
            show(tag + ' t-q', lambda: t - q)
