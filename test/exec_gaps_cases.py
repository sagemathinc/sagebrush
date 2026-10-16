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

# astra's reproductions for CORR-6C9-1 to -5 (python-exec-gaps 6c9520cc review)


def run(label, f):
    try: print(label, 'ok', f())
    except BaseException as e: print(label, type(e).__name__, str(e))

# First miss must not be retried.
class B:
    def __init__(self): self.n=0
    def __getitem__(self, key):
        self.n+=1
        if self.n == 1: raise KeyError(key)
        return 99
b=B()
run('builtin retry',lambda: eval('len', {'__builtins__':b}))
print('builtin calls',b.n)

# Old frames keep their builtins for IMPORT_NAME too.
log=[]
def old_import(*args): log.append('old'); return builtins
def new_import(*args): log.append('new'); return builtins
g={'__builtins__':dict(vars(builtins), __import__=old_import)}
exec('def f():\n    import anything',g)
g['__builtins__']=dict(vars(builtins), __import__=new_import)
run('frame import',g['f'])
print('import log',log)

# Nested exec should inherit the caller frame builtins when absent in G.
child={}
g={'__builtins__':dict(vars(builtins), len=lambda x:99),'child':child}
exec('exec("r=len([])",child)',g)
print('nested builtins', child['r'])

# Default eval must use the prepared mapping's methods, even for a dict subclass.
class N(dict):
    def __getitem__(self,k):
        if k=='x': return 42
        return super().__getitem__(k)
    def __setitem__(self,k,v):
        if k=='x': v*=10
        return super().__setitem__(k,v)
class M(type):
    @classmethod
    def __prepare__(m,n,b): return N(x=1)
def prepared_eval():
    class C(metaclass=M):
        y=eval('x')
        exec('x=3')
    return C.y,C.x
run('prepared eval/exec',prepared_eval)

# Non-dict prepared mappings must work too.
class N2:
    def __init__(self): self.d={}
    def __getitem__(self,k): return self.d[k]
    def __setitem__(self,k,v): self.d[k]=v
    def __delitem__(self,k): del self.d[k]
class M2(type):
    @classmethod
    def __prepare__(m,n,b): return N2()
    def __new__(m,n,b,d): return super().__new__(m,n,b,d.d)
def prepared_nondict():
    class C(metaclass=M2):
        x=7
        y=eval('x')
    return C.y
run('prepared nondict',prepared_nondict)

# Except-target DELETE_NAME must not swallow failed mapping deletion.
class N3(dict):
    def __delitem__(self,k): raise RuntimeError('denied')
class M3(type):
    @classmethod
    def __prepare__(m,n,b): return N3()
def cleanup():
    class C(metaclass=M3):
        try: 1/0
        except Exception as e: pass
    return 'class built'
run('prepared cleanup',cleanup)

log = []
class Prep:
    def __get__(self, obj, owner):
        log.append('lookup')
        return type.__prepare__
class M(type): __prepare__=Prep()
log.clear()
class C(metaclass=M): log.append('body')
print(log)

# the frame's builtins for `import x as y` and `from x import y` too, and a
# nested eval's new globals
log = []
def old_import(*args): log.append(('old', args[0], args[3])); return builtins
def new_import(*args): log.append(('new', args[0], args[3])); return builtins
g = {'__builtins__': dict(vars(builtins), __import__=old_import)}
exec('def f():\n    import anything as a\n    from other import len\n    return a is builtins', g)
g['__builtins__'] = dict(vars(builtins), __import__=new_import)
print(t(g['f']), log)
child = {}
g = {'__builtins__': dict(vars(builtins), len=lambda x: 98), 'child': child}
print(t(lambda: exec('r = eval("len([])", child)\nimport builtins as b2', g)), sorted(child['__builtins__']) == sorted(g['__builtins__']), g['r'])
# metaclass=None and __prepare__ = None are called, a TypeError
def mnone():
    class C(metaclass=None): pass
print(t(mnone))
class PN(type): __prepare__ = None
def pnone():
    class C(metaclass=PN): print('body ran')
print(t(pnone))
