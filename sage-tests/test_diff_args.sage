# diff with a list of variables: an empty list means no differentiation (diff(x^2, []) was 2*x); a tuple, or a list among other arguments, is Sage's TypeError. Compared with Sage itself.
def T(name, fun):
    try: print(name, '::', fun())
    except Exception as e: print(name, '::', type(e).__name__)
x, y = var('x y')
T('list empty', lambda: diff(x^2, []))
T('tuple empty', lambda: diff(x^2, ()))
T('method empty', lambda: (x^2).diff([]))
T('list x x', lambda: diff(x^2*y, [x, x]))
T('list x y', lambda: diff(x^2*y, [x, y]))
T('empty then x', lambda: diff(x^3, [], x))
T('two vars empty', lambda: diff(x*y, []))
T('derivative empty', lambda: derivative(x^2, []))
f(x) = x^3
T('callable empty', lambda: f.diff([]))
T('series', lambda: (x^2 + x).series(x, 4).diff([]))
