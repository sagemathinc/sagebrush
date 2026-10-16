# solve for a function value (y = function('y')(x), the sagebook's solve(ed, y)
# after desolve), and the order of a symbolic +- pair of roots, compared with
# Sage itself.  The solutions of ed carry their branch conditions here (a
# deliberate difference), so their values are compared, not their forms.
def T(label, f):
    try:
        print(label, '::', f())
    except Exception as e:
        print(label, '::', type(e).__name__)

x = var('x'); y = function('y')(x)
var('a b')
T('pairs', lambda: [solve(x^2 == a, x), solve((x - 1)^2 == a, x), solve(y^2 == 4, y), solve(3*y + x == 1, y)])
ed = desolve(diff(y, x)*log(y) == y*sin(x), y)
T('ed', lambda: [ed, ed.variables()])
c = ed.variables()[0]
sols = solve(ed, y)
T('solutions', lambda: [len(sols), [s.lhs() for s in sols]])
T('values', lambda: [bool(sols[0].rhs() == e^(-sqrt(2*c - 2*cos(x)))), bool(sols[1].rhs() == e^(sqrt(2*c - 2*cos(x))))])
T('substituted', lambda: [bool(sols[0].substitute(c == 5).rhs() == e^(-sqrt(-2*cos(x) + 10))), sols[0].substitute(c == 5).rhs().n() if False else 0])
P = Graphics()
for j in [0, 1]:
    for k in range(1, 10, 2):
        f = solve(ed, y)[j].substitute(c == 2 + 0.25*k).rhs()
        P += plot(f, x, -3, 3)
T('plots', lambda: P)
T('values at 1', lambda: ['%.8f' % float(solve(ed, y)[j].substitute(c == 2).rhs().subs(x=1)) for j in [0, 1]])
# a square content past 2^63 (s*s wrapped as an i64: the roots were lost),
# and a requested variable named like the temporary symbol
T('big content', lambda: [solve(x^2 == (9*2^58)*(a + b), x), solve(x^2 == 8*(a + b), x)])
var('_solve_fn0'); ff = function('ff')
T('requested name', lambda: [list(s) for s in solve([ff(x) == 2], ff(x), _solve_fn0)])
