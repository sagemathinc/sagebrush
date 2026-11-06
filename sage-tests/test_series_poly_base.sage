# Power and Laurent series over a polynomial base ring (QQ['a'], QQ['b'], ZZ['a'], GF(5)['a'], QQ['a,b']) and
# over number fields and GF(q): a base element is a constant, never the series variable (a*x is a*x, not x^2),
# a quotient by a non-unit of the base lands in its fraction field, and a Laurent series lists from its
# valuation. One line per case: the value, its list(), its parent (or the error's type).
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
for kind in ['Power', 'Laurent']:
    for bname in ["QQ['a']", "QQ['b']", "ZZ['a']", "GF(5)['a']", "QQ['a,b']"]:
        B = sage_eval(bname)
        g = B.gens()
        a = g[0]
        S = (PowerSeriesRing if kind == 'Power' else LaurentSeriesRing)(B, 'x', default_prec=6)
        x = S.gen()
        tag = kind + ' ' + bname
        show(tag + ' a*x', lambda: a*x)
        show(tag + ' x*a', lambda: x*a)
        show(tag + ' (a+1)*x', lambda: (a + 1)*x)
        show(tag + ' a+x', lambda: a + x)
        show(tag + ' x-a', lambda: x - a)
        show(tag + ' a^2*x^2+a', lambda: a^2*x^2 + a)
        show(tag + ' S(a)', lambda: S(a))
        show(tag + ' S(a+1)', lambda: S(a + 1))
        show(tag + ' S([a,1])', lambda: S([a, 1]))
        show(tag + ' S(QQ[x] poly)', lambda: S(QQ['x']([1, 2, 3])))
        show(tag + ' (a+1)*x+a*x^2', lambda: (a + 1)*x + a*x^2)
        show(tag + ' +O', lambda: (a + 1)*x + a*x^2 + O(x^3))
        show(tag + ' a+O(x)', lambda: a + O(x))
        if len(g) > 1:
            show(tag + ' (a*b+1)*x', lambda: (g[0]*g[1] + 1)*x)
        for name, f in [('x/(a+1)', lambda: x/(a+1)), ('x/2', lambda: x/2), ('x/a', lambda: x/a), ('(a*x)/a', lambda: (a*x)/a),
                        ('1/(1+x)', lambda: 1/(1+x)), ('1/(1+a*x)', lambda: 1/(1+a*x)), ('1/(a+x)', lambda: 1/(a+x)), ('x/(a*x)', lambda: x/(a*x)),
                        ('(a*x+a^2*x^2)/a', lambda: (a*x+a^2*x^2)/a), ('1/(2+x)', lambda: 1/(2+x)), ('x^2/(a*x)', lambda: x^2/(a*x)),
                        ('(1+x)/(1-a*x)', lambda: (1+x)/(1-a*x)), ('~(1+a*x)', lambda: ~(1+a*x)), ('(a+1)*x/(a+1)', lambda: (a+1)*x/(a+1))]:
            show(tag + ' ' + name, f)
P.<t> = QQ[]
K.<c> = NumberField(t^2 + 1)
F.<z> = GF(4)
G.<w> = GF(25)
for name, B, h in [('NF', K, c), ('GF4', F, z), ('GF25', G, w), ('CyclotomicField(3)', CyclotomicField(3), CyclotomicField(3).gen())]:
    for kind in ['Power', 'Laurent']:
        S = (PowerSeriesRing if kind == 'Power' else LaurentSeriesRing)(B, 'x', default_prec=5)
        x = S.gen()
        show(kind + ' ' + name + ' h*x', lambda: h*x)
        show(kind + ' ' + name + ' h+x', lambda: h + x)
        show(kind + ' ' + name + ' S(h)', lambda: S(h))
        show(kind + ' ' + name + ' (h+1)*x^2+h', lambda: (h + 1)*x^2 + h)
        show(kind + ' ' + name + ' x/h', lambda: x/h)
L.<x> = LaurentSeriesRing(QQ)
for f in [x, 3*x^2 + x^5, x^-2 + 1, 1 + x, x + O(x^4), L(0), x^-3*(1 + x)]:
    print(f, '|', f.list(), '|', f.valuation())
