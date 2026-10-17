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
