# Keyword arguments from **mappings, as CPython merges them: duplicates
# (with a k=v, between two mappings, a dict or any object with keys() and
# __getitem__) are TypeErrors, keys must be strings, and a non-mapping is
# refused; for Python functions and builtins (test/float-divmod.test.ts
# compares with python3).
import math


def show(f):
    try:
        return repr(f())
    except Exception as e:
        return "%s(%s)" % (type(e).__name__, e)


def f(a=0, b=0, **kw):
    return (a, b, sorted(kw.items()))


class M:
    def __init__(self, d):
        self.d = d

    def keys(self):
        return list(self.d)

    def __getitem__(self, k):
        return self.d[k]


class Seen(M):
    # (the order CPython reads keys and values in)
    log = []

    def keys(self):
        Seen.log.append("keys")
        return list(self.d)

    def __getitem__(self, k):
        Seen.log.append("get " + k)
        return self.d[k]


class BadGet(M):
    def __getitem__(self, k):
        raise KeyError(k)


cases = [
    lambda: f(a=1, **{"a": 2}),
    lambda: f(a=1, **M({"a": 2})),
    lambda: f(**{"a": 1}, **{"a": 2}),
    lambda: f(**M({"a": 1}), **M({"a": 2})),
    lambda: f(**{"a": 1}, **M({"b": 2})),
    lambda: f(**M({"c": 3, "a": 1})),
    lambda: f(**{1: 2}),
    lambda: f(**M({1: 2})),
    lambda: f(**[("a", 1)]),
    lambda: f(**M({})),
    lambda: f(1, **M({"a": 2})),
    lambda: f(**BadGet({"a": 1})),
    lambda: f(**M({"a": 1, "zz": 5})),
    lambda: math.isclose(1.0, 2.0, rel_tol=0.1, **M({"rel_tol": 0.2})),
    lambda: math.isclose(1.0, 2.0, **M({"rel_tol": 0.9})),
    lambda: math.isclose(1.0, 2.0, **{"rel_tol": 0.1, "abs_tol": 1.0}),
    lambda: math.isclose(1.0, 2.0, **M({"tol": 1})),
    lambda: dict(a=1, **M({"a": 2})),
    lambda: dict(**M({"b": 2})),
    lambda: sorted([3, 1], **M({"reverse": True})),
    lambda: print("x", **M({"sep": "-", "end": "!\n"})),
]
for c in cases:
    print(show(c))
print(show(lambda: f(**Seen({"a": 1, "b": 2}))), Seen.log)
# a name given twice is refused before the mapping's __getitem__ is called
Seen.log = []
print(show(lambda: f(a=0, **Seen({"b": 2, "a": 1, "c": 3}))), Seen.log)
Seen.log = []
print(show(lambda: f(**{"b": 0}, **Seen({"a": 1, "b": 2}))), Seen.log)


# the calls builtins make on an iterator, logged: how many __next__ calls,
# and where a failing one stops them (the items before it used, none after)
class LogIt:
    def __init__(self, n, fail=None):
        self.n, self.fail, self.log = n, fail, []

    def __iter__(self):
        self.log.append("iter")
        return self

    def __next__(self):
        k = len([e for e in self.log if e != "iter"])
        self.log.append(k)
        if k == self.fail:
            raise ValueError("item %d" % k)
        if k >= self.n:
            raise StopIteration
        return float(k)


for name, use in [("fsum", lambda it: math.fsum(it)), ("prod", lambda it: math.prod(it)), ("sum", lambda it: sum(it)),
                  ("list +=", lambda it: (lambda l: (l.__iadd__(it), len(l))[1])([])), ("set", lambda it: len(set(it))),
                  ("dict.fromkeys", lambda it: len(dict.fromkeys(it))), ("max", lambda it: max(it)),
                  ("sorted", lambda it: len(sorted(it)))]:
    for n, fail in [(0, None), (3, None), (3000, None), (3000, 1500), (3000, 1024), (5, 0)]:
        it = LogIt(n, fail)
        r = show(lambda: use(it))
        calls = [e for e in it.log if e != "iter"]
        print(name, n, fail, r, it.log.count("iter"), len(calls), calls[-1] if calls else None)
held = []
it = LogIt(3000, 1500)
try:
    held += it
except ValueError as e:
    print("held", e, len(held), held[-1], next(iter([len(it.log)])))
