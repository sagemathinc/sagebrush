# A builtin type's method, read through a subclass, is the base's own, as in
# CPython: class J(int): pass; J.__repr__ is int.__repr__ (Enum's EnumType
# relies on it to give mixed-in members their Enum repr).  And called
# explicitly through either, it takes subclass instances as arguments.
# Compared with CPython by test/builtin-method-identity.test.ts.


class J(int): pass
class K(J): pass
print("int is int", int.__repr__ is int.__repr__)
print("J is J", J.__repr__ is J.__repr__)
print("J is int", J.__repr__ is int.__repr__, "K is int", K.__repr__ is int.__repr__)
print("dict", int.__dict__['__repr__'] is int.__repr__, '__repr__' in J.__dict__)
print("add", J.__add__ is int.__add__, "hash", J.__hash__ is int.__hash__, "new", J.__new__ is int.__new__)
print("str", J.__str__ is int.__str__, "format", J.__format__ is int.__format__, "reduce_ex", J.__reduce_ex__ is int.__reduce_ex__)
print("bit_length", J.bit_length is int.bit_length)
class P: pass
print("P", P.__repr__ is object.__repr__, P.__init__ is object.__init__)
class L(list): pass
print("L", L.append is list.append, L.__repr__ is list.__repr__, L.__len__ is list.__len__)
print(type(int.__repr__).__name__, type(int.bit_length).__name__, type(list.append).__name__, type(int.__dict__['__repr__']).__name__)

# (the descriptors, through int, float, str, bytes, tuple and dict subclasses)
for n in ['__repr__', '__add__', '__format__', 'bit_length', '__hash__']:
    a, b, d = getattr(J, n), getattr(int, n), int.__dict__[n]
    print(n, a is b, b is d, a is d, type(a).__name__, type(d).__name__, getattr(a, '__qualname__', '?'), getattr(a, '__objclass__', '?'))
class F(float): pass
class S(str): pass
class B(bytes): pass
class T(tuple): pass
class D(dict): pass
print("float", F.__repr__ is float.__repr__, "str", S.__repr__ is str.__repr__, S.upper is str.upper, "bytes", B.__repr__ is bytes.__repr__, "tuple", T.__repr__ is tuple.__repr__, "dict", D.__repr__ is dict.__repr__)
class BL(int): pass
print("bool-ish", bool.__repr__ is bool.__repr__)

def t(label, f):
    try: print(label, repr(f()))
    except Exception as e: print(label, "ERR", type(e).__name__, e)
for owner, name in [("int", "int"), ("J", "J")]:
    O = J if name == "J" else int
    t(name+".__add__(1,J2)", lambda: O.__add__(J(1), J(2)))
    t(name+".__eq__", lambda: O.__eq__(J(3), J(3)))
    t(name+".__lt__", lambda: O.__lt__(J(3), J(4)))
    t(name+".__pow__", lambda: O.__pow__(J(2), J(3), J(5)))
    t(name+".to_bytes", lambda: O.to_bytes(J(258), J(2), 'big'))
    t(name+".__divmod__", lambda: O.__divmod__(J(7), J(2)))
for name, O in [("str", str), ("S", S)]:
    t(name+".__add__", lambda: O.__add__(S("a"), S("b")))
    t(name+".__contains__", lambda: O.__contains__(S("abc"), S("b")))
    t(name+".split", lambda: O.split(S("a,b"), S(",")))
    t(name+".replace", lambda: O.replace(S("aXb"), S("X"), S("-")))
    t(name+".startswith", lambda: O.startswith(S("abc"), S("a")))
    t(name+".__mod__", lambda: O.__mod__(S("%s!"), S("x")))
    t(name+".center", lambda: O.center(S("a"), J(5), S("*")))
    t(name+".__getitem__", lambda: O.__getitem__(S("abc"), J(1)))
for name, O in [("float", float), ("F", F)]:
    t(name+".__mul__", lambda: O.__mul__(F(2.0), F(3.0)))
    t(name+".__truediv__", lambda: O.__truediv__(F(1.0), J(4)))
    t(name+".__round__", lambda: O.__round__(F(2.567), J(2)))


# getset descriptors too
print("getset", J.real is int.real, J.imag is int.imag, F.real is float.real, J.numerator is int.numerator)
print("values", J(5).real, F(2.5).imag, J(6).numerator, J(7).denominator)
# the same method object however it is reached: a class body's alias, vars()
class K(int):
    alias = int.__add__
print("alias", K.alias is int.__add__, K(2).alias(3), vars(int)['__add__'] is J.__add__)
# a subclass's instance through the base's method, and its own override
class O(str):
    def __repr__(self):
        return "O!"
print("override kept", repr(O("a")), [O("a")], O.__repr__ is str.__repr__, str.__repr__(O("a")))
print("format sees the box", str.format("{!r}|{}", O("a"), O("b")), "%r" % (O("c"),), str.__mod__("%r", O("d")))
