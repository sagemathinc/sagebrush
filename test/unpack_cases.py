# Unpacking's errors, as CPython 3.14 words them (test/unpack-message.test.ts compares the output with CPython's).
# A non-iterable is "cannot unpack non-iterable X object"; an __iter__ that raises keeps its own error; iter() and
# a for loop keep "'X' object is not iterable".


class NoIter:
    pass


class IterRaises:
    def __iter__(self):
        raise TypeError("my own message")


class IterNone:
    __iter__ = None


class Seq:
    def __getitem__(self, i):
        if i < 2:
            return i * 10
        raise IndexError


def show(label, f):
    try:
        print(label, "->", f())
    except Exception as e:
        print(label, "->", type(e).__name__ + ":", e)


def ab(x):
    a, b = x
    return a, b


def star(x):
    a, *b = x
    return a, b


def star_end(x):
    *a, b = x
    return a, b


def loop(xs):
    out = []
    for a, b in xs:
        out.append((a, b))
    return out


def nested(x):
    (a, b), c = x
    return a, b, c


for label, x in [("int", 5), ("None", None), ("float", 2.5), ("complex", 1j), ("NoIter", NoIter()),
                 ("IterRaises", IterRaises()), ("IterNone", IterNone()), ("Seq", Seq()), ("tuple3", (1, 2, 3)),
                 ("list1", [1]), ("str2", "xy"), ("dict2", {1: 2, 3: 4})]:
    show("a, b = " + label, lambda: ab(x))
    show("a, *b = " + label, lambda: star(x))
    show("*a, b = " + label, lambda: star_end(x))
show("for a, b in [7]", lambda: loop([7]))
show("(a, b), c = (5, 6)", lambda: nested((5, 6)))
show("iter(5)", lambda: iter(5))
show("for x in 5", lambda: [x for x in 5])
