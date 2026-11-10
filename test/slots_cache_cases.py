# __slots__ reads through the attribute-read sites' cache (src/runtime/object.ts siteGet, k 2): each read below is
# one site, run often enough to be cached, then the class, the instance or the object changes under it. Every line
# is CPython 3.14.10's (test/slots_cache_cases.out, python3 -I).
def t(f):
    try:
        return repr(f())
    except Exception as e:
        return type(e).__name__ + ": " + str(e)


def read_x(o):
    return o.x


def many(o, n=5):
    return [t(lambda: read_x(o)) for _ in range(n)][-1]


class A:
    __slots__ = ("x", "y")

    def __init__(self, x=None):
        if x is not None:
            self.x = x


a = A(1)
print("set", many(a), many(A(2)))
print("unset", many(A()))
b = A(3)
del b.x
print("deleted", many(b))
b.x = 4
print("set again", many(b))


# (a subclass's slot of the same name is its own member; the base's, read through the subclass, is shadowed)
class B(A):
    __slots__ = ("x",)


bb = B()
bb.x = 5
A.x.__set__(bb, 6)
print("subclass", many(bb), A.x.__get__(bb), B.x.__get__(bb))
print("both sites", many(a), many(bb), many(a))


# (a class attribute set over the slot's name after the site is cached: the version changes, and the new attribute
# wins, as in CPython)
class C:
    __slots__ = ("x",)


c = C()
c.x = 7
print("before", many(c))
saved = C.__dict__["x"]
C.x = property(lambda self: "property")
print("property", many(c))
C.x = saved
print("restored", many(c))


# (__getattr__ answers for an unset slot; __getattribute__ is never bypassed)
class G:
    __slots__ = ("x",)

    def __getattr__(self, name):
        return "getattr " + name


g = G()
print("getattr unset", many(g))
g.x = 8
print("getattr set", many(g))


class H:
    __slots__ = ("x",)

    def __getattribute__(self, name):
        return "getattribute " + name


h = H()
object.__setattr__(h, "x", 9)
print("getattribute", many(h))


# (a member copied onto another class: read on that class's instance, the descriptor refuses it)
class D:
    __slots__ = ("z",)


D.x = A.__dict__["x"]
print("foreign member", many(D()))


# (a slot holding None, False or 0 is set)
for v in (None, False, 0, "", []):
    print("falsy", many(A(1)) if v is None else None, end=" ")
    o = A()
    o.x = v
    print(many(o))
# (an instance with a __dict__ too, and a dict attribute of the slot's name never shadows it)
class E:
    __slots__ = ("x", "__dict__")


e = E()
e.x = 10
e.__dict__["x"] = "dict"
print("slot over dict", many(e), e.__dict__)
print("dir", sorted(n for n in dir(a) if not n.startswith("__")))
