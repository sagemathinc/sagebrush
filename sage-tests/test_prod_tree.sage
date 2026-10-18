# prod: a balanced product, the factors in order (only grouped), as
# Sage's: its grouping seen through a factor that records each product
def t(label, f):
    try:
        r = f()
        print(label, '::', r)
    except Exception as e:
        print(label, '::', type(e).__name__)


class E:
    def __init__(self, s):
        self.s = s

    def __mul__(self, o):
        return E("(%s*%s)" % (self.s, o.s if isinstance(o, E) else repr(o)))

    def __rmul__(self, o):
        return E("(%s*%s)" % (repr(o), self.s))

    def __repr__(self):
        return self.s


def xs(n):
    return [E("x%d" % i) for i in range(n)]


for n in range(0, 20):
    t('list %d' % n, lambda: prod(xs(n)))
for n in [0, 1, 2, 3, 4, 5, 7, 8, 9, 13, 16, 17, 23]:
    t('gen %d' % n, lambda: prod(e for e in xs(n)))
    t('gen z %d' % n, lambda: prod((e for e in xs(n)), E("z")))
for n in [0, 1, 2, 6, 9]:
    t('tuple %d' % n, lambda: prod(tuple(xs(n))))
    t('list z %d' % n, lambda: prod(xs(n), E("z")))
for c in [1, 2, 3, 4, 8, 20]:
    t('cutoff %d' % c, lambda: prod(xs(11), recursion_cutoff=c))
t('cutoff kw z', lambda: prod(xs(7), z=E("z"), recursion_cutoff=2))
t('cutoff float', lambda: prod(xs(3), recursion_cutoff=1.5))


class WithLen:
    def __len__(self):
        return 9

    def __iter__(self):
        return iter(xs(9))


class SeqOnly:
    def __getitem__(self, i):
        return xs(9)[i]


class LI(list):
    def __iter__(self):
        return iter(xs(7))


t('sized', lambda: prod(WithLen()))
t('sequence protocol', lambda: prod(SeqOnly()))
t('list subclass iter', lambda: prod(LI(xs(9))))
t('dict values', lambda: prod({i: x for i, x in enumerate(xs(9))}.values()))
t('map', lambda: prod(map(lambda e: e, xs(9))))
t('set', lambda: prod(set([5])))
t('not iterable', lambda: prod(5))
t('empty', lambda: [prod([]), prod(iter([])), prod([], 7), prod(iter([]), 7), prod((), E("z"))])
t('ints', lambda: [prod([1, 2, 3, 4]), prod(range(1, 11)), prod([2, 3], 5), prod(range(1, 300)) == factorial(299)])
t('big', lambda: [prod(range(1, 20001)) == factorial(20000), int(prod(range(1, 20001))).bit_length(), prod(k for k in range(1, 5001)) == factorial(5000)])
t('rationals', lambda: prod([1/2, 2/3, 3/4, 4/5, 5/6, 6/7, 7/8]))
t('reals', lambda: [prod([RR(0.1)] * 7), prod([RR(1.1)] * 13), prod(RR(1.1) for _ in range(13))])
A = matrix(ZZ, [[1, 1], [0, 1]])
B = matrix(ZZ, [[1, 0], [1, 1]])
C = matrix(ZZ, [[2, 0], [0, 1]])
t('matrices in order', lambda: [prod([A, B, C, A, B, C, A]) == A * B * C * A * B * C * A, prod([A, B, C, A, B, C, A]), prod(m for m in [B, A, C, B, A, C, B, A])])
t('matrices z', lambda: [prod([A, B], C), prod((m for m in [A, B]), C)])


def g():
    for i in range(6):
        print('yield', i)
        yield E("y%d" % i)


t('generator read once in order', lambda: prod(g()))


# sized as Sage tells it: len(x) through the type's protocol, asked before
# x is iterated; a TypeError streams, another error is raised (CORR-663-1)
class Dynamic:
    def __getattr__(self, name):
        if name == '__len__':
            raise RuntimeError('unexpected length attribute lookup')
        raise AttributeError(name)

    def __iter__(self):
        return iter([2, 3, 4])


class Fabricated:
    def __getattr__(self, name):
        if name == '__len__':
            return lambda: 4
        raise AttributeError(name)

    def __iter__(self):
        return iter([float(1.1)] * 4)


class LenTypeError:
    def __len__(self):
        raise TypeError('no length')

    def __iter__(self):
        return iter([float(1.1)] * 4)


class LenValueError:
    def __len__(self):
        raise ValueError('bad length')

    def __iter__(self):
        print('iterated')
        return iter([2, 3])


class MutableLength:
    def __init__(self):
        self.items = [2, 3, 4]
        self.log = []

    def __len__(self):
        self.log.append('len')
        self.items = [5, 7]
        return len(self.items)

    def __iter__(self):
        self.log.append('iter')
        return iter(self.items)


t('getattr hook not asked for __len__', lambda: prod(Dynamic()))
t('fabricated __len__ streams', lambda: repr(prod(Fabricated())))
t('__len__ TypeError streams', lambda: repr(prod(LenTypeError())))
t('sized floats', lambda: repr(prod([float(1.1)] * 4)))
t('__len__ ValueError before iterating', lambda: prod(LenValueError()))
m = MutableLength()
t('len before iter', lambda: (prod(m), m.log))


class Big:
    def __index__(self):
        return int(2)**int(64)


# the cutoff a Py_ssize_t, checked before x is looked at (CORR-663-2)
for c in [2**63, 2**64, -2**63 - 1, 2**63 - 1]:
    t('cutoff %d' % c, lambda: prod([2, 3], recursion_cutoff=c))
    t('cutoff %d empty' % c, lambda: prod([], recursion_cutoff=c))
t('cutoff Big', lambda: prod([2, 3], recursion_cutoff=Big()))
t('cutoff Big generator', lambda: prod(LenValueError(), recursion_cutoff=Big()))
