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

# list's own __imul__ is its sequence slot: a subclass's __mul__ first, then in place
class LN(list):
    def __mul__(self, o):
        return NotImplemented
a = LN([1, 2]); b = a
a *= 2
print(a, b, a is b, type(a).__name__)
class M(list):
    def __mul__(self, o):
        return 'm'
    def __imul__(self, o):
        return 'im'
a = M([1]); a *= 3; print(a)
a = [1]; b = a; a *= 2; print(a, b is a, [].__imul__(2))

# list *= n: an index-sized integer, refused past it before anything is
# made; empty lists and n below 1 at once (daybreak2's LIMIT-COL-1)
class Huge:
    def __index__(self):
        return 10**100


def rep(f):
    try:
        r = f()
        return repr(r)[:40]
    except Exception as e:
        return type(e).__name__ + ': ' + str(e)


def iadd_huge():
    l = [1]
    l *= 10**100
    return l


for label, f in [('empty imul huge', lambda: [].__imul__(10**100)), ('imul huge', lambda: [1].__imul__(10**100)),
                 ('imul -huge', lambda: [1].__imul__(-10**100)), ('empty imul Huge', lambda: [].__imul__(Huge())),
                 ('imul Huge', lambda: [1].__imul__(Huge())), ('imul 2**63', lambda: [1, 2].__imul__(2**63)),
                 ('imul 2**63-1', lambda: [1, 2].__imul__(2**63 - 1)), ('empty imul 2**63-1', lambda: [].__imul__(2**63 - 1)),
                 ('*= huge', iadd_huge), ('empty * 2**62', lambda: [] * 2**62), ('mul huge', lambda: [1] * 10**100),
                 ('imul 0', lambda: [1, 2].__imul__(0)), ('imul -3', lambda: [1, 2].__imul__(-3)), ('imul 1', lambda: [1, 2].__imul__(1)),
                 ('imul 3', lambda: [1, 2].__imul__(3)), ('tuple * 2**62', lambda: () * 2**62)]:
    print(label, rep(f))
def ba_imul_huge():
    b = bytearray(b'a')
    b *= 10**100
    return b


for label, f in [('str * huge', lambda: 'ab' * 10**100), ('bytes * huge', lambda: b'ab' * 10**100), ('huge * tuple', lambda: 10**100 * (1,)),
                 ('str * -huge', lambda: 'ab' * -10**100), ('empty str * 2**62', lambda: '' * 2**62), ('bytearray *= huge', ba_imul_huge)]:
    print(label, rep(f))


# astra's HOLD on 72be72fe: the count converted before the list is read
# (CORR-72B-1); the right operand's __rmul__ before list's in-place
# repeat (CORR-72B-2); no repeat for a subtype whose __mul__ declines, and
# no second call of it (CORR-72B-3); index-sized counts for custom
# indexes and deque.rotate and insert (CORR-72B-4)
def hooked(action, explicit):
    a = [1]

    class I:
        def __index__(self):
            if action == 'append':
                a.append(2)
            elif action == 'clear':
                a.clear()
            elif action == 'replace':
                a[:] = [7, 8, 9]
            elif action == 'raise':
                a.append(5)
                raise ValueError('index')
            return 2
    try:
        if explicit:
            r = list.__imul__(a, I())
        else:
            b = a
            b *= I()
            r = b
        return r, r is a, a
    except ValueError as e:
        return 'ValueError', a


for action in ('append', 'clear', 'replace', 'raise'):
    for explicit in (False, True):
        print('index hook', action, explicit, hooked(action, explicit))
events = []


class R:
    def __rmul__(self, other):
        events.append('rmul')
        return 'reflected'

    def __index__(self):
        events.append('index')
        return 2


def rimul():
    a = [1]
    a *= R()
    return a


print('rmul first', rep(rimul), rep(lambda: [1] * R()), rep(lambda: list.__imul__([1], R())), events)


class I2:
    def __index__(self):
        return 2


class S(str):
    def __mul__(self, x):
        return NotImplemented


class B(bytes):
    def __mul__(self, x):
        return NotImplemented


calls = []


