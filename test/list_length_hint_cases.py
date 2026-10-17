# list(x) asks x's length hint after taking its iterator, as CPython's
# list_extend (PyObject_LengthHint): __len__, then __length_hint__ where
# __len__ raises TypeError; any other error, a hint that is not an int,
# negative or past a C ssize_t, and a guess too large to allocate (a
# MemoryError) are raised. tuple(x) asks nothing. Compared with CPython 3.14.
log = []
def mk(lenf=None, hintf=None, items=(7, 8)):
    ns = {'__iter__': lambda self: (log.append('iter'), iter(items))[1]}
    if lenf: ns['__len__'] = lambda self: (log.append('len'), lenf())[1]
    if hintf: ns['__length_hint__'] = lambda self: (log.append('hint'), hintf())[1]
    return type('C', (), ns)()
def r(e): raise e
cases = [
 ('len RuntimeError', dict(lenf=lambda: r(RuntimeError('x')))),
 ('len TypeError', dict(lenf=lambda: r(TypeError('x')))),
 ('len -1', dict(lenf=lambda: -1)),
 ('len str', dict(lenf=lambda: 'a')),
 ('len 2**70', dict(lenf=lambda: 2**70)),
 ('len 3', dict(lenf=lambda: 3)),
 ('hint RuntimeError', dict(hintf=lambda: r(RuntimeError('x')))),
 ('hint TypeError', dict(hintf=lambda: r(TypeError('x')))),
 ('hint str', dict(hintf=lambda: 'a')),
 ('hint -1', dict(hintf=lambda: -1)),
 ('hint NotImplemented', dict(hintf=lambda: NotImplemented)),
 ('hint 2**70', dict(hintf=lambda: 2**70)),
 ('len TypeError, hint RuntimeError', dict(lenf=lambda: r(TypeError('x')), hintf=lambda: r(RuntimeError('y')))),
 ('len 3, hint RuntimeError', dict(lenf=lambda: 3, hintf=lambda: r(RuntimeError('y')))),
 ('hint 10**12', dict(hintf=lambda: 10**12)),
 ('len 10**12', dict(lenf=lambda: 10**12)),
 ('hint 2**61', dict(hintf=lambda: 2**61)),
 ('hint True', dict(hintf=lambda: True)),
 ('hint 0, len TypeError', dict(lenf=lambda: r(TypeError('x')), hintf=lambda: 0)),
]
for ctor in (list, tuple):
    for label, kw in cases:
        del log[:]
        try: res = repr(ctor(mk(**kw)))
        except BaseException as e: res = '%s: %s' % (type(e).__name__, e)
        print(ctor.__name__, label, '->', res, log)
class T(tuple):
    def __iter__(self): return iter([7, 8])
    def __len__(self): raise RuntimeError('length hint')
for ctor in (list, tuple):
    try: print(ctor.__name__, 'tuple subclass', ctor(T((1, 2))))
    except BaseException as e: print(ctor.__name__, 'tuple subclass', type(e).__name__, e)
class L(list):
    def __len__(self): raise RuntimeError('L len')
for ctor in (list, tuple):
    try: print(ctor.__name__, 'list subclass no iter', ctor(L([1, 2])))
    except BaseException as e: print(ctor.__name__, 'list subclass no iter', type(e).__name__, e)
class G:
    def __iter__(self):
        yield 1
        yield 2
    def __len__(self):
        raise RuntimeError('G len')
for ctor in (list, tuple):
    try: print(ctor.__name__, 'generator __iter__', ctor(G()))
    except BaseException as e: print(ctor.__name__, 'generator __iter__', type(e).__name__, e)
print(list(range(3)), list({1: 2}), list('ab'), list(x for x in (1, 2)), list(iter([5])))

# ---- astra's CORR-9AE-1..3: any special-method value is called as CPython
# calls it; the hint is looked up only after len; len's result goes through
# the index protocol, a hint's must be an int (a subclass's own value)
def show(label, f):
    try: print(label, '->', repr(f()))
    except BaseException as e: print(label, 'raises', type(e).__name__, e)
class Raiser:
    def __init__(self, msg): self.msg = msg
    def __call__(self, *a): raise RuntimeError(self.msg)
