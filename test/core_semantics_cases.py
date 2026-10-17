# sage2's core-semantics findings, compared with CPython by
# test/core-semantics.test.ts
import pickle, datetime


def show(label, f):
    try:
        r = repr(f())
    except Exception as e:
        r = f'{type(e).__name__}: {e}'
    print(label, r)


# 1. a str subclass's __eq__ through str.__eq__
class K(str):
    def __eq__(s, o): return str.__eq__(s, o)
    __hash__ = str.__hash__


show('K == str', lambda: K('ab') == 'ab')
show('str == K', lambda: 'ab' == K('ab'))
show('str.__eq__(K)', lambda: str.__eq__(K('ab'), 'ab'))
show('str.__eq__ other', lambda: str.__eq__(K('ab'), 1))
show('str.__ne__(K)', lambda: str.__ne__(K('ab'), 'ab'))
show('str.__lt__(K)', lambda: str.__lt__(K('ab'), 'b'))
show('K in dict', lambda: {'ab': 1}[K('ab')])
show('K == K', lambda: K('ab') == K('ab'))


class K2(str):
    def __eq__(s, o): return super().__eq__(o)
    __hash__ = str.__hash__


show('K2 == str', lambda: K2('ab') == 'ab')


# 2. __slots__ without __dict__
class C:
    __slots__ = ('_k',)


def setfoo():
    c = C()
    c.foo = 1


show('slots set', setfoo)
show('slots hasattr dict', lambda: hasattr(C(), '__dict__'))
show('slots in vars', lambda: '__dict__' in vars(C))
show('slots set slot', lambda: (lambda c: (setattr(c, '_k', 2), c._k)[1])(C()))
show('slots unset slot', lambda: C()._k)


class C2(C):
    pass


show('subclass has dict', lambda: hasattr(C2(), '__dict__'))


class C3(C):
    __slots__ = ('x',)


def setfoo3():
    c = C3()
    c.foo = 1


show('sub slots set', setfoo3)


class C4:
    __slots__ = ('__dict__', 'a')


show('slots with __dict__', lambda: (lambda c: (setattr(c, 'z', 1), c.z, c.__dict__)[1:])(C4()))
show('date dict', lambda: hasattr(datetime.date(2020, 1, 1), '__dict__'))
show('date set', lambda: setattr(datetime.date(2020, 1, 1), 'foo', 1))


# 3. pickling methods and builtins
class M:
    @classmethod
    def f(cls): return cls

    def g(self): return 1


def pk(x, proto):
    b = pickle.dumps(x, proto)
    return (len(b), b.hex())


for proto in (0, 2, 4, 5):
    show(f'pickle classmethod p{proto}', lambda: pk(M.f, proto))
    show(f'pickle getattr p{proto}', lambda: pk(getattr, proto))
    show(f'pickle len p{proto}', lambda: pk(len, proto))
    show(f'pickle str.join p{proto}', lambda: pk(str.join, proto))
    show(f'pickle dict.fromkeys p{proto}', lambda: pk(dict.fromkeys, proto))
    show(f'pickle bound method p{proto}', lambda: pk(M().g, proto))
show('roundtrip classmethod', lambda: pickle.loads(pickle.dumps(M.f)) is not None and pickle.loads(pickle.dumps(M.f))() is M)
show('reduce classmethod', lambda: M.f.__reduce__())
show('reduce str.join', lambda: str.join.__reduce__())
show('reduce dict.fromkeys', lambda: dict.fromkeys.__reduce__())
show('reduce len', lambda: len.__reduce__())

# 4. messages
show('unhashable key', lambda: {[1]: 2})
show('unhashable setitem', lambda: {}.__setitem__([1], 2))


class X:
    @property
    def key(self): return 1


show('property no setter', lambda: setattr(X(), 'key', 2))
show('property no deleter', lambda: delattr(X(), 'key'))
show('date attr', lambda: datetime.date(2020, 1, 1).nope)
show('PicklingError module', lambda: pickle.PicklingError.__module__)
show('UnpicklingError module', lambda: pickle.UnpicklingError.__module__)


class X2:
    p2 = property(lambda s: 1)

    @property
    def k(self): return 1

    @k.setter
    def k(self, v): pass

    class Inner:
        @property
        def q(self): return 1


