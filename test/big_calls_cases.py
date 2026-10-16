# Calls with hundreds of thousands of positional arguments, f(*xs), as
# CPython takes them (pyjs spread them into a JS call: a RecursionError).
import io, math, struct

N = 300000
xs = list(range(N))


def type_of(thunk):
    try:
        return thunk()
    except Exception as e:
        return type(e).__name__


def show(label, thunk):
    try:
        print(label, thunk())
    except Exception as e:
        print(label, type(e).__name__, e)


# compiled functions
def star(*a): return len(a), a[-1]
def head(a, *rest, k=0): return a, len(rest), k
def two(a, b): return a + b
def gen(*a): yield len(a)
def outer(*a): return star(*a)
show('star', lambda: star(*xs))
show('head', lambda: head(*xs))
show('head kw', lambda: head(*xs, k=5))
show('head **', lambda: head(*xs, **{'k': 6}))
show('two', lambda: two(*xs))
show('lambda', lambda: (lambda *a: sum(a))(*xs))
show('gen', lambda: next(gen(*xs)))
show('outer', lambda: outer(*xs))
show('star twice', lambda: star(*xs, *xs))
show('star around', lambda: star(-1, *xs, -2))


# methods and classes
class C:
    def __init__(self, *a): self.n = len(a)
    def m(self, *a): return len(a)
    @staticmethod
    def s(*a): return len(a)
    @classmethod
    def c(cls, *a): return cls.__name__, len(a)
show('init', lambda: C(*xs).n)
show('method', lambda: C().m(*xs))
show('unbound', lambda: C.m(C(), *xs))
show('static', lambda: C.s(*xs))
show('classmethod', lambda: C.c(*xs))
show('callable', lambda: type('K', (), {'__call__': lambda self, *a: len(a)})()(*xs))

