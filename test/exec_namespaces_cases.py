# exec and eval with separate globals and locals, as CPython's: the top level
# (and an inlined list, set or dict comprehension there) reads the locals,
# then the globals, and writes the locals; functions, lambdas, generator
# expressions and class bodies see only the globals; a top-level name
# declared global is the globals'.


def t(code, ev=None):
    g = {}
    l = {'c': 1}
    try:
        exec(code, g, l)
        r = eval(ev, g, l) if ev else None
        return repr(r), sorted(k for k in g if k != '__builtins__'), sorted(l)
    except Exception as e:
        return type(e).__name__ + ': ' + str(e)


for code, ev in [("r = [c for _ in range(1)]", "r"), ("r = list(c for _ in range(1))", "r"), ("r = {c: 0 for _ in range(1)}", "r"),
                 ("r = {c for _ in range(1)}", "r"), ("class A:\n  x = c\nr = A.x", "r"), ("def f(): return c\n", "f()"),
                 ("h = lambda: c", "h()"), ("global b\nb = 5\nr = b", "r"), ("global c\nr = c", None),
                 ("def f():\n  global z\n  z = 3\nf()", "z"), ("x = 1\ndef f(): return x\n", "f()"),
                 ("import math\ndef f(): return math.pi", "f()"), ("globals()['a'] = 5\ndef f(): return a", "f()"),
                 ("class A:\n  def m(self): return c\n", "A().m()"), ("del c", None), ("global c\ndel c", None),
                 ("r = (lambda: [c for _ in range(1)])", "r()"), ("def f():\n  return [y for y in range(2)]\nr = f()", "r"),
                 ("x = 2\nclass B:\n  y = x\nr=B.y", "r"), ("c = 7\nr = c", "r"), ("r = len", "r(c * [0])"),
                 ("def f(): return len([1, 2])\n", "f()"), ("def f(): return eval('c')\n", "f()"),
                 ("def f(): return eval('1 + 1')\n", "f()"), ("r = [(lambda: c)() for _ in range(1)]", "r")]:
    print(repr(code), '->', t(code, ev))
# sage-sr-gaps1's cases (CORR-282-3)
g = {}
l = {'a': 2}
exec("globals()['a'] = 5\ndef f(): return a", g, l)
print(eval("f()", g, l))
g2 = {}
l2 = {}
exec("global b\nb = 5", g2, l2)
print('b' in l2, g2.get('b'))
g3 = {}
l3 = {'c': 1}
exec("h = lambda: c", g3, l3)
try:
    print(eval("h()", g3, l3))
except NameError as e:
    print('NameError', e)
# an ordinary module and exec with one namespace are unchanged
x = 10
def f():
    return x
print(f(), [x for _ in range(1)], list(x for _ in range(1)))
g4 = {}
exec("y = 3\ndef k(): return y\nr = k()", g4)
print(g4['r'])
