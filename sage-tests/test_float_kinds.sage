# Symbolic floats keep their parent (1d-i), as Sage 10.9: RR and CC print 15 digits, RDF and CDF the
# shortest repr (1.5*x, (1e+20)*x, 0.3333333333333333); two parents meet as Sage meets them (in one domain the
# first's, RDF + RR is RDF and RR + RDF is RR; across domains the complex one's); equal bases and terms merge
# as the last one's ((x + RDF(1))*(x + RR(1)) is (x + 1.00000000000000)^2); RDF and CDF powers as Sage
# computes them. Not here: RealField(p) and ComplexField(p) (1d-ii), CC operands (#766), integrate's RR
# result, and 4 values that differ in their last bit from glibc's exp/log (L7).
var('x y')
vals = [('RDF', RDF(1.5)), ('RR', RR(2.5)), ('CDF', CDF(1,2)), ('ZZ', 2), ('QQ', 1/3)]
def kind(e):
    try:
        return str(e.pyobject().parent()).replace('Real Field with 53 bits of precision','RR').replace('Real Double Field','RDF').replace('Complex Double Field','CDF').replace('Complex Field with 53 bits of precision','CC').replace('Rational Field','QQ').replace('Integer Ring','ZZ')
    except Exception as ex:
        return 'ERR'
for an, a in vals:
    for bn, b in vals:
        if an in ('ZZ','QQ') and bn in ('ZZ','QQ'):
            continue
        s1 = SR(a) + SR(b); p1 = SR(a) * SR(b); c = (a*x + b*x).coefficient(x); k = x + a + b
        print(an, bn, '| add', s1, kind(s1), '| mul', p1, kind(p1), '| coef', c, kind(c), '| x+a+b', k, kind(k - x))
for t in [RDF(1.5), RDF(-2), RDF(3), RDF(1e20), RDF(1e-20), RDF(123456789.123), RDF(0.1), RDF(1)/3, RDF(2)^0.5, CDF(1,2), CDF(0,2), CDF(1,-2), CDF(-1,0.5), CDF(2,0), CDF(1e20, 1)]:
    print('print', t, '|', SR(t), '|', SR(t)*x, '|', x + SR(t), '|', x - SR(t), '|', x^SR(t), '|', latex(SR(t)*x), '|', latex(x + SR(t)))

def kind_of(e):
    try:
        return str(e.pyobject().parent()).replace('Real Field with 53 bits of precision','RR').replace('Real Double Field','RDF').replace('Complex Double Field','CDF').replace('Complex Field with 53 bits of precision','CC')
    except Exception:
        return '-'
