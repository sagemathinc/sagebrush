# python-iter-fixes, compared with CPython 3.14 (test/iter-fixes.test.ts):
# itertools constructors that take their iterators and check their
# arguments when made (A27); deque iterators and searches that see
# mutations as CPython's do (A28, A31); min and max one item at a time
# (A32); map's strict and zip's strict messages
import itertools
from collections import deque


def t(label, f):
    try:
        print(label, repr(f()))
    except BaseException as e:
        print(label, type(e).__name__, str(e).split('\n')[0])


# A27
def construct(factory, *more):
    events = []

    class Source:
        def __iter__(self):
            events.append('iter')
            return iter([1, 2])
    factory(Source(), *more)
    return events


for name in ['groupby', 'pairwise', 'zip_longest']:
    t('constructor ' + name, lambda: construct(getattr(itertools, name)))
t('zip_longest two', lambda: construct(itertools.zip_longest, [3]))
for name in ['groupby', 'pairwise', 'zip_longest']:
    t('noniterable ' + name, lambda: getattr(itertools, name)(1) and 'accepted')
t('repeat float', lambda: itertools.repeat(1, 1.0) and 'accepted')
t('count step str', lambda: itertools.count(1, 'x') and 'accepted')
t('count start str', lambda: itertools.count('a') and 'accepted')
t('count float', lambda: list(itertools.islice(itertools.count(0.5, 0.25), 3)))
t('count complex', lambda: list(itertools.islice(itertools.count(1j), 2)))
t('count bool', lambda: list(itertools.islice(itertools.count(False, True), 3)))
t('groupby values', lambda: [(k, list(g)) for k, g in itertools.groupby('aabbbc')])
t('pairwise values', lambda: list(itertools.pairwise('abcd')))
t('zip_longest values', lambda: list(itertools.zip_longest('ab', 'xyz', fillvalue='-')))


# A28
def mutate(op, rev=False, first=1):
    d = deque([1, 2, 3])
    it = reversed(d) if rev else iter(d)
    got = [next(it) for _ in range(first)]
    op(d)
    try:
        got += list(it)
    except RuntimeError as e:
        got.append('RuntimeError: ' + str(e))
    # (after the error, the iterator is at its end)
    got.append(list(it))
    return got


ops = {
    'append': lambda d: d.append(4), 'appendleft': lambda d: d.appendleft(0),
    'pop': lambda d: d.pop(), 'popleft': lambda d: d.popleft(), 'clear': lambda d: d.clear(),
    'rotate0': lambda d: d.rotate(0), 'rotate1': lambda d: d.rotate(1), 'extend': lambda d: d.extend([5]),
    'extend empty': lambda d: d.extend([]), 'extendleft': lambda d: d.extendleft([5]),
    'reverse': lambda d: d.reverse(), 'reverse twice': lambda d: (d.reverse(), d.reverse()),
    'setitem': lambda d: d.__setitem__(2, 9), 'delitem': lambda d: d.__delitem__(0),
    'insert': lambda d: d.insert(1, 7), 'remove': lambda d: d.remove(3), 'imul1': lambda d: d.__imul__(1),
    'imul2': lambda d: d.__imul__(2), 'iadd': lambda d: d.__iadd__([8]), 'copy': lambda d: d.copy(),
    'nothing': lambda d: None,
}
for name, op in ops.items():
    t('iter ' + name, lambda: mutate(op))
    t('reversed ' + name, lambda: mutate(op, True))
t('iter none taken, append', lambda: mutate(ops['append'], False, 0))
t('length_hint', lambda: (lambda it: (it.__length_hint__(), next(it), it.__length_hint__()))(iter(deque('abc'))))
t('iter type', lambda: (type(iter(deque())).__name__, type(reversed(deque())).__name__, type(iter(deque())).__module__))
t('maxlen append', lambda: mutate(lambda d: d.append(9)) if False else (lambda d: (lambda it: (next(it), d.append(4), list(it)))(iter(d)))(deque([1, 2], maxlen=2)))
t('empty clear', lambda: (lambda d: (lambda it: (d.clear(), list(it)))(iter(d)))(deque()))
t('rotate one item', lambda: (lambda d: (lambda it: (d.rotate(5), list(it)))(iter(d)))(deque([1])))
t('maxlen 0 extend', lambda: (lambda d: (lambda it: (d.extend([1, 2]), list(it)))(iter(d)))(deque(maxlen=0)))


# A31
def eq_mutation(method, *args):
    d = deque()

    class Item:
        def __eq__(self, other):
            d.clear()
            return True
    d.extend([Item(), 42])
    try:
        r = getattr(d, method)(*args)
    except Exception as e:
        r = type(e).__name__ + ': ' + str(e)
    return r, list(d)


def eq_false_mutation(method, *args):
    d = deque()

    class Item:
        def __eq__(self, other):
            d.append(1)
            return False
    d.extend([Item(), 42])
    try:
        r = getattr(d, method)(*args)
    except Exception as e:
        r = type(e).__name__ + ': ' + str(e)
    return r, len(d)