def it(self): return iter([7, 8])
show('callable-object hint', lambda: list(type('C', (), {'__iter__': it, '__length_hint__': Raiser('hint')})()))
show('callable-object len', lambda: list(type('C', (), {'__iter__': it, '__len__': Raiser('len')})()))
show('property len', lambda: list(type('C', (), {'__iter__': it, '__len__': property(lambda self: Raiser('prop len'))})()))
show('property hint', lambda: list(type('C', (), {'__iter__': it, '__length_hint__': property(lambda self: Raiser('prop hint'))})()))
show('staticmethod hint', lambda: list(type('C', (), {'__iter__': it, '__length_hint__': staticmethod(lambda: 3)})()))
show('classmethod hint raising', lambda: list(type('C', (), {'__iter__': it, '__length_hint__': classmethod(lambda cls: (_ for _ in ()).throw(RuntimeError('cm')))})()))
class C2:
    def __iter__(self): return iter([7, 8])
    def __len__(self):
        def new_hint(self): raise RuntimeError('new hint')
        C2.__length_hint__ = new_hint
        raise TypeError('no length')
    def __length_hint__(self): return 0
show('hint replaced by len', lambda: list(C2()))
class I(int):
    def __int__(self): raise RuntimeError('do not convert')
    def __index__(self): raise RuntimeError('do not convert')
    def __lt__(self, o): raise RuntimeError('do not compare')
    def __gt__(self, o): raise RuntimeError('do not compare')
for v in (I(2), I(-1), I(2**70), I(10**12), True, False):
    show('hint %s(%d)' % (type(v).__name__, int.__pos__(v) if type(v) is I else v), lambda: list(type('C', (), {'__iter__': it, '__length_hint__': lambda self: v})()))
class N:
    def __init__(self, v): self.v = v
    def __index__(self):
        if self.v is None: raise RuntimeError('index length')
        return self.v
for v, label in ((N(None), 'N raising'), (N(3), 'N(3)'), (N(-1), 'N(-1)'), (N(2**70), 'N(2**70)'), (I(4), 'I(4)'), (N('x'), 'N bad'), (1.5, 'float')):
    C3 = type('C', (), {'__iter__': it, '__len__': lambda self: v})
    show('len result ' + label, lambda: list(C3()))
    show('len() of ' + label, lambda: len(C3()))

# ---- astra's CORR-5FC-1: binding the hint (a descriptor's __get__) raises
# through, TypeError too; only a TypeError from calling it means no guess
def raise_(e): raise e
for label, hint in [
        ('property raising TypeError on binding', property(lambda self: raise_(TypeError('hint bind')))),
        ('property raising RuntimeError on binding', property(lambda self: raise_(RuntimeError('hint bind')))),
        ('property giving a callable raising TypeError', property(lambda self: (lambda: raise_(TypeError('hint call'))))),
        ('property giving a callable returning 3', property(lambda self: (lambda: 3))),
        ('property giving None', property(lambda self: None)),
        ('None', None),
        ('a class whose call raises TypeError', Raiser),
        ('staticmethod raising TypeError', staticmethod(lambda: raise_(TypeError('static')))),
        ('classmethod raising TypeError', classmethod(lambda cls: raise_(TypeError('cm')))),
]:
    show('hint ' + label, lambda: list(type('C', (), {'__iter__': lambda self: iter([11]), '__length_hint__': hint})()))
class Getter:
    calls = 0
    def __get__(self, obj, typ):
        Getter.calls += 1
        if obj is None: return self
        return lambda: 2
show('hint descriptor bound once', lambda: (list(type('C', (), {'__iter__': lambda self: iter([11]), '__length_hint__': Getter()})()), Getter.calls))
show('hint a builtin function (len)', lambda: list(type('C', (), {'__iter__': lambda self: iter([11]), '__length_hint__': len})()))
show('hint a builtin type (int)', lambda: list(type('C', (), {'__iter__': lambda self: iter([11]), '__length_hint__': int})()))
show('hint a builtin bound method returning 3', lambda: list(type('C', (), {'__iter__': lambda self: iter([11]), '__length_hint__': (3).__int__})()))
