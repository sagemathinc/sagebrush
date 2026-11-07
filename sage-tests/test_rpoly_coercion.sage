# The parent of a polynomial over an inexact field meeting a number or another polynomial ring
# (RR, RDF, CC, CDF, RealField(100), ComplexField(100), RealField(30), ComplexField(30)), and the
# sweep's QQ[t] and ZZ[u] meeting inexact numbers, as Sage 10.9 (1b stage 1)
R100 = RealField(100); C100 = ComplexField(100); R30 = RealField(30); C30 = ComplexField(30)
F = [('RR', RR), ('RDF', RDF), ('CC', CC), ('CDF', CDF), ('R100', R100), ('C100', C100), ('R30', R30), ('C30', C30), ('QQ', QQ), ('ZZ', ZZ)]
def name(P):
    for n, B in F:
        if P is B:
            return n
    return repr(P)
def pn(v):
    try:
        return name(v.parent().base_ring())
    except Exception:
        return type(v).__name__
scal = [('RR', RR(1.5)), ('RDF', RDF(1.5)), ('CC', CC(1, 2)), ('CDF', CDF(1, 2)), ('R100', R100(1.5)), ('C100', C100(1, 2)),
        ('R30', R30(1.5)), ('C30', C30(1, 2)), ('float', 1.5), ('complex', complex(1, 2)), ('I', I), ('QQ', 1/3), ('ZZ', 2), ('int', int(2))]
for bn, B in F[:8]:
    t = PolynomialRing(B, 't').gen()
    row = []
    for sn, c in scal:
        r = []
        for op, f in [('*', lambda: t*c), ('r*', lambda: c*t), ('+', lambda: t + c), ('r+', lambda: c + t), ('/', lambda: t/c)]:
            try:
                r.append(pn(f()))
            except Exception as e:
                r.append('ERR:' + type(e).__name__)
        row.append(sn + '=' + ','.join(r))
    print(bn, '|', ' '.join(row))
for bn, B in F:
    t = PolynomialRing(B, 't').gen()
    row = []
    for cn, C in F:
        if bn in ('QQ', 'ZZ') and cn in ('QQ', 'ZZ'):
            continue
        s = PolynomialRing(C, 't').gen()
        r = []
        for op, f in [('+', lambda: t + s), ('*', lambda: t*s), ('r+', lambda: s + t)]:
            try:
                r.append(pn(f()))
            except Exception as e:
                r.append('ERR:' + type(e).__name__)
        row.append(cn + '=' + ','.join(r))
    print('poly', bn, '|', ' '.join(row))
# the sweep's 49: QQ[t] with each inexact scalar
P.<t> = QQ[]
for sn, c in scal[:9]:
    for op, f in [('c*o', lambda: c*(t + 1)), ('o*c', lambda: (t + 1)*c), ('c+o', lambda: c + (t + 1)), ('o+c', lambda: (t + 1) + c),
                  ('c-o', lambda: c - (t + 1)), ('o-c', lambda: (t + 1) - c), ('o/c', lambda: (t + 1)/c)]:
        try:
            v = f(); print('QQt', sn, op, '|', v, '|', v.parent())
        except Exception as e:
            print('QQt', sn, op, '| ERR', type(e).__name__)
Z.<u> = ZZ[]
for sn, c in scal[:9]:
    try:
        v = c*u + 1; print('ZZu', sn, '|', v, '|', v.parent())
    except Exception as e:
        print('ZZu', sn, '| ERR', type(e).__name__)
