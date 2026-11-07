# diff(f, x, 0) is f: a count after a variable is how many derivatives in it, 0 none; a leading count is in
# the only variable; a polynomial's derivative stays in its ring, as Sage (friction W19)
def show(label, f):
    try:
        print(label, '|', f())
    except Exception as e:
        print(label, '| ERR', type(e).__name__, repr(str(e)[:120]))
t, y = var('t y'); g = 1 + t^2/2; h = t^2*y^3
R.<m> = QQ[]
f(t) = t^3
for n, F in [('diff(g,t,0)', lambda: diff(g, t, 0)), ('g.diff(t,0)', lambda: g.diff(t, 0)), ('derivative(g,t,0)', lambda: derivative(g, t, 0)), ('diff(g,t,1)', lambda: diff(g, t, 1)), ('diff(g,t,2)', lambda: diff(g, t, 2)),
             ('diff(g,0)', lambda: diff(g, 0)), ('diff(g,2)', lambda: diff(g, 2)), ('diff(g,t,-1)', lambda: diff(g, t, -1)), ('diff(h,t,0,t)', lambda: diff(h, t, 0, t)), ('diff(h,t,0,y,1)', lambda: diff(h, t, 0, y, 1)),
             ('diff(h,t,1,0)', lambda: diff(h, t, 1, 0)), ('diff(h,t,2,y,0)', lambda: diff(h, t, 2, y, 0)), ('diff(h,0,t)', lambda: diff(h, 0, t)), ('diff(h,t,y,0)', lambda: diff(h, t, y, 0)), ('diff(h,0)', lambda: diff(h, 0)),
             ('poly diff(m,0)', lambda: (m^3).diff(m, 0)), ('derivative(m^3,m,0)', lambda: derivative(m^3, m, 0)), ('derivative(m^3,m,0) parent', lambda: derivative(m^3, m, 0).parent()), ('callable f.diff(t,0)', lambda: f.diff(t, 0)),
             ('diff(f,t,0)', lambda: diff(f, t, 0)), ('diff(sin(t),t,0)', lambda: diff(sin(t), t, 0)), ('diff(g,t,0,t,0)', lambda: diff(g, t, 0, t, 0))]:
    show(n, F)
S.<a,b> = QQ[]
for n, F in [('diff(m^3, m)', lambda: diff(m^3, m)), ('diff(m^3,m) parent', lambda: diff(m^3, m).parent()), ('diff(m^3, y)', lambda: diff(m^3, y)), ('diff(m^3, m, 2)', lambda: diff(m^3, m, 2)), ('derivative(m^3)', lambda: derivative(m^3)),
             ('diff(m^3, 2)', lambda: diff(m^3, 2)), ('diff(a^2*b, a)', lambda: diff(a^2*b, a)), ('diff(a^2*b, a) parent', lambda: diff(a^2*b, a).parent()), ('diff(a^2*b, a, 0)', lambda: diff(a^2*b, a, 0)),
             ('diff(m^3, t)', lambda: diff(m^3, t)), ('diff(GF5 poly)', lambda: diff(GF(5)['z'].gen()^3, GF(5)['z'].gen()))]:
    show(n, F)