class L(list):
    def __mul__(self, n):
        calls.append(type(n).__name__)
        return 'called again' if len(calls) > 1 else NotImplemented


class T2(tuple):
    def __mul__(self, n):
        calls.append(('T2', type(n).__name__))
        return NotImplemented


class LR(list):
    def __rmul__(self, n):
        return NotImplemented


def l_imul():
    a = L([1])
    a *= I2()
    return a, type(a).__name__


def t_imul():
    a = T2((1,))
    a *= I2()
    return a


for label, f in [('str subtype declines', lambda: S('a') * I2()), ('str subtype declines r', lambda: I2() * S('a')),
                 ('bytes subtype declines', lambda: B(b'a') * I2()), ('list subtype declines', lambda: L([1]) * I2()),
                 ('list subtype declines r', lambda: I2() * L([1])), ('tuple subtype declines', lambda: T2((1,)) * I2()),
                 ('list subtype imul', l_imul), ('tuple subtype imul', t_imul), ('list rmul declines', lambda: 3 * LR([1])),
                 ('list rmul declines l', lambda: LR([1]) * 3), ('str * I2', lambda: 'ab' * I2()), ('I2 * tuple', lambda: I2() * (1, 2))]:
    print(label, rep(f), calls)
    calls.clear()


class Neg:
    def __index__(self):
        return -2**63 - 1


class Edge:
    def __index__(self):
        return -2**63


class Big:
    def __index__(self):
        return 2**63


def neg_imul(n):
    a = [1]
    a *= n
    return a


for label, f in [('imul -2**63-1', lambda: neg_imul(Neg())), ('imul -2**63', lambda: neg_imul(Edge())), ('explicit -2**63-1', lambda: list.__imul__([1], Neg())),
                 ('rotate 2**63', lambda: deque([1, 2]).rotate(Big())), ('rotate -2**63-1', lambda: deque([1, 2]).rotate(Neg())),
                 ('rotate -2**63', lambda: (lambda d: (d.rotate(Edge()), list(d)))(deque([1, 2]))), ('insert 2**63', lambda: deque([1]).insert(Big(), 0)),
                 ('rotate int 2**63', lambda: deque([1, 2]).rotate(2**63))]:
    print(label, rep(f))


# Multiplication of each kind of sequence, by each kind of count, as
# CPython's dispatch: the numeric methods, then the sequence's repeat
# (astra's CORR-72B-2 and CORR-72B-3)
mlog = []
class I2:
    def __index__(self):
        mlog.append('I2.index')
        return 2


class R:
    def __rmul__(self, o):
        mlog.append('R.rmul')
        return 'reflected'

    def __mul__(self, o):
        mlog.append('R.mul')
        return 'R.mul'

    def __index__(self):
        mlog.append('R.index')
        return 2


class L2(list):
    pass


class LM(list):
    def __mul__(self, n):
        mlog.append('LM.mul')
        return NotImplemented


class LR(list):
    def __rmul__(self, n):
        mlog.append('LR.rmul')
        return NotImplemented


class LMR(list):
    def __mul__(self, n):
        mlog.append('LMR.mul')
        return NotImplemented

    def __rmul__(self, n):
        mlog.append('LMR.rmul')
        return NotImplemented


class SM(str):
    def __mul__(self, n):
        mlog.append('SM.mul')
        return NotImplemented


class SR(str):
    def __rmul__(self, n):
        mlog.append('SR.rmul')
        return NotImplemented


class S2(str):
    pass


class TM(tuple):
    def __mul__(self, n):
        mlog.append('TM.mul')
        return NotImplemented


class T3(tuple):
    pass


class B2(bytes):
    pass


class BM(bytes):
    def __mul__(self, n):
        mlog.append('BM.mul')
        return NotImplemented


def mshow(f):
    mlog.clear()
    try:
        r = f()
        r = repr(r)
    except Exception as e:
        r = type(e).__name__ + ': ' + str(e)
    return r + ' ' + str(mlog)


