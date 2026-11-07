# A matrix or vector over QQ meeting an inexact number (RR, RDF, CC, CDF, RealField(100), ComplexField(100), a float
# literal), as Sage 10.9: it moves to the number's field (RR(1.5)*M is [1.50000000000000 3.00000000000000] ; ...
# over RR, never [3/2 3] over QQ; CC(1, 2)*v is over CC, not the Symbolic Ring), and a division multiplies by the
# inverse. These are the 96 matrix and vector cases of the sweep (/scratch/sage2-notes/ccbug) that Sagebrush
# answers as Sage; the 2 others are CDF's inverse (its last bits).
def show(label, f):
    try:
        v = f()
        try:
            p = v.parent()
        except Exception:
            p = type(v).__name__
        print(label, '|', str(v).replace('\n', ' ; '), '|', p)
    except Exception as e:
        print(label, '| ERR', type(e).__name__)
SC = {'CC(1,2)': lambda: CC(1, 2), 'RR(1.5)': lambda: RR(1.5), 'RDF(1.5)': lambda: RDF(1.5), 'CDF(1,2)': lambda: CDF(1, 2),
      'R100(1.5)': lambda: RealField(100)(1.5), 'C100(1,2)': lambda: ComplexField(100)(1, 2), '1.5': lambda: 1.5}
OB = {'M': lambda: matrix(QQ, [[1, 2], [3, 4]]), 'v': lambda: vector(QQ, [1, 2])}
OP = {'c*o': 'c*o', 'o*c': 'o*c', 'c+o': 'c + o', 'o+c': 'o + c', 'c-o': 'c - o', 'o-c': 'o - c', 'o/c': 'o/c'}
C = [('CC(1,2)', 'M', 'c*o'), ('CC(1,2)', 'M', 'o*c'), ('CC(1,2)', 'M', 'c+o'), ('CC(1,2)', 'M', 'o+c'), ('CC(1,2)', 'M', 'c-o'), ('CC(1,2)', 'M', 'o-c'), ('CC(1,2)', 'M', 'o/c'), ('CC(1,2)', 'v', 'c*o'), ('CC(1,2)', 'v', 'o*c'), ('CC(1,2)', 'v', 'c+o'), ('CC(1,2)', 'v', 'o+c'), ('CC(1,2)', 'v', 'c-o'), ('CC(1,2)', 'v', 'o-c'), ('CC(1,2)', 'v', 'o/c'), ('RR(1.5)', 'M', 'c*o'), ('RR(1.5)', 'M', 'o*c'), ('RR(1.5)', 'M', 'c+o'), ('RR(1.5)', 'M', 'o+c'), ('RR(1.5)', 'M', 'c-o'), ('RR(1.5)', 'M', 'o-c'), ('RR(1.5)', 'M', 'o/c'), ('RR(1.5)', 'v', 'c*o'), ('RR(1.5)', 'v', 'o*c'), ('RR(1.5)', 'v', 'c+o'), ('RR(1.5)', 'v', 'o+c'), ('RR(1.5)', 'v', 'c-o'), ('RR(1.5)', 'v', 'o-c'), ('RR(1.5)', 'v', 'o/c'), ('RDF(1.5)', 'M', 'c*o'), ('RDF(1.5)', 'M', 'o*c'), ('RDF(1.5)', 'M', 'c+o'), ('RDF(1.5)', 'M', 'o+c'), ('RDF(1.5)', 'M', 'c-o'), ('RDF(1.5)', 'M', 'o-c'), ('RDF(1.5)', 'M', 'o/c'), ('RDF(1.5)', 'v', 'c*o'), ('RDF(1.5)', 'v', 'o*c'), ('RDF(1.5)', 'v', 'c+o'), ('RDF(1.5)', 'v', 'o+c'), ('RDF(1.5)', 'v', 'c-o'), ('RDF(1.5)', 'v', 'o-c'), ('RDF(1.5)', 'v', 'o/c'), ('CDF(1,2)', 'M', 'c*o'), ('CDF(1,2)', 'M', 'o*c'), ('CDF(1,2)', 'M', 'c+o'), ('CDF(1,2)', 'M', 'o+c'), ('CDF(1,2)', 'M', 'c-o'), ('CDF(1,2)', 'M', 'o-c'), ('CDF(1,2)', 'v', 'c*o'), ('CDF(1,2)', 'v', 'o*c'), ('CDF(1,2)', 'v', 'c+o'), ('CDF(1,2)', 'v', 'o+c'), ('CDF(1,2)', 'v', 'c-o'), ('CDF(1,2)', 'v', 'o-c'), ('R100(1.5)', 'M', 'c*o'), ('R100(1.5)', 'M', 'o*c'), ('R100(1.5)', 'M', 'c+o'), ('R100(1.5)', 'M', 'o+c'), ('R100(1.5)', 'M', 'c-o'), ('R100(1.5)', 'M', 'o-c'), ('R100(1.5)', 'M', 'o/c'), ('R100(1.5)', 'v', 'c*o'), ('R100(1.5)', 'v', 'o*c'), ('R100(1.5)', 'v', 'c+o'), ('R100(1.5)', 'v', 'o+c'), ('R100(1.5)', 'v', 'c-o'), ('R100(1.5)', 'v', 'o-c'), ('R100(1.5)', 'v', 'o/c'), ('C100(1,2)', 'M', 'c*o'), ('C100(1,2)', 'M', 'o*c'), ('C100(1,2)', 'M', 'c+o'), ('C100(1,2)', 'M', 'o+c'), ('C100(1,2)', 'M', 'c-o'), ('C100(1,2)', 'M', 'o-c'), ('C100(1,2)', 'M', 'o/c'), ('C100(1,2)', 'v', 'c*o'), ('C100(1,2)', 'v', 'o*c'), ('C100(1,2)', 'v', 'c+o'), ('C100(1,2)', 'v', 'o+c'), ('C100(1,2)', 'v', 'c-o'), ('C100(1,2)', 'v', 'o-c'), ('C100(1,2)', 'v', 'o/c'), ('1.5', 'M', 'c*o'), ('1.5', 'M', 'o*c'), ('1.5', 'M', 'c+o'), ('1.5', 'M', 'o+c'), ('1.5', 'M', 'c-o'), ('1.5', 'M', 'o-c'), ('1.5', 'M', 'o/c'), ('1.5', 'v', 'c*o'), ('1.5', 'v', 'o*c'), ('1.5', 'v', 'c+o'), ('1.5', 'v', 'o+c'), ('1.5', 'v', 'c-o'), ('1.5', 'v', 'o-c'), ('1.5', 'v', 'o/c')]
for sn, on, op in C:
    c, o = SC[sn](), OB[on]()
    show('%s %s %s' % (sn, on, op), lambda: sage_eval(OP[op], locals={'c': c, 'o': o}))
