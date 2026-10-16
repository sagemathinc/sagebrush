# Names a function, a class body and exec'd code read, as CPython's (the
# .out is CPython 3.14's): a local an inner scope can unbind; a dict
# subclass's globals; the globals' own __builtins__; the builtins the
# compiler runs in place, replaced
import builtins

def t(f):
    try:
        return repr(f())
    except Exception as e:
        return type(e).__name__ + ': ' + str(e)

# an inner function's `nonlocal x; del x` unbinds the outer x
def f1():
    x = 1
    def g():
        nonlocal x
        del x
    g()
    return x
print(t(f1))
def f2():
    x = 1
    def g():
        nonlocal x
        del x
    g()
    x = 2
    return x
print(t(f2))
def f3():
    x = 1
    def g():
        nonlocal x
        del x
    def h():
        return x
    g()
    return h()
print(t(f3))
def f4():
    x = 1
    gen = (x for _ in range(1))
    def g():
        nonlocal x
        del x
    g()
    return list(gen)
print(t(f4))

# a function's global reads go through a dict subclass's __getitem__ (a
# KeyError: the builtins next); its global writes and deletes, and the top
# level's fallback to the globals, are the storage's
class D(dict):
    def __getitem__(self, k):
        print('get', k)
        if k == 'h': raise KeyError(k)
        return 42 if k == 'x' else super().__getitem__(k)
    def __setitem__(self, k, v): print('set', k); super().__setitem__(k, v)
    def __delitem__(self, k): print('del', k); super().__delitem__(k)
d = D(x=1, h=5)
exec("def f():\n    return x, len('ab')\nprint(f())\ndef fh():\n    return h", d)
print(t(d['fh']))
exec("def g():\n    global y\n    y = 5\n    r = y\n    del y\n    return r\nprint(g())", d)
print(t(lambda: eval('x', d, {})), t(lambda: eval('(lambda: x)()', d, {})))
exec("global x\nprint(x)", d)
exec("print([x for _ in range(1)])", d)
exec("class C:\n    a = x\nprint(C.a)", d)
dm = D(x=1)
exec("def f():\n    return missing", dm)
print(t(dm['f']))

# the globals' __builtins__: the builtins code reads, its __import__ and
# __build_class__ too
print(t(lambda: exec("print(1)", {'__builtins__': {}})))
g = {'__builtins__': {'len': lambda s: 'L'}}
exec("r = len('ab')\ndef f(): return len('ab')\nr2 = f()", g)
print(g['r'], g['r2'])
print(t(lambda: exec("import os", {'__builtins__': {}})))
print(t(lambda: exec("from os import path", {'__builtins__': {}})))
imp = type(builtins)('imp')
imp.path = 'P'
calls = []
g = {'__builtins__': {'__import__': lambda *a: calls.append((a[0], a[3], a[4])) or imp}}
exec("import os\nr = os.__name__\nfrom os import path\nr2 = path", g)
print(g['r'], g['r2'], calls)
g = {'__builtins__': builtins}
exec("r = len('ab')", g)
print(g['r'])
class BD(dict):
    def __getitem__(self, k): print('bget', k); return super().__getitem__(k)
g = {'__builtins__': BD(len=len)}
exec("r = len('ab')\ndef f(): return len('abc')\nr2 = f()", g)
print(g['r'], g['r2'])
print(t(lambda: exec("class C: pass", {'__builtins__': {}})))
g = {'__builtins__': {'__build_class__': builtins.__build_class__, '__name__': 'BN'}}
exec("class C: pass\nr = C.__module__", g)
print(g['r'])
g = {}
exec("r = 1", g)
print(type(g['__builtins__']).__name__)
g = {'__builtins__': {'sum': lambda it: 'S', 'range': range}}
exec("r = sum(x for x in range(3))", g)
print(g['r'])
print(t(lambda: exec("assert False", {'__builtins__': {}})))
print(t(lambda: exec("raise ValueError", {'__builtins__': {}})))
print(t(lambda: exec("x = [i for i in (1, 2)]", {'__builtins__': {}})))
print(t(lambda: exec("r = __import__", {'__builtins__': {}})))
print(t(lambda: eval("abs(-1)", {'__builtins__': None})))
print(t(lambda: eval("abs(-1)", {'__builtins__': 5})))
mod = type(builtins)('mb')
mod.abs = lambda v: 'MA'
print(t(lambda: eval("abs(-1)", {'__builtins__': mod})))
print(t(lambda: eval("len('a')", {'__builtins__': mod})))

# the builtins the compiler runs in place, replaced in the builtins module
for name, code in [('range', 'r = [i for i in range(3)]\nfor i in range(2): r.append(i)'),
                   ('sum', 'r = sum(x for x in (1, 2))'), ('tuple', 'r = tuple(x for x in (1, 2))'),
                   ('sorted', 'r = sorted(x for x in (2, 1))'), ('any', 'r = any(x for x in (0, 1))')]:
    old = getattr(builtins, name)
    try:
        setattr(builtins, name, lambda *a: ['custom'])
        g = {}
        exec(code, g)
    finally:
        setattr(builtins, name, old)
    print(name, g['r'])
