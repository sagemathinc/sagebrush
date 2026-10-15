# collections.abc (CPython's _collections_abc), UserDict, UserList, UserString,
# ChainMap and a deque's registration, as CPython 3.14 (test/stdlib-small.test.ts).
import _collections_abc as A
print(A.__name__, len(A.__all__))
class M(A.MutableMapping):
    def __init__(self): self.d = {}
    def __getitem__(self, k): return self.d[k]
    def __setitem__(self, k, v): self.d[k] = v
    def __delitem__(self, k): del self.d[k]
    def __iter__(self): return iter(self.d)
    def __len__(self): return len(self.d)
m = M(); m.update(a=1, b=2); print(m.get("a"), sorted(m.keys()), m.pop("b"), dict(m.items()), isinstance(m, A.Mapping))
print(isinstance([], A.Sequence), isinstance({}, A.Mapping), isinstance("", A.Sequence), isinstance((), A.Hashable), isinstance([], A.Hashable))
class S:
    def __getitem__(self, i): return i
    def __len__(self): return 3
print(isinstance(S(), A.Sequence), isinstance(S(), A.Sized), isinstance(iter([]), A.Iterator), isinstance({}.keys(), A.KeysView))
import collections, collections.abc
from collections.abc import Mapping, Sequence, MutableMapping
from collections import UserDict, UserList, UserString
print(collections.abc.__name__, collections.abc is collections.abc, Mapping.__module__)
u = UserDict(a=1); u["b"] = 2
print(u, isinstance(u, dict), isinstance(u, Mapping), u.data, repr(u), u | {"c": 3}, len(u), u.get("z", 0))
l = UserList([3, 1, 2]); l.sort(); l.append(9)
print(l, isinstance(l, list), isinstance(l, Sequence), l[1:], l + [0], l * 2, l.data)
s = UserString("hello")
print(s.upper(), s[1:3], isinstance(s, str), s + "!", repr(s), len(s), s.find("l"), "ell" in s)
class D(UserDict):
    def __missing__(self, k): return k * 2
print(D()["ab"])
print(isinstance([], collections.abc.MutableSequence), isinstance({}.keys(), collections.abc.Set), issubclass(collections.OrderedDict, MutableMapping), isinstance(collections.deque(), collections.abc.MutableSequence))
import collections
c = collections.ChainMap({"a": 1}, {"b": 2, "a": 9})
print(c["a"], c["b"], len(c), sorted(c), c.get("z"), dict(c), "a" in c, repr(c), c.new_child({"z": 0})["z"], list(c.parents.maps))
c["q"] = 5
print(c.maps, c.pop("q"), c.maps)
c.update(x=1)
print(c.maps[0], c.setdefault("y", 3), list(c.items()), c.keys() == {"a","b","x","y"})
