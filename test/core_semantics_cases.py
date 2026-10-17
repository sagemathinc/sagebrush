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