old = builtins.len
try:
    del builtins.len
    print(t(lambda: exec("len('a')", {})))
finally:
    builtins.len = old

# a name a comprehension's walrus binds at the top level is the globals'
# there, outside comprehensions: loads, stores, deletes (astra's probe)
for initial in [{}, {'a': 10}]:
    for mode in ['eval', 'exec']:
        g = dict(initial); d = {'a': 2}
        try:
            if mode == 'eval': r = eval('(a, [(a:=i) for i in range(2)], a)', g, d)
            else:
                exec('r = (a, [(a:=i) for i in range(2)], a)', g, d); r = d['r']
            print(initial, mode, r, g.get('a'), d['a'])
        except Exception as e: print(initial, mode, type(e).__name__, str(e), g.get('a'), d['a'])
for code in ['a = 5\nr = [(a:=i) for i in range(2)]\nb = a',
             'del a\nr = [(a:=i) for i in range(2)]',
             'r = [[a for j in range(1)] for i in range(1)]\nq = [(a:=i) for i in range(1)]',
             'r = [(a, [a for j in range(1)]) for i in range(1) if (a:=7)]',
             'def f(): return a\nr = f()\nq = [(a:=i) for i in range(1)]\ns = (lambda: a)()',
             'class C:\n    b = a\nq = [(a:=i) for i in range(1)]\nr = C.b',
             'r = [a for i in range(1)]\nq = [(a:=i) for i in range(1)]',
             'r = list(a for i in range(1))\nq = [(a:=i) for i in range(1)]',
             'for a in range(3): pass\nq = [(a:=i) for i in range(1)]',
             'b0 = a\nr = list((a:=i) for i in range(2))\nb = a',
             'b0 = a\nr = [[(a:=j) for j in range(2)] for i in range(1)]\nb = a']:
    g = {'a': 1}; d = {'a': 2}
    print(repr(code), t(lambda: exec(code, g, d)), g.get('a'), sorted((k, v) for k, v in d.items() if not callable(v)))

# a metaclass's __prepare__ runs before the class body, which reads, writes
# and deletes through the namespace it returns (its __name__ the class's
# __module__), and the metaclass receives that namespace; a conflict or a
# non-mapping is raised before the body
log = []
class LM(dict):
    def __getitem__(self, k): log.append(('get', k)); return super().__getitem__(k)
    def __setitem__(self, k, v):
        if k not in ('__static_attributes__', '__classdictcell__'): log.append(('set', k))
        super().__setitem__(k, v)
    def __delitem__(self, k): log.append(('del', k)); super().__delitem__(k)
class Meta(type):
    @classmethod
    def __prepare__(mcls, name, bases, **kw):
        log.append(('prepare', name, tuple(sorted(kw))))
        ns = LM(); dict.__setitem__(ns, '__name__', 'PREP'); dict.__setitem__(ns, 'pre', 1); return ns
    def __new__(mcls, name, bases, ns, **kw):
        log.append(('new', type(ns).__name__, ns.get('__module__'), 'pre' in ns, 'b' in ns))
        return super().__new__(mcls, name, bases, dict(ns))
    def __init__(cls, *a, **kw): pass
def kwv(): log.append('kw'); return 1
def bs(): log.append('bases'); return object
class C(bs(), metaclass=Meta, flag=kwv()):
    log.append('body')
    b = pre
    def f(self): return 1
    del f
print(log)
print(C.__module__, C.b)
class M1(type): pass
class M2(type): pass
A = M1('A', (), {}); B = M2('B', (), {})
def body_conflict():
    class X(A, B):
        print('body ran')
print(t(body_conflict))
class BadP(type):
    @classmethod
    def __prepare__(m, n, b): return 5
def bad():
    class Y(metaclass=BadP):
        print('body ran')
print(t(bad))
class Plain(type):
    @classmethod
    def __prepare__(m, n, b): return {'__name__': 'PN', 'z': 3}
class Z(metaclass=Plain):
    w = z
    l = sorted(k for k in locals())
print(Z.__module__, Z.w, Z.l)
class NM:
    def __init__(self): self.d = {}
    def __getitem__(self, k): return self.d[k]
    def __setitem__(self, k, v): self.d[k] = v
    def __delitem__(self, k): del self.d[k]
class MM(type):
    @classmethod
    def __prepare__(m, n, b): return NM()
    def __new__(m, n, b, ns):
        print(type(ns).__name__, sorted(k for k in ns.d if k not in ('__static_attributes__', '__classdictcell__')))
        return super().__new__(m, n, b, dict(ns.d))
class W(metaclass=MM):
    q = 1
    print(type(locals()).__name__)
    def g(self): return q
print(W.q, W.__module__, t(W().g))
def nodel():
    class V(metaclass=MM):
        del nothere
print(t(nodel))
