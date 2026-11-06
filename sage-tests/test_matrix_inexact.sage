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