seqs = [('list', lambda: [1]), ('L2', lambda: L2([1])), ('LM', lambda: LM([1])), ('LR', lambda: LR([1])), ('LMR', lambda: LMR([1])),
        ('str', lambda: 'a'), ('S2', lambda: S2('a')), ('SM', lambda: SM('a')), ('SR', lambda: SR('a')),
        ('tuple', lambda: (1,)), ('T3', lambda: T3((1,))), ('TM', lambda: TM((1,))),
        ('bytes', lambda: b'a'), ('B2', lambda: B2(b'a')), ('BM', lambda: BM(b'a')), ('bytearray', lambda: bytearray(b'a'))]
nums = [('int', lambda: 2), ('I2', lambda: I2()), ('R', lambda: R())]


def mimul(s, n):
    x = s
    x *= n
    return x


for sn, s in seqs:
    for nn, n in nums:
        print(sn, nn, 'mul', mshow(lambda: s() * n()))
        print(sn, nn, 'rmul', mshow(lambda: n() * s()))
        print(sn, nn, 'imul', mshow(lambda: mimul(s(), n())))


# a builtin sequence's own __mul__, __rmul__ and __imul__ called itself:
# its slot's wrapper, an index count or a TypeError, never NotImplemented
for label, f in [('list.__mul__ float', lambda: [1].__mul__(1.5)), ('list.__rmul__ float', lambda: [1].__rmul__(1.5)), ('str.__mul__ float', lambda: 'a'.__mul__(1.5)),
                 ('tuple.__mul__ float', lambda: (1,).__mul__(1.5)), ('bytes.__mul__ float', lambda: b'a'.__mul__(1.5)), ('list.__mul__ I2', lambda: [1].__mul__(I2())),
                 ('str.__rmul__ I2', lambda: 'a'.__rmul__(I2())), ('list.__mul__ 2**63', lambda: [1].__mul__(2**63)), ('list.__imul__ float', lambda: [1].__imul__(1.5)),
                 ('bytearray.__mul__ I2', lambda: bytearray(b'a').__mul__(I2())), ('bytes.__rmul__ -1', lambda: b'ab'.__rmul__(-1)), ('tuple.__rmul__ 2', lambda: (1,).__rmul__(2)),
                 ('list *= float', lambda: mimul([1], 1.5)), ('list.__mul__ Big', lambda: [1].__mul__(Big()))]:
    print(label, mshow(f))


# A builtin's own descriptor reassigned in a class body (`__mul__ =
# list.__mul__`) keeps the sequence repeat, the right operand's __rmul__
# first (astra's CORR-57F-1); repeat()'s argument errors in CPython's order
from itertools import repeat

events = []


class R:
    def __rmul__(self, left):
        events.append('rmul')
        return 'reflected'

    def __index__(self):
        events.append('index')
        return 2


class RN:
    def __rmul__(self, left):
        events.append('rmul')
        return 'reflected'


class LM(list):
    __mul__ = list.__mul__


class LR(list):
    __rmul__ = list.__rmul__


class SM(str):
    __mul__ = str.__mul__


class TM(tuple):
    __mul__ = tuple.__mul__


class BM(bytes):
    __mul__ = bytes.__mul__


class LI(list):
    __imul__ = list.__imul__


def show(f):
    events.clear()
    try:
        r = repr(f())
    except Exception as e:
        r = type(e).__name__ + ': ' + str(e)
    return r + ' ' + str(events)


def imul(a, b):
    a *= b
    return a


for name, mk in [('LM', lambda: LM([1])), ('LR', lambda: LR([1])), ('SM', lambda: SM('a')), ('TM', lambda: TM((1,))), ('BM', lambda: BM(b'a')), ('LI', lambda: LI([1]))]:
    for rn, r in [('R', R), ('RN', RN), ('int', lambda: 2)]:
        print(name, rn, 'mul', show(lambda: mk() * r()))
        print(name, rn, 'rmul', show(lambda: r() * mk()))
        print(name, rn, 'imul', show(lambda: imul(mk(), r())))
print(show(lambda: LM.__mul__(LM([1]), R())), show(lambda: LM.__mul__(LM([1]), 1.5)))
for f in [lambda: repeat(bad=1), lambda: repeat(1, bad=1), lambda: repeat(1, 2, bad=1), lambda: repeat(object=1, bad=1), lambda: repeat()]:
    print(show(f))