show('property lambda named', lambda: setattr(X2(), 'p2', 1))
show('property kept name', lambda: delattr(X2(), 'k'))
show('property nested qualname', lambda: setattr(X2.Inner(), 'q', 1))
show('property __name__', lambda: (X2.__dict__['p2'].__name__, X2.__dict__['k'].__name__))
show('property unnamed', lambda: property().__set__(X2(), 1))
show('property no getter', lambda: property(None, lambda s, v: None).__get__(X2()))


class BadHash:
    def __hash__(self): raise TypeError('nope')


class BadHash2:
    def __hash__(self): raise ValueError('nope')


show('dict literal', lambda: {[1]: 2})
show('dict getitem', lambda: {}[[1]])
show('dict in', lambda: [1] in {1: 2})
show('dict get', lambda: {}.get([1]))
show('dict pop', lambda: {}.pop([1]))
show('dict fromkeys', lambda: dict.fromkeys([[1]]))
show('set literal', lambda: {[1]})
show('set add', lambda: set().add([1]))
show('in set', lambda: [1] in {1})
show('frozenset', lambda: frozenset([[1]]))
show('set discard', lambda: set().discard([1]))
show('hash', lambda: hash([1]))
show('dict user TypeError', lambda: {BadHash(): 1})
show('dict user ValueError', lambda: {BadHash2(): 1})
show('set user TypeError', lambda: {BadHash()})
import pickle
class S:
    __slots__ = ("a", "b")
class D(S):
    pass
s = S(); s.a = 1
d = D(); d.a = 2; d.x = 3
print(s.__getstate__(), d.__getstate__(), S().__getstate__())
r = pickle.loads(pickle.dumps(s)); print(r.a, hasattr(r, "b"))
r = pickle.loads(pickle.dumps(d, 4)); print(r.a, r.x)
print(pickle.dumps(s, 4).hex())
try: s.__reduce_ex__(1)
except TypeError as e: print(e)

# astra's HOLD on d77a5fe1: a subclass's slot of a base slot's name is
# another slot (CORR-D77-1)
class SA:
    __slots__ = ('x',)
class SB(SA):
    __slots__ = ('x',)
sb = SB()
SA.x.__set__(sb, 1); SB.x.__set__(sb, 2)
print(SA.x.__get__(sb), SB.x.__get__(sb))
SB.x.__delete__(sb); print(SA.x.__get__(sb), hasattr(sb, 'x'))
try: SB.x.__get__(sb)
except AttributeError as e: print('AttributeError', e)
# a str subclass key hashed once per operation (CORR-D77-2)
calls = []
class HKey(str):
    def __hash__(self):
        calls.append('hash')
        return str.__hash__(self)
    __eq__ = str.__eq__
dd = {'x': 7}
for op in (lambda: dd[HKey('x')], lambda: HKey('x') in dd, lambda: dd.get(HKey('x')), lambda: dd.setdefault(HKey('x'), 1), lambda: dd.pop(HKey('x')), lambda: dd.pop(HKey('y'), 0)):
    calls.clear(); print(op(), calls)
# the dunders builtin types define as methods (CORR-D77-3)
for c, name in [(dict, '__getitem__'), (dict, '__contains__'), (list, '__getitem__'), (set, '__contains__'), (frozenset, '__contains__'), (str, '__contains__'), (int, '__add__'), (dict, 'get'), (list, '__setitem__')]:
    print(c.__name__, name, type(getattr(c, name)).__name__)
# BlockingIOError.characters_written: an index-sized integer, -1 unset (CORR-D77-5)
for args in [(11, 'm', -1), (11, 'm', -2), (11, 'm', 0), (11, 'm', 2**63 - 1), (11, 'm', 2**63), (11, 'm', -2**63), (11, 'm', -2**63 - 1)]:
    try:
        e = BlockingIOError(*args)
        print(args[2], e.characters_written)
    except (AttributeError, ValueError) as x:
        print(args[2], type(x).__name__, x)
e = BlockingIOError(11, 'm')
for v in (2**63, 2**63 - 1, -1):
    try:
        e.characters_written = v
        print('set', v, e.characters_written)
    except (AttributeError, ValueError) as x:
        print('set', v, type(x).__name__, x)
