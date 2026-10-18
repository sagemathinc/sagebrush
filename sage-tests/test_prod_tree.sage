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