# a division multiplies by the inverse, at full precision (49*(1/49) is 0.9999999999999999 in binary64 where
# 49/49 is 1.0): a matrix or vector over RDF or CDF, or over QQ meeting one, divided by an inexact number
D = [('RDF M / RDF(49)', lambda: matrix(RDF, [[49, 49]])/RDF(49)), ('QQ M / RDF(49)', lambda: matrix(QQ, [[49, 98]])/RDF(49)),
     ('QQ v / RDF(49)', lambda: vector(QQ, [49, 98])/RDF(49)), ('CDF M / CDF(49)', lambda: matrix(CDF, [[49, 49]])/CDF(49)),
     ('QQ M / CDF(49)', lambda: matrix(QQ, [[49, 98]])/CDF(49)), ('RDF entry repr', lambda: repr((matrix(RDF, [[49]])/RDF(49))[0, 0])),
     ('RDF v / RDF(49)', lambda: vector(RDF, [49, 49])/RDF(49)), ('RDF v / 49', lambda: vector(RDF, [49, 49])/49),
     ('RDF v / RR(49)', lambda: vector(RDF, [49, 49])/RR(49)), ('RDF v / 1.5', lambda: vector(RDF, [3, 6])/1.5),
     ('RDF v / (1/7)', lambda: vector(RDF, [1, 2])/(1/7)), ('RDF v / RDF(0)', lambda: vector(RDF, [1, 2])/RDF(0)),
     ('RDF v / 0', lambda: vector(RDF, [1, 2])/0), ('CDF v / CDF(49)', lambda: vector(CDF, [49, 49])/CDF(49)),
     ('CDF v / 2', lambda: vector(CDF, [1, 2])/2), ('CDF v / CDF(0)', lambda: vector(CDF, [1, 2])/CDF(0)),
     ('GF5 v / GF5(3)', lambda: vector(GF(5), [1, 2])/GF(5)(3)), ('GF5 v / 2', lambda: vector(GF(5), [1, 2])/2),
     ('QQbar v / QQbar(2)', lambda: vector(QQbar, [1, 2])/QQbar(2))]
for n, f in D:
    show(n, f)
# a real vector meeting a complex number moves to the complex field, as Sage: CDF for two doubles, else ComplexField
# of the lower precision (a double counts as 53 bits); division is times the inverse there
R100, C100, C80, R80 = RealField(100), ComplexField(100), ComplexField(80), RealField(80)
P = [('RDF/CDF', lambda: vector(RDF, [2, 4])/CDF(2)), ('RDF/CDF(1,1)', lambda: vector(RDF, [2, 4])/CDF(1, 1)), ('RR/CC', lambda: vector(RR, [2, 4])/CC(2)), ('RR/CC(1,1)', lambda: vector(RR, [2, 4])/CC(1, 1)),
     ('R100/C100', lambda: vector(R100, [2, 4])/C100(2)), ('R100/C100(1,1)', lambda: vector(R100, [2, 4])/C100(1, 1)), ('R100/CC', lambda: vector(R100, [2, 4])/CC(2)), ('RR/C100', lambda: vector(RR, [2, 4])/C100(2)),
     ('R80/C100', lambda: vector(R80, [2, 4])/C100(2)), ('R100/C80', lambda: vector(R100, [2, 4])/C80(2)), ('RDF/CC', lambda: vector(RDF, [2, 4])/CC(2)), ('RR/CDF', lambda: vector(RR, [2, 4])/CDF(2)),
     ('R100/CDF', lambda: vector(R100, [2, 4])/CDF(2)), ('RDF/C100', lambda: vector(RDF, [2, 4])/C100(2)), ('RDF/CDF(49)', lambda: vector(RDF, [49, 49])/CDF(49)), ('RDF/CDF(0)', lambda: vector(RDF, [1, 2])/CDF(0)),
     ('RDF*CDF', lambda: vector(RDF, [2, 4])*CDF(1, 1)), ('CDF*RDF v', lambda: CDF(1, 1)*vector(RDF, [2, 4])), ('RR*CC', lambda: vector(RR, [2, 4])*CC(1, 1)), ('CC*RR v', lambda: CC(1, 1)*vector(RR, [2, 4])),
     ('R100*C80', lambda: vector(R100, [2, 4])*C80(1, 1)), ('QQ v/CDF', lambda: vector(QQ, [2, 4])/CDF(1, 1)), ('CDF/RDF', lambda: vector(CDF, [2, 4])/RDF(2)), ('CC/RR', lambda: vector(CC, [2, 4])/RR(2)),
     ('C100/R100', lambda: vector(C100, [2, 4])/R100(2))]
for n, f in P:
    show(n, f)
