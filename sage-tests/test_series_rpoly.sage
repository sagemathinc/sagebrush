# A series over ZZ['a'] or QQ['a'] meeting an inexact number (RR, RDF, CC, CDF, RealField(100),
# ComplexField(100), a float literal): over the number's field's polynomial ring, as Sage 10.9 (1b stage 1)
def show(label, f):
    try:
        v = f()
        print(label, '|', str(v).replace('\n', ' ; '), '|', v.parent())
    except Exception as e:
        print(label, '| ERR', type(e).__name__)
scalars = [('CC(1,2)', lambda: CC(1, 2)), ('RR(1.5)', lambda: RR(1.5)), ('RDF(1.5)', lambda: RDF(1.5)), ('R100(1.5)', lambda: RealField(100)(1.5)), ('C100(1,2)', lambda: ComplexField(100)(1, 2)), ('1.5', lambda: 1.5)]
for kind in ['Power', 'Laurent']:
    for bname in ["QQ['a']", "ZZ['a']"]:
        B = sage_eval(bname)
        S = (PowerSeriesRing if kind == 'Power' else LaurentSeriesRing)(B, 'x', default_prec=3); t = S.gen()
        for sn, sf in scalars:
            c = sf()
            for op, f in [('c*t', lambda: c*t), ('t*c', lambda: t*c), ('c+t', lambda: c + t), ('t-c', lambda: t - c), ('(1+t)/c', lambda: (1 + t)/c)]:
                show('%s %s %s %s' % (kind, bname, sn, op), f)
