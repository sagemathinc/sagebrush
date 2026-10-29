# A class used as a container or a truth value: its metaclass's special
# methods decide, as in CPython (Enum's classes iterate, have a length, and
# test membership this way).  Compared with CPython by test/metaclass-protocols.test.ts.


def t(label, f):
    try:
        print(label, f())
    except Exception as e:
        print(label, "ERR", type(e).__name__, e)


class M(type):
    def __iter__(cls):
        return iter([1, 2, 3])

    def __len__(cls):
        return 3

    def __contains__(cls, x):
        return x == 2

    def __getitem__(cls, k):
        return ("item", k)

    def __reversed__(cls):
        return iter([3, 2, 1])

    def __bool__(cls):
        return False


class C(metaclass=M):
    pass


# every way of iterating
t("list", lambda: list(C))
t("comprehension", lambda: [x for x in C])
t("tuple", lambda: tuple(C))
t("set", lambda: sorted(set(C)))
t("next(iter())", lambda: next(iter(C)))
t("call unpacking", lambda: (lambda a, b, c: (a, b, c))(*C))
t("sum", lambda: sum(C))
t("enumerate", lambda: list(enumerate(C)))
t("zip", lambda: list(zip(C, C)))
t("map", lambda: list(map(str, C)))
t("star", lambda: [*C])
t("sorted", lambda: sorted(C))
t("join", lambda: ",".join(map(str, C)))
t("min max", lambda: (min(C), max(C)))
t("dict.fromkeys", lambda: dict.fromkeys(C))
t("any all", lambda: (any(C), all(C)))


def g():
    yield from C


t("yield from", lambda: list(g()))
a, b, c = C
print("assignment unpacking", a, b, c)
first, *rest = C
print("starred assignment", first, rest)
out = []
for v in C:
    out.append(v)
print("for", out)

# the other container protocols
t("len", lambda: len(C))
t("in", lambda: (2 in C, 5 in C, 5 not in C))
t("getitem", lambda: C[0])
t("reversed", lambda: list(reversed(C)))

# truth: __bool__, then __len__, then true
t("bool", lambda: bool(C))
t("not", lambda: not C)
print("if", "yes" if C else "no")
print("and or", C and 1, C or 2)


class L(type):
    def __len__(cls):
        return 0


class Empty(metaclass=L):
    pass


class N(type):
    def __len__(cls):
        return 4


class Four(metaclass=N):
    pass


t("bool via __len__ 0", lambda: bool(Empty))
t("bool via __len__ 4", lambda: bool(Four))


class BadBool(type):
    def __bool__(cls):
        return 1


class B(metaclass=BadBool):
    pass


t("__bool__ returning int", lambda: bool(B))


# iteration by __getitem__ alone (the sequence protocol), and by a generator
class Seq(type):
    def __getitem__(cls, i):
        if i >= 3:
            raise IndexError(i)
        return i * 10


class S(metaclass=Seq):
    pass


t("getitem iteration", lambda: list(S))
t("getitem in", lambda: (20 in S, 25 in S))


class Gen(type):
    def __iter__(cls):
        yield "a"
        yield "b"


class G(metaclass=Gen):
    pass


t("generator __iter__", lambda: list(G))


class Bad(type):
    def __iter__(cls):
        return 5


class X(metaclass=Bad):
    pass


t("__iter__ not returning an iterator", lambda: list(X))


class NoIter(type):
    __iter__ = None


class Y(metaclass=NoIter):
    pass


t("__iter__ = None", lambda: list(Y))


# a subclass's class inherits its metaclass's protocols
class D(C):
    pass


t("subclass", lambda: (list(D), len(D), bool(D)))


# plain classes, functions and builtins still aren't iterable, and are true
class P:
    pass


class WithClassGetitem:
    def __class_getitem__(cls, k):
        return ("cg", k)


t("plain class", lambda: list(P))
t("plain len", lambda: len(P))
t("plain in", lambda: 1 in P)
t("int", lambda: list(int))
t("list type", lambda: list(list))
t("type", lambda: list(type))
t("__class_getitem__ is not iteration", lambda: list(WithClassGetitem))
t("builtin function", lambda: list(len))
t("function", lambda: list(t))
t("lambda", lambda: iter(lambda: 1))
t("truth of classes and functions", lambda: (bool(P), bool(int), bool(len), bool(t), bool(lambda: 0), not P))
