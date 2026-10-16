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
