class D:
    y = 1
    x: __classdict__
d = D.__annotations__['x']
print('classdict type', type(d).__name__, d is vars(D), d['y'], d['__module__'], '__annotate_func__' in d, '__qualname__' in d, '__firstlineno__' in d)
class E:
    def f(x: list(locals())): pass
    y: list(locals())
print('locals order', E.f.__annotations__, E.__annotations__)
def outer():
    v = 1
    class C:
        nonlocal v
        a: v
        v = 2
        def f(y: v): pass
    return C
C = outer()
print('class nonlocal', C.__annotations__, C.f.__annotations__)
x = 8
class G:
    global x
    a: x
    def f(y: x): pass
G.x = 5
print('class global', G.__annotations__, G.f.__annotations__)
def h(x: list(locals())): pass
print('function locals', h.__annotations__)
y: list(locals()) = 1
print('module locals', __annotate__(1))
def k():
    format = 5
    def m(a: format, b: (lambda: format)()): pass
    return m
print('free format lambda', k().__annotations__)
