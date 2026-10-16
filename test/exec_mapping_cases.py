# exec and eval with locals that aren't an exact dict: CPython's LOAD_NAME,
# STORE_NAME and DELETE_NAME go through the mapping's own __getitem__,
# __setitem__ and __delitem__ (the .out is CPython 3.14's)
import collections

def t(f):
    try:
        return repr(f())
    except Exception as e:
        return type(e).__name__ + ': ' + str(e)

class M:
    def __init__(self): self.d = {}; self.log = []
    def __getitem__(self, k): self.log.append(('get', k)); return self.d[k]
    def __setitem__(self, k, v): self.log.append(('set', k)); self.d[k] = v
    def __delitem__(self, k): self.log.append(('del', k)); del self.d[k]
    def keys(self): return self.d.keys()

m = M()
g = {'y': 5}
exec("x = 1\nz = x + y\nprint(type(locals()).__name__, type(vars()).__name__)\ndel x", g, m)
print(m.d, m.log)
print(sorted(k for k in g if k != '__builtins__'))
m.log.clear()
print(t(lambda: exec("del y", g, m)), m.log)
print(t(lambda: exec("print(q)", g, m)))
m.log.clear()
exec("x = 3\nx += 2\nfor i in range(2): pass\nimport math as mm\nclass C: a = 1\ndef f(): return y\nr = f()", g, m)
print(sorted(m.d), m.d['x'], m.d['r'], m.d['C'].a, m.log)
print(eval("[x + i for i in range(2)]", g, m), eval("dir()", g, m))
print(t(lambda: eval("f.__globals__ is g", {'g': g}, m)))
exec("exec('w = x * 10')", g, m)
print(m.d['w'], 'w' in g)

class Bad:
    def __getitem__(self, k): raise ValueError('boom')
print(t(lambda: exec("print(len)", {}, Bad())))

class Dflt:
    def __getitem__(self, k):
        if k == 'a': return 42
        raise KeyError(k)
print(t(lambda: eval("a + 1", {}, Dflt())), t(lambda: eval("len", {}, Dflt())), t(lambda: eval("b", {'b': 7}, Dflt())))
print(t(lambda: exec("a = 1", {}, Dflt())))
print(t(lambda: eval("[i for i in range(2)]", {}, Dflt())))
print(t(lambda: eval("None", {}, Dflt())))

class Nones:
    def __getitem__(self, k):
        if k == 'n': return None
        raise KeyError(k)
print(t(lambda: eval("n", {'n': 1}, Nones())))

cm = collections.ChainMap({}, {'w': 3})
exec("v = w * 2", {}, cm)
print(dict(cm))

class D(dict):
    def __missing__(self, k): return 'miss'
print(t(lambda: eval("foo", {}, D())), t(lambda: eval("foo", {'foo': 1}, D())))

class S(dict):
    def __setitem__(self, k, v): print('set', k); super().__setitem__(k, v)
    def __getitem__(self, k): print('get', k); return super().__getitem__(k)
s = S()
exec("x = 1\nx", {}, s)
print(s)

class KE(KeyError): pass
class P:
    def __getitem__(self, k): raise KE(k)
print(t(lambda: eval("len", {}, P())))
print(t(lambda: exec("del q", {}, P())))

class V:
    def __getitem__(self, k): raise KeyError(k)
    def __delitem__(self, k): raise ValueError('v')
def ctx():
    try:
        exec("del q", {}, V())
    except NameError as e:
        return str(e), e.__context__
print(ctx())

class N:
    def __getitem__(self, k): raise KeyError(k)
class K2(N):
    def keys(self): return 5
class K3(N):
    def keys(self): return ('b', 'a', 'c')
class K4(N):
    def keys(self): return iter(['z', 'b'])
for cls in (N, K2, K3, K4):
    print(cls.__name__, t(lambda: eval("dir()", {}, cls())))

print(t(lambda: exec('a', {}, [])))
print(t(lambda: exec('a=1', {}, ())))
print(t(lambda: exec('import sys', {}, 5)))

# del deletes from the locals only, and a builtin's name is unbound there
print(t(lambda: exec("del y", {'y': 1}, {})))
print(t(lambda: exec("del len")))
print(t(lambda: exec("del len", {})))
print(t(lambda: exec("y = 2\ndel y\nprint(y)", {'y': 1}, {})))
def h():
    global zz
    del zz
print(t(h))

# the introspection builtins are names like any: the locals, the globals or
# the builtins can bind them otherwise
print(t(lambda: exec("print(locals(), vars(), dir(), globals())", {}, {'locals': lambda: 5, 'vars': lambda: 6, 'dir': lambda: 7, 'globals': lambda: 8})))
print(t(lambda: exec("print(locals())", {'locals': lambda: 6})))
print(t(lambda: exec("print(eval('1'), exec('2'))", {}, {'eval': lambda s: 'e' + s, 'exec': lambda s: 'x' + s})))
print(t(lambda: exec("def f():\n    return locals()\nprint(f())", {'locals': lambda: 'g'})))
print(t(lambda: exec("class C:\n    a = 1\n    print(sorted(locals()))", {}, {'locals': lambda: 'no'})))
print(t(lambda: exec("locals = 9\nprint(locals)", {}, {})))

