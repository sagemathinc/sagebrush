# astra3's sweep A15-A21 (and A29, A30: CPython's Counter): Counter's equality,
# most_common and in-place operators, deque's index arguments, sequence
# repetition and list *= through __index__, itertools.repeat's count;
# compared with CPython by test/collections-fixes.test.ts
from collections import deque
from itertools import repeat
class Index:
    def __index__(self): return 2
class Bad:
    def __index__(self): return 'x'
def t(l, f):
    try: print(l, repr(f()))
    except Exception as e: print(l, type(e).__name__, e)
t('index None', lambda: deque([1,2,3]).index(2, None))
t('index float', lambda: deque([1,2,3]).index(2, 1.0))
t('index stop Index', lambda: deque([1,2,3]).index(2, 0, Index()))
t('index stop None', lambda: deque([1,2,3]).index(2, 0, None))
t('index bad', lambda: deque([1,2,3]).index(2, Bad()))
t('list index Index', lambda: [1,2,3].index(2, 0, Index()))
t('list index None', lambda: [1,2,3].index(2, None))
t('list index float', lambda: [1,2,3].index(2, 1.0))
t('insert float full', lambda: deque([1], maxlen=1).insert(0.0, 2))
t('insert None full', lambda: deque([1], maxlen=1).insert(None, 2))
t('insert Bad full', lambda: deque([1], maxlen=1).insert(Bad(), 2))
t('insert full', lambda: deque([1], maxlen=1).insert(0, 2))
t('insert Index', lambda: (lambda d: (d.insert(Index(), 9), list(d))[1])(deque([1,2,3])))
t('list * Index', lambda: [1] * Index())
t('Index * list', lambda: Index() * [1])
t('deque * Index', lambda: list(deque([1]) * Index()))
t('tuple * Index', lambda: (1,) * Index())
t('str * Index', lambda: 'a' * Index())
t('list *= Index', lambda: (lambda l: (l.__imul__(Index()), l)[1])([1]))
t('list * float', lambda: [1] * 2.0)
t('rotate Index', lambda: (lambda d: (d.rotate(Index()), list(d))[1])(deque([1,2,3])))
t('rotate float', lambda: deque([1,2,3]).rotate(1.0))
t('rotate None', lambda: deque([1,2,3]).rotate(None))
t('repeat None', lambda: next(repeat(7, None)))
t('repeat neg', lambda: list(repeat(7, -1)))
t('repeat float', lambda: repeat(7, 1.0))
t('repeat Index', lambda: list(repeat(7, Index())))
t('repeat kw', lambda: list(repeat(7, times=2)))
t('repeat repr', lambda: (repr(repeat(7)), repr(repeat(7, 2))))
t('repeat len', lambda: repeat(7, 2).__length_hint__())
from collections import Counter
t('counter eq zero', lambda: (Counter(a=0) == Counter(), Counter(a=0) != Counter(), Counter(a=1, b=0) == Counter(a=1)))
t('most_common 1.0', lambda: Counter(a=1, b=2).most_common(1.0))
t('most_common', lambda: (Counter('abracadabra').most_common(3), Counter('abc').most_common()))
c = Counter(a=1); alias = c
c += Counter(a=2); t('iadd alias', lambda: (c is alias, c))
c -= Counter(a=1); t('isub alias', lambda: (c is alias, c))
c &= Counter(a=1, b=3); t('iand alias', lambda: (c is alias, c))
c2 = Counter(a=5, b=-1); c2 |= Counter(a=2, c=1); t('ior', lambda: c2)
t('counter repr', lambda: (repr(Counter()), repr(Counter(a=1)), Counter(a=2, b=1) <= Counter(a=3, b=1)))
t('list * float', lambda: [1] * 2.0)
t('list * list', lambda: [1] * [2])
t('str * Bad', lambda: 'a' * Bad())
a = [1]; b = a; a *= 2; print(b, a is b)
t = (1,); u = t; t *= 2; print(u, t)
from collections import deque
d = deque([1]); e = d; d *= 2; print(e, d is e)
print(hasattr([], "__imul__"), hasattr([], "__iadd__"))
class I:
    def __index__(self): return 3
a = [1]; b = a; a *= I(); print(b)
