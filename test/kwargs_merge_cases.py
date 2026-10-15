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
