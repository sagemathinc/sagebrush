# Elliptic curves over QQ: plot(E) and base_extend / change_ring (Sage 10.9); one line per statement:
# S<nn> <value> or S<nn> ERR <type>: <msg>.  Sage's plot samples randomly (randomize=True), so a plot is
# checked through what doesn't depend on the samples: its primitives, each line's first and last x
# (rounded), and that every point lies on the curve.
def show(n, f):
    try:
        print('S%02d %s' % (n, str(f()).replace('\n', ' ; ')))
    except Exception as e:
        print('S%02d ERR %s: %s' % (n, type(e).__name__, str(e)[:160]))
def ends(G):
    out = []
    for p in G:
        xs = list(p.xdata)
        out.append((len(xs) > 10, round(float(xs[0]), 6), round(float(xs[-1]), 6)))
    return out
def on_curve(E, G):
    a1, a2, a3, a4, a6 = [float(a) for a in E.a_invariants()]
    worst = 0.0
    for p in G:
        for x, y in zip(p.xdata, p.ydata):
            x, y = float(x), float(y)
            r = y^2 + a1*x*y + a3*y - (x^3 + a2*x^2 + a4*x + a6)
            worst = max(worst, abs(r) / (1 + abs(x)^3))
    return worst < 1e-6
E1 = EllipticCurve([0, -1])
E37 = EllipticCurve('37a')
E11 = EllipticCurve('11a1')
E389 = EllipticCurve('389a1')
Ef = EllipticCurve([1, 0, 1, -19, 26])
show(1, lambda: plot(E1, rgbcolor=hue(0.7)))
show(2, lambda: plot(E37))
show(3, lambda: plot(E37, xmin=25, xmax=26))
show(4, lambda: E37.plot(components='bounded'))
show(5, lambda: E37.plot(components='unbounded'))
show(6, lambda: E11.plot(components='bounded'))
show(7, lambda: E37.plot(components='all'))
show(8, lambda: ends(plot(E1)))
show(9, lambda: ends(plot(E37)))
show(10, lambda: ends(E37.plot(components='bounded')))
show(11, lambda: ends(E37.plot(components='unbounded')))
show(12, lambda: ends(plot(E11)))
show(13, lambda: ends(plot(E389)))
show(14, lambda: ends(plot(Ef)))
show(15, lambda: ends(E37.plot(xmin=-2, xmax=3)))
show(16, lambda: ends(E37.plot(xmin=(-1, 0.5))))
show(17, lambda: ends(E37.plot(xmin=0, xmax=0.5)))
show(18, lambda: E37.plot(xmin=(1, 2), xmax=3))
show(19, lambda: E37.plot(xmin=(1, 2, 3)))
show(20, lambda: E37.plot(xmin=2, xmax=1))
show(21, lambda: all(on_curve(E, plot(E)) for E in (E1, E37, E11, E389, Ef)))
show(22, lambda: on_curve(Ef, Ef.plot(components='bounded')))
show(23, lambda: ends(plot(E37, plot_points=20, adaptive_recursion=0)))
show(24, lambda: [len(p.xdata) for p in plot(E1, plot_points=20, adaptive_recursion=0)])
show(25, lambda: plot(E37, color='red', thickness=2))
show(26, lambda: E37.base_extend(GF(7)))
show(27, lambda: E37.change_ring(GF(7)))
show(28, lambda: E37.base_extend(GF(7)).order())
show(29, lambda: E37.base_extend(GF(37)))
show(30, lambda: E11.base_extend(GF(11)))
show(31, lambda: E37.base_extend(QQ))
show(32, lambda: E37.base_extend(QQ) == E37)
show(33, lambda: E37.base_extend(ZZ))
show(34, lambda: E37.base_extend(Zmod(7)))
show(35, lambda: E37.base_extend(GF(2)))
show(36, lambda: E389.change_ring(GF(101)).a_invariants())
show(37, lambda: E37.base_extend(GF(7)).base_ring())
show(39, lambda: E37.base_extend(GF(3)))
show(40, lambda: E37.base_extend(GF(7)).j_invariant())