# a function's and a class's __module__ are the globals' __name__, not
# exec's locals'; a class body's, missing there, is the builtins'
print(t(lambda: exec("class C: pass\nprint(repr(C.__module__))\ndef f(): pass\nprint(repr(f.__module__), repr((lambda: 0).__module__))", {}, {'__name__': 'X'})))
print(t(lambda: exec("class C: pass\nprint(repr(C.__module__))\ndef f(): pass\nprint(repr(f.__module__))", {'__name__': 'G'}, {'__name__': 'X'})))
print(t(lambda: exec("class C:\n    del __module__\nprint(repr(C.__module__))", {'__name__': 'G'}, {})))
print(t(lambda: exec("class C: pass\nprint(repr(C.__module__))", {'__name__': None})))

# a class body's del too: a builtin's name, or one deleted, is unbound there
print(t(lambda: exec("class C:\n    del len")))
print(t(lambda: exec("class C:\n    x = 1\n    del x\n    del x")))
print(t(lambda: exec("y = 1\nclass C:\n    del y")))

# a function made there reads its globals, never the mapping, for its code's
# filename and its module
class Sink:
    def __init__(self): self.d = {}
    def __getitem__(self, k): raise ValueError('boom ' + k)
    def __setitem__(self, k, v): self.d[k] = v
sk = Sink()
exec("def f(): pass", {}, sk)
print(t(lambda: (sk.d['f'].__code__.co_filename, sk.d['f'].__module__, sk.d['f'].__globals__ is sk)))

# a relative import's package is the globals' __package__, not the locals'
import sys, types
pk = types.ModuleType('pk'); pk.__path__ = []; sys.modules['pk'] = pk
pks = types.ModuleType('pk.sub'); pks.v = 3; sys.modules['pk.sub'] = pks; pk.sub = pks
print(t(lambda: exec("from . import sub\nprint(sub.v)", {'__package__': 'pk', '__name__': 'pk.m'}, {'__package__': 'zz'})))
print(t(lambda: exec("from . import sub", {'__name__': 'x'}, {'__package__': 'pk'})))
print(t(lambda: exec("from . import sub\nprint(sub.v)", {'__package__': 'pk', '__name__': 'pk.m'}, Sink())))

# an except clause's name is set to None, then deleted, through the locals'
# own methods, however the clause ends (CORR-FBF-1)
class L:
    def __init__(self): self.d = {}; self.log = []
    def __getitem__(self, k): return self.d[k]
    def __setitem__(self, k, v): self.log.append(('set', k, v is None)); self.d[k] = v
    def __delitem__(self, k): self.log.append(('del', k)); del self.d[k]
for code in ["try:\n    1/0\nexcept Exception as x:\n    pass\nr = 7",
             "try:\n    1/0\nexcept Exception as x:\n    del x\nr = 7",
             "try:\n    try:\n        1/0\n    except Exception as x:\n        raise ValueError('v')\nexcept ValueError:\n    pass\nr = 7",
             "for i in range(2):\n    try:\n        1/0\n    except Exception as x:\n        break\nr = 7"]:
    lm = L()
    print(t(lambda: exec(code, {}, lm)), lm.d, lm.log)
class LD(dict):
    def __setitem__(self, k, v): print('set', k, v is None); super().__setitem__(k, v)
    def __delitem__(self, k): print('del', k); super().__delitem__(k)
ld = LD()
print(t(lambda: exec("try:\n    1/0\nexcept Exception as x:\n    pass", {}, ld)), ld)
print(t(lambda: exec("class C:\n    try:\n        1/0\n    except Exception as x:\n        pass\nprint(sorted(k for k in vars(C) if not k.startswith('__')))")))
print(t(lambda: exec("def f():\n    global gx\n    try:\n        1/0\n    except Exception as gx:\n        pass\nf()\nprint('gx' in globals())")))
def fx():
    try:
        1/0
    except Exception as e:
        return 'ret'
    finally:
        pass
print(fx())

# a dict subclass as both globals and locals is a mapping for the names, its
# storage behind them for the globals (CORR-FBF-2)
class DG(dict):
    def __getitem__(self, k):
        print('get', k); return 42 if k == 'x' else super().__getitem__(k)
    def __setitem__(self, k, v): print('set', k); super().__setitem__(k, v)
    def __delitem__(self, k): print('del', k); super().__delitem__(k)
dg = DG(x=1)
print(eval('x', dg), eval('x', dg, dg), eval('x', {}, dg), eval('x', dg, {}), eval('x', dg, None))
exec('y = 3\nr = y\ndel y', dg)
print(sorted(k for k in dg if k != '__builtins__'))
exec('print(sorted(k for k in locals() if k != "__builtins__"), globals() is locals())', dg)

# the builtins module's own replacements of them are called (CORR-FBF-3)
import builtins
_exec = exec
for name, code in [('locals', 'r = locals()'), ('globals', 'r = globals()'), ('vars', 'r = vars()'), ('dir', 'r = dir()'), ('eval', 'r = eval("1")'), ('exec', 'r = exec("1")')]:
    old = getattr(builtins, name)
    try:
        setattr(builtins, name, lambda *a: 'custom')
        out = {}
        _exec(code, {}, out)
        r1 = out['r']
        ns = {}
        _exec('def f():\n    ' + code + '\n    return r\nr2 = f()', ns)
    finally:
        setattr(builtins, name, old)
    print(name, r1, ns['r2'])
print(t(lambda: eval("type(locals()).__name__", {}, {})))