for t in ['sin(SR(RDF(0.5)))', 'sqrt(SR(RDF(2)))', 'SR(RDF(2))^SR(RDF(0.5))', 'SR(RDF(2))^3', 'SR(RDF(-1))^0.5', 'log(SR(RDF(2)))', 'SR(RDF(2))^x', '(RDF(1.5)*x).subs(x=2)', '(RDF(1.5)*x).subs(x=RR(2))', '(RR(1.5)*x).subs(x=RDF(2))', '(RDF(1.5)*x + 1).subs(x=1/3)', '(sin(RDF(1)*x)).subs(x=1)', 'abs(SR(CDF(3,4)))', 'SR(CDF(1,2)).real_part()', 'SR(CDF(0,1))*SR(CDF(0,1))', 'SR(RDF(4)).sqrt()', 'SR(RDF(-4)).sqrt()', 'RDF(1.5)*x*y', 'RDF(1.5)*(x+1)', 'expand(RDF(1.5)*(x+1)^2)', 'RDF(2)*x^2 + RDF(3)*x + RDF(1)', '(RDF(2)*x).diff(x)', 'RDF(1.5)*x/RR(3)', 'RDF(-1.5)*x', 'x - RDF(1.5)*y', 'RDF(1.5)*sin(x) + RDF(2.5)*cos(x)', '1/(RDF(2)*x)', 'x/RDF(2)', '(x + RDF(1))^2', '(x + RDF(1))*(x + RDF(2))', 'expand((x + RDF(1))*(x + RDF(2)))', 'n(SR(RDF(1))/3)', 'SR(RDF(1.5)).n()', 'RDF(1.5)*x + RDF(1.5)*x', 'RDF(0.1)*x + RDF(0.2)*x', 'RR(0.1)*x + RR(0.2)*x', 'RDF(1e16)*x', 'RDF(1e15)*x', 'RDF(0.0001)*x', 'RDF(0.00001)*x', 'RDF(-1e20)*x', "RDF(float('inf'))*x", "RDF(float('nan'))*x", 'RR(1.5)*x + RDF(2.5)', 'RDF(1.5)*x + RR(2.5)', 'RDF(1.5)*x + 1/3', 'RDF(1.5)*x + sqrt(2)', 'RDF(1.5)*x + RDF(2.5)*y', 'CDF(1,2)*x + RR(1)', 'parent((RDF(1.5)*x).subs(x=2))', 'parent((RR(1.5)*x + RDF(2.5)).subs(x=0))', 'RDF(1.5)*x^2 + RDF(0.1)*x', 'sin(RDF(0.5)*x)', 'exp(RDF(1)*x)', '(RDF(1.5)*x).coefficient(x)', 'parent((RDF(1.5)*x).coefficient(x))', 'RDF(1)/3*x', 'RDF(2)*x == 2*x', 'latex(RDF(1.5)*x)', 'RDF(1e20)*x', 'RDF(1e-20)*x', 'RDF(1.5)*x + RDF(-1.5)*x', 'x*RDF(2)^(1/2)', 'x^RDF(1.5)', 'RDF(1.5)^x', 'RDF(1.5)*x + RR(2.5)*x', 'RR(1.5)*x + RDF(2.5)*x', 'CDF(1,2)*x + RDF(1)*x', 'RDF(1.5)*x + 2*x', 'RDF(1.5)*x + 1/3*x', 'RDF(1.5)*x*RR(2)', 'SR(RDF(1)) + SR(RR(1))', 'parent(SR(RDF(1)) + SR(RR(1)))', '(SR(RDF(1)) + SR(RR(1))).pyobject().parent()', '(RDF(1.5)*x + RR(2.5)*x).coefficient(x).pyobject().parent()', '(RDF(1.5)*x*RR(2)).coefficient(x).pyobject().parent()', '(RDF(1.5)*x + 2*x).coefficient(x).pyobject().parent()', '(x + RDF(1)) * (x + RR(1))', 'expand((x + RDF(1)) * (x + RR(1)))', '(x + RR(1)) * (x + RDF(1))', '(x + RDF(1))^2 * (x + RR(1))', '(x + RR(1))^2 * (x + RDF(1))', '(x + RDF(1)) * (x + RR(1)) * (x + RDF(1))', '(x + RDF(2)) * (x + RR(2))', '(x + RR(2)) * (x + RDF(2))', 'x^RDF(2) * x^RR(1)', '(y + RDF(1))*x*(y + RR(1))', 'sin(x + RDF(1)) * sin(x + RR(1))', 'sin(x + RR(1)) * sin(x + RDF(1))', 'sin(x + RR(1)) + sin(x + RDF(1))', 'sin(x + RDF(1)) + sin(x + RR(1))', 'RDF(1.5)*sin(x + RR(1)) + RR(2)*sin(x + RDF(1))', 'RR(1e20)*x', 'RR(1e-20)*x', 'RR(-1e20)*x', 'x + RR(1e20)', 'x^RR(1e20)', 'RR(1e20)^x', 'latex(RR(1e20)*x)', 'latex(RR(1e-20)*x)', 'latex(RDF(-1e20)*x)', 'latex(x^RDF(1e20))', 'RDF(-1.5)^x', 'CDF(1,2)^x', 'x^CDF(1,2)', 'RDF(2)^(x+1)', 'exp(SR(RDF(2)))', 'SR(RDF(2))^0.5', 'SR(RDF(2))^RDF(0.5)', 'SR(RDF(3))^2', 'sin(SR(RDF(1)))', 'SR(RDF(10))^RDF(0.3)']:
    try:
        v = sage_eval(t, locals=dict(x=x, y=y))
        print(t, '=>', v, '|', kind_of(v) if hasattr(v, 'pyobject') else '-')
    except Exception as e:
        print(t, '=> ERR', type(e).__name__)