for m in ['remove', 'count', 'index', '__contains__']:
    t('eq mutation ' + m, lambda: eq_mutation(m, None))
    t('eq false mutation ' + m, lambda: eq_false_mutation(m, None))
nan = float('nan')
t('identity first', lambda: (deque([nan]).count(nan), nan in deque([nan]), deque([nan]).index(nan), (lambda d: (d.remove(nan), len(d)))(deque([nan]))))
t('remove missing', lambda: deque([1]).remove(2))
t('index range', lambda: (deque('abcab').index('a', 1), deque('abcab').index('b', -2), deque('abcab').index('b', 0, -3)))
t('index missing', lambda: deque('abc').index('a', 1))
t('remove first', lambda: (lambda d: (d.remove(2), list(d)))(deque([1, 2, 3, 2])))


# A32
def min_keys(f):
    scale = [1]

    def gen():
        yield 1
        scale[0] = 0
        yield 2
    return f(gen(), key=lambda x: x * scale[0])


t('min key interleaving', lambda: min_keys(min))
t('max key interleaving', lambda: min_keys(max))


def precedence(f):
    def gen():
        yield 1
        raise ValueError('later iterator error')

    def key(x):
        raise TypeError('earlier key error')
    return f(gen(), key=key)


t('min precedence', lambda: precedence(min))
t('max precedence', lambda: precedence(max))


def compare_first(f):
    class K:
        def __init__(self, v):
            self.v = v

        def __lt__(self, o):
            raise TypeError('compared')
        __gt__ = __lt__

    def gen():
        yield K(1)
        yield K(2)
        raise ValueError('after')
    return f(gen())


t('min compares before the next item', lambda: compare_first(min))
t('max compares before the next item', lambda: compare_first(max))
t('min values', lambda: (min([3, 1, 2]), max('bca'), min([], default=0), min(3, 1, 2), max([1, 3, 3.0], key=int)))
t('min empty', lambda: min([]))
t('min ties first', lambda: (min([(1, 'a'), (1, 'b')], key=lambda p: p[0]), max([(1, 'a'), (1, 'b')], key=lambda p: p[0])))
t('min list mutated', lambda: (lambda l: min(l, key=lambda x: (l.append(0) if len(l) < 5 else None, x)[1]))([3, 2]))

# map strict, and zip's strict messages
add = lambda *a: sum(a)
for name, fn in (('map', lambda *a, **k: map(add, *a, **k)), ('zip', zip)):
    t(name + ' 2 shorter', lambda: list(fn([1, 2], [3], strict=True)))
    t(name + ' 2 longer', lambda: list(fn([1], [3, 4], strict=True)))
    t(name + ' 3 longer', lambda: list(fn([1], [3], [5, 6], strict=True)))
    t(name + ' 3 shorter', lambda: list(fn([1, 2], [3, 4], [5], strict=True)))
    t(name + ' 4 longer', lambda: list(fn([1], [3], [5], [6, 7], strict=True)))
    t(name + ' equal', lambda: list(fn([1, 2], [3, 4], strict=True)))
    t(name + ' not strict', lambda: list(fn([1, 2], [3], strict=False)))
    t(name + ' strict falsy', lambda: list(fn([1, 2], [3], strict=[])))
    t(name + ' unknown keyword', lambda: list(fn([1, 2], [3], foo=1)))
    t(name + ' two keywords', lambda: list(fn([1, 2], [3], strict=1, foo=1)))
t('map strict no iterables', lambda: map(add, strict=True))
t('map no iterables', lambda: map(add))
t('map one strict', lambda: list(map(add, [1], strict=True)))


class B:
    def __bool__(self):
        raise ValueError('bool')


t('map strict truth error', lambda: map(add, [1], strict=B()))
t('map noniterable strict', lambda: map(add, 1, strict=True))
t('map strict partial', lambda: (lambda m: (next(m), next(m, 'end')))(map(add, [1, 2], [3], strict=True)))
t('map shorter after', lambda: (lambda m: [next(m) for _ in range(1)] + [list(m)])(map(add, [1, 2], [3], strict=True)))
t('map strict error source', lambda: list(map(add, [1], (x for x in [1, 1 / 1, 2] if 1 / (x - 1 + 1)), strict=True)))

# iter() gives the iterator __iter__ returned, itself
class It:
    def __iter__(self):
        return self

    def __next__(self):
        raise StopIteration


class Src:
    def __iter__(self):
        return It()


class Bad:
    def __iter__(self):
        return 1


it = It()
t('iter is itself', lambda: (iter(it) is it, type(iter(Src())).__name__, type(iter(deque())).__name__))
t('iter non-iterator', lambda: iter(Bad()))
t('iter getitem', lambda: type(iter(type('G', (), {'__getitem__': lambda s, i: 1 / 0})())).__name__)
t('iter list', lambda: (type(iter([])).__name__, type(iter('')).__name__, type(iter({})).__name__, type(iter(x for x in ())).__name__))
