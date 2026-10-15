# types.MappingProxyType and a class's __dict__ (read-only views), str.translate
# and str.maketrans, an iterator's type, as CPython 3.14 (test/stdlib-small.test.ts).
import types
class A:
    x = 1
d = A.__dict__
print(type(d).__name__, d["x"], "x" in d, d.get("zz", 5), len(d) > 0, isinstance(d, dict))
for f in (lambda: d.__setitem__("y", 2), lambda: types.MappingProxyType([1]), lambda: hash(types.MappingProxyType({}))):
    try:
        f()
    except Exception as e:
        print(type(e).__name__, e)
m = types.MappingProxyType({"a": 1, "b": 2})
print(m, repr(m), m["a"], list(m), list(m.items()), m.copy(), m == {"a": 1, "b": 2}, m | {"c": 3}, {"z": 0} | m, list(reversed(m)), str(m))
import collections.abc
print(isinstance(m, collections.abc.Mapping), isinstance(m, collections.abc.MutableMapping))
try:
    m["q"] = 1
except TypeError as e:
    print("TypeError", e)
for a in ((), ({'a':1,'b':'x','c':None},), ({1:2},), ('ab','xy'), ('ab','xy','z'), ({'ab':1},), ('a','xy'), (1,), ({(1,):2},), ('a',2), ('ab','cd',3)):
    try: print(a, str.maketrans(*a))
    except Exception as e: print(a, type(e).__name__, e)
print('abc'.maketrans('a','b'))
for tbl in ({97: None, 98: 'XY', 99: 100}, {97: 0x110000}, {97: 1.5}, str.maketrans('', '', 'aeiou'), [None] * 99 + ['Z'], {97: [1]}, {'a': 'b'}):
    try:
        print(repr("abcabc".translate(tbl)))
    except Exception as e:
        print(type(e).__name__, e)
class T:
    def __getitem__(self, k):
        if k == 98: raise LookupError
        return k + 1
print(repr("abc".translate(T())), "héllo wörld".translate(str.maketrans("éö", "eo")))
print(type(iter(range(1 << 1000))).__name__, type(iter(range(5))).__name__)
