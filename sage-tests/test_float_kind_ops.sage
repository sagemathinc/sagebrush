# Float kinds in symbolic expressions, grader's r776 rows (Sage 10.10): a float base's power (0.0^3, (-2.0)^3, a
# complex zero), abs and conjugate keep the parent (abs of a complex is real), atan2(y, x) takes x's parent in one
# domain and the complex one across domains, and is an exact angle on an axis or a diagonal; 0 to a negative power is
# Sage's ValueError; RDF/CDF constants are numeric; -0.0 hashes as 0.0; names (also non-ASCII) do not upset the
# float normalization of the hash
def show(label, f):
    try:
        v = f()
        p = ''
        try:
            p = v.pyobject().parent()
        except Exception:
            pass
        print(label, '|', v, '|', p)
    except Exception as e:
        print(label, '| ERR', type(e).__name__, repr(str(e)[:120]))
x = var('x')
D, R, C, K = RDF, RR, CDF, CC
for n, f in [('SR(RDF(0))^3', lambda: SR(D(0))^3), ('SR(RR(0))^3', lambda: SR(R(0))^3), ('SR(RDF(0))^0', lambda: SR(D(0))^0), ('SR(RDF(0))^x', lambda: SR(D(0))^x), ('SR(RDF(-2))^3', lambda: SR(D(-2))^3),
             ('SR(RR(-2))^3', lambda: SR(R(-2))^3), ('SR(RDF(-2))^2', lambda: SR(D(-2))^2), ('SR(RDF(-2))^5', lambda: SR(D(-2))^5), ('SR(RDF(-2))^SR(RDF(3))', lambda: SR(D(-2))^SR(D(3))), ('SR(CDF(0))^2', lambda: SR(C(0))^2),
             ('SR(CC(0))^2', lambda: SR(K(0))^2), ('SR(CDF(0))^RDF(2)', lambda: SR(C(0))^SR(D(2))), ('SR(RDF(0))^RDF(2)', lambda: SR(D(0))^SR(D(2))), ('SR(0)^-1', lambda: SR(0)^-1), ('SR(RR(0))^-1', lambda: SR(R(0))^-1),
             ('SR(RDF(0))^-2', lambda: SR(D(0))^-2), ('SR(CDF(0))^-1', lambda: SR(C(0))^-1), ('SR(RDF(0))^RDF(-1)', lambda: SR(D(0))^SR(D(-1))), ('SR(RDF(0))^(-1/2)', lambda: SR(D(0))^(-1/2)), ('1/SR(RDF(0))', lambda: 1/SR(D(0))),
             ('1/SR(0)', lambda: 1/SR(0)), ('x/0', lambda: x/0), ('abs(SR(RDF(-2)))', lambda: abs(SR(D(-2)))), ('abs(SR(CDF(3,4)))', lambda: abs(SR(C(3, 4)))), ('abs(SR(RR(-2)))', lambda: abs(SR(R(-2)))), ('abs(SR(CC(3,4)))', lambda: abs(SR(K(3, 4)))),
             ('conjugate(SR(RDF(2)))', lambda: conjugate(SR(D(2)))), ('conjugate(SR(CDF(1,2)))', lambda: conjugate(SR(C(1, 2)))), ('conjugate(SR(RR(2)))', lambda: conjugate(SR(R(2)))), ('conjugate(SR(CC(1,2)))', lambda: conjugate(SR(K(1, 2)))),
             ('atan2(D1,D1)', lambda: atan2(SR(D(1)), SR(D(1)))), ('atan2(R1,R1)', lambda: atan2(SR(R(1)), SR(R(1)))), ('atan2(D1,D0)', lambda: atan2(SR(D(1)), SR(D(0)))), ('atan2(D0,D1)', lambda: atan2(SR(D(0)), SR(D(1)))),
             ('atan2(D-1,D-1)', lambda: atan2(SR(D(-1)), SR(D(-1)))), ('atan2(D2,D2)', lambda: atan2(SR(D(2)), SR(D(2)))), ('atan2(D1,D-1)', lambda: atan2(SR(D(1)), SR(D(-1)))), ('atan2(D0,D-1)', lambda: atan2(SR(D(0)), SR(D(-1)))),
             ('atan2(D0,D0)', lambda: atan2(SR(D(0)), SR(D(0)))), ('atan2(D1.5,D1.5)', lambda: atan2(SR(D(1.5)), SR(D(1.5)))), ('atan2(1,D1)', lambda: atan2(SR(1), SR(D(1)))), ('atan2(D1,1)', lambda: atan2(SR(D(1)), SR(1))),
             ('atan2(D1,R2)', lambda: atan2(SR(D(1)), SR(R(2)))), ('atan2(R1,D2)', lambda: atan2(SR(R(1)), SR(D(2)))), ('atan2(D1,D2)', lambda: atan2(SR(D(1)), SR(D(2)))), ('atan2(D1,C2)', lambda: atan2(SR(D(1)), SR(C(2)))),
             ('atan2(C1,D2)', lambda: atan2(SR(C(1)), SR(D(2)))), ('atan2(R1,K2)', lambda: atan2(SR(R(1)), SR(K(2)))), ('atan2(K1,R2)', lambda: atan2(SR(K(1)), SR(R(2)))), ('atan2(D1,2)', lambda: atan2(SR(D(1)), 2)),
             ('atan2(1,D2)', lambda: atan2(1, SR(D(2)))), ('SR(RDF(2)).is_numeric()', lambda: SR(D(2)).is_numeric()), ('SR(CDF(1,2)).is_numeric()', lambda: SR(C(1, 2)).is_numeric()), ('SR(RDF(2)).is_constant()', lambda: SR(D(2)).is_constant()),
             ('(x + SR(RDF(2))).is_numeric()', lambda: (x + SR(D(2))).is_numeric()), ('hash -0.0 vs 0.0', lambda: hash(SR(-0.0)) == hash(SR(0.0))), ('hash RDF -0 vs 0', lambda: hash(SR(D(-0.0))) == hash(SR(D(0.0)))),
             ('hash df', lambda: hash(var('df') + SR(R(1.5))) == hash(var('df') + SR(D(1.5)))), ('hash f1', lambda: hash(var('f1')*SR(R(2.5))) == hash(var('f1')*SR(D(2.5)))),
             ('hash h', lambda: hash(sin(var('h') + SR(K(1.5)))) == hash(sin(var('h') + SR(D(1.5))))), ('hash x RDF', lambda: hash(x + SR(D(1.5))) == hash(SR(D(1.5)) + x))]:
    show(n, f)
for nm in ['α', 'αβ', '变']:
    a = var(nm)
    show('hash ' + repr(nm), lambda: (hash(a + SR(R(1.5))) == hash(a + SR(D(1.5))), hash(2*a + SR(D(1.5))) == hash(SR(D(1.5)) + a*2), hash(var(nm)*sin(SR(R(0.5)))) == hash(var(nm)*sin(SR(D(0.5))))))
