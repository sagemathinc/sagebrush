# A polynomial over other coefficients divided by a series (o/s) is a series over the
# coefficients' pushout, as Sage 10.10; s/o is a RuntimeError (the grader's r760b V5).
def show(label, f):
    try:
        v = f()
        print(label, '|', v, '|', v.parent())
    except Exception as e:
        print(label, '| ERR', type(e).__name__)
K.<r2> = QuadraticField(2)
R.<t> = PowerSeriesRing(QQ['a'], default_prec=4)
b = K['a'].gen() + r2
s = 1 + t
show('b/s', lambda: b/s)
show('s/b', lambda: s/b)
show('b*s', lambda: b*s)
show('b/(1+t+t^2)', lambda: b/(1 + t + t^2))
show('b/(2+a*t)', lambda: b/(2 + R.base_ring().gen()*t))
show('b/(a+t)', lambda: b/(R.base_ring().gen() + t))
R2.<u> = PowerSeriesRing(ZZ['a'], default_prec=4)
c = QQ['a'].gen()/2 + 1
show('c/(1+u)', lambda: c/(1 + u))
show('(1+u)/c', lambda: (1 + u)/c)
L.<w> = LaurentSeriesRing(QQ['a'], default_prec=4)
show('b/(1+w)', lambda: b/(1 + w))
show('b/w', lambda: b/w)
show('(1+w)/b', lambda: (1 + w)/b)
