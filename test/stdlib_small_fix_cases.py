# Astra's CORR-978-1..3 and the operator fast paths they led to, against
# CPython: mappingproxy delegates | and comparisons to its mapping;
# translate/maketrans take int and str subclasses; UserString.maketrans is
# static; a set or dict subclass's own operators are used; |= on a
# frozenset makes a new one.
from types import MappingProxyType
from collections import UserString


class D(dict):
    def __or__(self, other): return "custom-union"
    def __ror__(self, other): return "custom-reverse-union"
    def __eq__(self, other): return False
    def __ne__(self, other): return False
    def __lt__(self, other): return "lt"
    def __ge__(self, other): return "ge"


p = MappingProxyType(D(a=1))
print(p | {}, {} | p, p != {}, p == {}, p < {}, p >= {})
q, r = MappingProxyType({"b": 2}), MappingProxyType({"a": 1})
print(q | r, r | q, q | {"c": 3}, {"c": 3} | q, q == {"b": 2}, q != {"b": 2}, {"b": 2} == q)
for f in (lambda: q < r, lambda: q.__ior__({})):
    try:
        print(f())
    except TypeError as e:
        print("TypeError", e)
try:
    q |= {}
except TypeError as e:
    print("TypeError", e)


class I(int): pass
class S(str): pass
class X:
    def __index__(self): return 66


print(repr("a".translate({97: True})), "a".translate({97: I(66)}), "a".translate({97: S("XY")}), "a".translate({97: False}))
print(str.maketrans({S("a"): 98}), str.maketrans(S("a"), "b"), str.maketrans({I(97): 98}), str.maketrans("a", "b", S("c")), str.maketrans({True: 1}))
for f in (lambda: "a".translate({97: X()}), lambda: "a".translate({97: 1.5}), lambda: str.maketrans({X(): 1}), lambda: str.maketrans({1.0: 1}),
          lambda: str.maketrans(I(1), "b"), lambda: str.maketrans(1, 1), lambda: str.maketrans(None, "b"), lambda: str.maketrans("a", I(1)), lambda: "a".translate({97: I(-1)}), lambda: str.maketrans({S("ab"): 1})):
    try:
        print(f())
    except (TypeError, ValueError) as e:
        print(type(e).__name__, e)
print(S("abc").translate({97: "z"}), type(S("abc").translate({})).__name__)
print(UserString("abc").maketrans("a", "b"), UserString.maketrans("a", "b"), UserString("abc").translate(UserString.maketrans("a", "b")))


class SS(set):
    def __or__(self, o): return "so"
    def __and__(self, o): return "sa"
    def __sub__(self, o): return "ss"
    def __xor__(self, o): return "sx"
    def __ror__(self, o): return "sro"
    def __ior__(self, o): return "si"


s = SS({1})
print(s | {2}, s & {2}, s - {2}, s ^ {2}, {2} | s)
s |= {3}
print(s)
class F(frozenset): pass
print(type(F({1}) | {2}).__name__, type({2} | F({1})).__name__, type(frozenset({1}) | {2}).__name__, sorted(F({1}) | {2}))
class DI(dict):
    def __ior__(self, o): return "di"
d = DI()
d |= {1: 2}
print(d)
class E(dict): pass
e = E()
e |= {1: 2}
print(e, type(e).__name__, type(E(a=1) | {}).__name__, type({} | E(a=1)).__name__)
x = {}
x |= [(1, 2)]
print(x)
f = frozenset({1}); g = f; f |= {2}; print(sorted(f), sorted(g), f is g)
f = frozenset({1, 2}); g = f; f &= {2}; f -= {9}; f ^= {7}; print(sorted(f), sorted(g))
t = {1}; u = t; t |= {2}; t &= {1, 2, 3}; t -= {9}; t ^= {5}; print(sorted(t), t is u)