# bytearray *= n in place, as CPython's bytearray_irepeat; bytes past an
# index-sized length
class I2:
    def __index__(self):
        return 2


def show(f):
    try:
        return repr(f())
    except Exception as e:
        return type(e).__name__ + ': ' + str(e)


def imul(b, n):
    a = b
    a *= n
    return a, a is b, b


class BA(bytearray):
    pass


for label, mk, n in [('ba 2', lambda: bytearray(b'ab'), 2), ('ba I2', lambda: bytearray(b'ab'), I2()), ('ba 0', lambda: bytearray(b'ab'), 0), ('ba -1', lambda: bytearray(b'ab'), -1),
                     ('ba 1', lambda: bytearray(b'ab'), 1), ('empty 5', lambda: bytearray(), 5), ('BA 3', lambda: BA(b'x'), 3), ('ba float', lambda: bytearray(b'a'), 1.5),
                     ('ba 2**63', lambda: bytearray(b'a'), 2**63), ('ba huge', lambda: bytearray(b'a'), 2**62)]:
    print(label, show(lambda: imul(mk(), n)))
print(show(lambda: bytearray(b'a').__imul__(1.5)), show(lambda: bytearray(b'a').__imul__(I2())))
print(show(lambda: b'ab' * 2**62), show(lambda: bytearray(b'ab') * 2**62))


# Repeat lengths near Py_ssize_t, the count exact (sys.maxsize is not
# 2**63): MemoryError or OverflowError as CPython's, before anything is
# made (daybreak2's LIMIT-51B-2)
import sys


class I:
    def __init__(self, v):
        self.v = v

    def __index__(self):
        return self.v


def lshow(f):
    try:
        r = f()
        return type(r).__name__ + ' ' + str(len(r))
    except Exception as e:
        return type(e).__name__ + ': ' + str(e)


def limul(a, n):
    a *= n
    return a


M = sys.maxsize
for n in [M, M // 2, M // 2 + 1, M // 3, M // 3 + 1, 2**53, 2**53 + 1]:
    for seq in [b'a', b'ab', b'abc', 'a', 'ab', 'abc', '\U0001f600', [1], [1, 2], (1,), (1, 2)]:
        # (bytearray by its in-place rows and those under an export: CPython
        # 3.14.8 reports a spurious SystemError for some of its huge repeats)
        print(repr(seq), n, lshow(lambda: seq * n), lshow(lambda: n * seq), lshow(lambda: seq * I(n)), lshow(lambda: type(seq).__mul__(seq, n)))
    for mk in [lambda: bytearray(b'a'), lambda: bytearray(b'ab'), lambda: [1, 2], lambda: bytearray()]:
        print('imul', repr(mk()), n, lshow(lambda: limul(mk(), n)), lshow(lambda: mk().__imul__(n)))
print(lshow(lambda: b'' * M), lshow(lambda: '' * M), lshow(lambda: [] * M), lshow(lambda: limul(bytearray(), M)))


# (daybreak2's LIMIT-51B-1)
import binascii

# bytearray *= n while its buffer is exported (binascii.b2a_base64 holds it
# while newline's __bool__ runs): a resize is refused before anything is
# made, the count converted first; a size it keeps is allowed


class I:
    def __init__(self, v, log):
        self.v, self.log = v, log

    def __index__(self):
        self.log.append(('index', self.v))
        return self.v


def under_export(n, data=b'ab', direct=False):
    b = bytearray(data)
    log = []

    class NL:
        def __bool__(self):
            try:
                if direct:
                    b.__imul__(I(n, log))
                else:
                    x = b
                    x *= I(n, log)
                log.append(('ok', bytes(b)))
            except Exception as e:
                log.append((type(e).__name__, str(e)))
            return False

    binascii.b2a_base64(b, newline=NL())
    return log, bytes(b)


for n in [2, 0, 1, -1, 2**40, sys.maxsize, sys.maxsize // 2 + 1, 2**63]:
    print(n, under_export(n), under_export(n, direct=True))
print(under_export(5, b''), under_export(sys.maxsize, b''))
