# type.__call__ when __new__ returns another object: an instance of cls or of
# a subclass is initialized by type(obj).__init__, anything else not at all
# (compared with CPython 3.14 by test/sortedcontainers-blockers.test.ts)


def show(f):
    try:
        print(repr(f()))
    except Exception as e:
        print(type(e).__name__, e)


class A:
    def __new__(cls, x=None, key=None):
        return object.__new__(cls) if key is None else object.__new__(B)
    def __init__(self, x=None):
        self.where = "A"
class B(A):
    def __init__(self, x=None, key=None):
        self.where = "B"
        self.key = key
show(lambda: (lambda b: (type(b).__name__, b.where, b.key))(A(1, key=abs)))
show(lambda: (lambda b: (type(b).__name__, b.where, b.key))(A(1, abs)))
show(lambda: (lambda a: (type(a).__name__, a.where))(A(1)))
show(lambda: (lambda b: (type(b).__name__, b.where))(B(1)))

# not an instance of cls: no __init__ at all
class Other:
    def __init__(self, *a, **k):
        print("Other.__init__", a, k)
class C:
    def __new__(cls, *a, **k):
        return Other.__new__(Other)
    def __init__(self, *a, **k):
        print("C.__init__ called")
show(lambda: type(C(1, k=2)).__name__)
show(lambda: type(C()).__name__)
class D:
    def __new__(cls, *a, **k):
        return 42
    def __init__(self, *a, **k):
        print("D.__init__ called")
show(lambda: D(1, k=2))

# a subclass without its own __init__: object.__init__ with arguments, which
# CPython allows when __new__ is overridden
class E:
    def __new__(cls, *a, **k):
        return object.__new__(F)
class F(E):
    pass
show(lambda: type(E(1, k=2)).__name__)
class G:
    def __new__(cls, *a, **k):
        return object.__new__(H)
class H(G):
    def __init__(self):
        self.ok = True
show(lambda: E.__new__(E).__class__.__name__)
# (the arity error's type only: this runtime's message names the function
# without its class, "__init__()" for CPython's "H.__init__()")
try:
    G(1)
except TypeError:
    print("TypeError")
show(lambda: G().ok)

# the subclass's __init__ returning something is still a TypeError
class I:
    def __new__(cls, *a):
        return object.__new__(J)
class J(I):
    def __init__(self, *a):
        return 1
show(lambda: I(1))

# an instance of cls's own type, exactly, keeps cls's __init__
class K:
    made = None
    def __new__(cls, *a):
        K.made = K.made or object.__new__(cls)
        return K.made
    def __init__(self, *a):
        self.n = getattr(self, "n", 0) + 1
show(lambda: (K(), K(), K.made.n)[2])

# a subclass's __init__ with keyword-only parameters, called with keywords
class L:
    def __new__(cls, *a, **k):
        return object.__new__(M) if k else object.__new__(cls)
class M(L):
    def __init__(self, *a, key, reverse=False):
        self.key, self.reverse = key, reverse
show(lambda: (lambda m: (type(m).__name__, m.key, m.reverse))(L(key=len, reverse=True)))
try:
    L(nokey=1)
except TypeError:
    print("TypeError")

# sortedcontainers' pattern: SortedList(iterable, key=f) is a SortedKeyList
class SortedList:
    def __new__(cls, iterable=None, key=None):
        if key is None:
            return object.__new__(cls)
        if cls is SortedList:
            return object.__new__(SortedKeyList)
        raise TypeError("inherit SortedKeyList for key argument")
    def __init__(self, iterable=None, key=None):
        self._list = sorted(iterable or [])
class SortedKeyList(SortedList):
    def __init__(self, iterable=None, key=lambda x: x):
        self._key = key
        self._list = sorted(iterable or [], key=key)
show(lambda: (lambda s: (type(s).__name__, s._list))(SortedList([3, -5, 1], key=abs)))
show(lambda: (lambda s: (type(s).__name__, s._list))(SortedList([3, -5, 1])))
show(lambda: (lambda s: (type(s).__name__, s._list))(SortedKeyList([3, -5, 1], key=abs)))
