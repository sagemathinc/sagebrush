# number fields in the series pushout, as Sage 10.9 (daybreak3's review of #760): QQ and ZZ coerce into a number field K, so
# a series over QQ['x'], ZZ['x'] or QQ['a'] meets K['x'], K['a'] and K in K['x'][[t]] (or K['a'][[t]]); GF(5)['x'] meets none (TypeError).
def show(label, f):
    try:
        v = f()
        try:
            l = v.list()
        except Exception as e:
            l = 'ERR %s' % type(e).__name__
        print(label, '|', v, '|', l, '|', v.parent())
    except Exception as e:
        print(label, '| ERR', type(e).__name__)
K = QuadraticField(2, 'r'); Z3 = CyclotomicField(3)
others = [("K[x].gen", lambda: K['x'].gen()), ("K.gen", lambda: K.gen()), ("K[a].gen", lambda: K['a'].gen()), ("Z3.gen", lambda: Z3.gen()), ("Z3[x].gen", lambda: Z3['x'].gen())]
for kind in ['Power', 'Laurent']:
    for bname in ["QQ['x']", "ZZ['x']", "QQ['a']", "GF(5)['x']"]:
        B = sage_eval(bname)
        S = (PowerSeriesRing if kind == 'Power' else LaurentSeriesRing)(B, 't', default_prec=3); t = S.gen()
        for oname, of in others:
            o = of()
            tag = '%s %s %s' % (kind, bname, oname)
            show(tag + ' o*t', lambda: o*t)
            show(tag + ' t*o', lambda: t*o)
            show(tag + ' o+t', lambda: o + t)
            show(tag + ' t+o', lambda: t + o)
            show(tag + ' t/o', lambda: t/o)