# builtins
show('struct.pack', lambda: len(struct.pack('%di' % N, *xs)))
st = struct.Struct('%dH' % N)
show('Struct.pack', lambda: struct.unpack('%dH' % N, st.pack(*xs[:N]))[-3:] if False else len(st.pack(*[x % 65536 for x in xs])))
show('Struct.pack unbound', lambda: len(struct.Struct.pack(st, *[x % 65536 for x in xs])))
buf = bytearray(4 * N + 4)
show('pack_into', lambda: (struct.pack_into('%di' % N, buf, 4, *xs), buf[-4:])[1])
show('Struct.pack_into', lambda: (struct.Struct('%di' % N).pack_into(buf, 0, *xs), buf[:8])[1])
show('pack too few', lambda: struct.pack('%di' % (N + 1), *xs))
show('pack keyword', lambda: type_of(lambda: struct.pack('i', x=1)))
show('max', lambda: max(*xs))
show('min', lambda: min(*xs))
out = io.StringIO()
show('print', lambda: (print(*xs, file=out, sep=','), len(out.getvalue()))[1])
show('format', lambda: len(('{}' * N).format(*xs)))
show('union', lambda: len(set().union(*[[x] for x in xs])))
show('frozenset union', lambda: len(frozenset().union(*[[x] for x in xs])))
show('intersection', lambda: set(range(10)).intersection(*[range(5, 20)] * N))
show('difference', lambda: set(range(10)).difference(*[[x] for x in xs[:8]] * (N // 8)))
s = set()
show('update', lambda: (s.update(*[[x] for x in xs]), len(s))[1])
s2 = set(range(10))
show('intersection_update', lambda: (s2.intersection_update(*[range(3, 30)] * N), sorted(s2))[1])
show('difference_update', lambda: (s2.difference_update(*[[4]] * N), sorted(s2))[1])
show('symmetric_difference_update', lambda: type_of(lambda: (s2.symmetric_difference_update(*[[1]] * N), sorted(s2))[1]))
show('gcd', lambda: math.gcd(*[x * 6 for x in xs]))
show('lcm', lambda: math.lcm(*([2, 3, 4] * N)))
rows = [(x, -x) for x in xs]
show('zip', lambda: [t[-2:] for t in zip(*rows)])
show('zip strict', lambda: len(list(zip(*rows, strict=True))))

# counts still checked
show('len', lambda: len(*xs))
show('sum', lambda: type_of(lambda: sum(*xs)))
show('unpack_from', lambda: type_of(lambda: struct.unpack_from('i', b'\0\0\0\0', *xs)))
show('set.add', lambda: type_of(lambda: set().add(*xs)))
show('gcd keyword', lambda: type_of(lambda: math.gcd(*xs, a=1)))
s3 = {1, 2}
show('symmetric_difference_update two', lambda: type_of(lambda: s3.symmetric_difference_update([1], [3])))
show('symmetric_difference_update one', lambda: (s3.symmetric_difference_update([2, 5]), sorted(s3))[1])
show('union keeps first', lambda: sorted(map(repr, {1, 2}.union([1.0, True], {2.0}, [3.0]))))
show('difference iterable', lambda: sorted({1, 2, 3, 4}.difference([1.0], {3}, iter([4]))))
show('union unhashable', lambda: type_of(lambda: set().union([1], [[1]])))
show('difference unhashable', lambda: type_of(lambda: {1}.difference([[1]])))
show('unpack_from extra', lambda: type_of(lambda: struct.unpack_from('i', b'\\0\\0\\0\\0', 0, 1)))
show('calcsize extra', lambda: type_of(lambda: struct.calcsize('i', 1)))
out2 = io.StringIO()
show('StringIO many writes', lambda: (print(*xs, file=out2), len(out2.getvalue()), out2.getvalue()[-12:])[1:])
s4 = io.StringIO('abcdef')
show('StringIO overwrite', lambda: (s4.write('XY'), s4.seek(0, 2), s4.write('Z'), s4.seek(1), s4.write('Q'), s4.getvalue(), s4.truncate(3), s4.write('W'), s4.getvalue())[-1])

# around the threshold where calls stop being spread
for n in (2046, 2047, 2048, 2049):
    ys = list(range(n))
    show('edge %d' % n, lambda: (star(*ys), len(struct.pack('%dB' % n, *[y % 256 for y in ys])), max(*ys), round(math.hypot(*[1.0] * n) ** 2), C().m(*ys), type_of(lambda: two(*ys)), type_of(lambda: len(*ys))))

# unpack_from's keywords bound by its signature; StringIO(None) is empty (CORR-A78-1, -2)
b4 = b'\x01\x00\x00\x00\x02\x00\x00\x00'
for label, f in [('pos', lambda: struct.unpack_from('<i', b4, 4)), ('kw', lambda: struct.unpack_from('<i', b4, offset=4)),
                 ('buffer kw', lambda: struct.unpack_from('<i', buffer=b4)), ('extra', lambda: struct.unpack_from('<i', b4, 0, 1)),
                 ('extra kw', lambda: struct.unpack_from('<i', b4, 0, 1, offset=0)), ('dup', lambda: struct.unpack_from('<i', b4, 0, offset=0)),
                 ('unknown', lambda: struct.unpack_from('<i', b4, bad=0)), ('format kw', lambda: struct.unpack_from(format='<i', buffer=b4)),
                 ('missing', lambda: struct.unpack_from('<i')), ('missing kw', lambda: struct.unpack_from('<i', offset=0))]:
    show('unpack_from ' + label, lambda: type_of(f))
show('StringIO(None)', lambda: (io.StringIO(None).getvalue(), io.StringIO().getvalue(), io.StringIO('ab').read()))
show('StringIO(5)', lambda: type_of(lambda: io.StringIO(5)))

# explicit __call__ slots take the arguments as an array too, keywords included (HARD-A78-1)
show('fn __call__', lambda: star.__call__(*xs))
show('builtin __call__', lambda: max.__call__(*xs))
show('bound __call__', lambda: C().m.__call__(*xs))
show('type __call__', lambda: type.__call__(C, *xs).n)
show('struct __call__', lambda: len(struct.pack.__call__('%di' % N, *xs)))
show('__call__ keywords', lambda: (head.__call__(*xs, k=3)[1:], (lambda **k: k).__call__(a=1), type.__call__(dict, a=2), max.__call__([3, 1], key=lambda v: -v)))
show('__call__ small', lambda: (star.__call__(1, 2), C().m.__call__(1), max.__call__(1, 5)))
# unpack_from's required arguments come first (CORR-D6E-1)
show('unpack_from no format', lambda: type_of(lambda: struct.unpack_from(buffer=b4)))
show('unpack_from no format, offset', lambda: type_of(lambda: struct.unpack_from(buffer=b4, offset=0)))
