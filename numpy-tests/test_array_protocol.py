# NumPy's __array__ protocol: an object with an __array__ method stands for
# the array it returns, in np.array/np.asarray, nested in lists, as a
# ufunc operand and on either side of an ndarray operator.  Every printed
# line is one t() case (a repr's newlines escaped), and each case builds its
# own objects.
import numpy as np


def t(label, f):
    try:
        r = f()
        print(label, repr(r).replace("\n", "\\n"), getattr(r, "dtype", ""))
    except Exception as e:
        print(label, type(e).__name__ + ":", e)


class A:
    """__array__ with NumPy 2's dtype and copy parameters"""

    def __array__(self, dtype=None, copy=None):
        return np.array([1.0, 2.0])


class B:
    """__array__ that returns a list, not an array"""

    def __array__(self, dtype=None, copy=None):
        return [1, 2]


class C:
    """__array__ with no parameters"""

    def __array__(self):
        return np.arange(3)


t("asarray", lambda: np.asarray(A()))
t("array", lambda: np.array(A()))
t("asarray dtype", lambda: np.asarray(A(), dtype=int))
t("array dtype float32", lambda: np.array(A(), dtype=np.float32))
t("list of", lambda: np.array([A(), A()]))
t("nested", lambda: np.array([[A()], [A()]]))
t("mixed list", lambda: np.array([A(), [3.0, 4.0]]))
t("tuple of", lambda: np.array((A(), A())))
t("not an array", lambda: np.asarray(B()))
t("no parameters", lambda: np.asarray(C()))
t("ufunc add", lambda: np.add(A(), 1))
t("ufunc sqrt", lambda: np.sqrt(A()))
t("sum", lambda: np.sum(A()))
t("mean", lambda: np.mean(A()))
t("concatenate", lambda: np.concatenate([A(), A()]))
t("ndarray + obj", lambda: np.arange(2.0) + A())
t("obj + ndarray", lambda: A() + np.arange(2.0))
t("ndarray += obj", lambda: (lambda a: (a.__iadd__(A()), a)[1])(np.zeros(2)))
t("ndarray == obj", lambda: np.arange(2.0) == A())
t("where", lambda: np.where(np.array([True, False]), A(), 0))
t("dot", lambda: np.dot(A(), A()))
t("shape", lambda: np.shape(A()))
t("a new array each call", lambda: (lambda a: np.asarray(a) is np.asarray(a))(A()))
t("int scalar", lambda: np.asarray(3))
t("float scalar", lambda: np.asarray(2.5))
t("numpy scalar", lambda: np.asarray(np.float64(1.5)))
t("ndarray itself", lambda: (lambda a: np.asarray(a) is a)(np.arange(2)))


class Rec:
    """__array__ that records how it was called"""

    def __init__(self):
        self.calls = []

    def __array__(self, *args, **kw):
        self.calls.append((args, sorted(kw.items())))
        return np.array([1.0, 2.0])


def rec(f):
    r = Rec()
    return f(r).tolist(), r.calls


class Pos:
    """__array__ that applies the dtype it is given"""

    def __array__(self, dtype=None):
        return np.array([1.0, 2.0], dtype=dtype)


class Req:
    """__array__ whose dtype is required: called with it, or with nothing"""

    def __array__(self, dtype, copy=None):
        return np.array([7, 8], dtype=dtype)


class St:
    @staticmethod
    def __array__(dtype=None, copy=None):
        return np.array([5.0])


class Cl:
    @classmethod
    def __array__(cls, dtype=None, copy=None):
        return np.array([6.0])


class Err:
    def __array__(self, dtype=None, copy=None):
        raise TypeError("the method's own TypeError")


class LS(list):
    """a list subclass with __array__: its array, not its items"""

    def __array__(self, dtype=None, copy=None):
        return np.array([9.0, 9.0])


class TS(tuple):
    def __array__(self, dtype=None, copy=None):
        return np.array([8.0, 8.0])


def instance_attr():
    o = type("X", (), {})()
    o.__array__ = lambda *a, **k: np.array([0.0])
    return np.asarray(o)


# how __array__ is called: no arguments, the dtype positionally, copy= from np.array
t("called by asarray", lambda: rec(lambda r: np.asarray(r)))
t("called by asarray dtype", lambda: rec(lambda r: np.asarray(r, dtype=np.float32)))
t("called by array", lambda: rec(lambda r: np.array(r)))
t("called by array copy False", lambda: rec(lambda r: np.array(r, copy=False)))
t("called in a list", lambda: rec(lambda r: np.array([r, r])))
t("called in a list dtype", lambda: rec(lambda r: np.array([r], dtype=int)))
t("dtype applied by the method", lambda: np.asarray(Pos(), dtype=np.float32))
t("dtype required, given", lambda: np.asarray(Req(), dtype=float))
t("staticmethod", lambda: np.asarray(St()))
t("classmethod", lambda: np.asarray(Cl()))
t("instance attribute", instance_attr)
t("the method's error", lambda: np.asarray(Err()))
t("list subclass", lambda: np.asarray(LS([1, 2, 3])))
t("tuple subclass", lambda: np.asarray(TS((1, 2, 3))))
t("list subclass in a list", lambda: np.array([LS([1, 2, 3]), [1.0, 2.0]]))
# either order among sequences and arrays, and true mismatches
t("sequence then object", lambda: np.array([[3.0, 4.0], A()]))
t("object then sequence", lambda: np.array([A(), [3.0, 4.0]]))
t("ndarray then object", lambda: np.array([np.zeros(2), A()]))
t("object then ndarray", lambda: np.array([A(), np.zeros(2)]))
t("sequence then object dtype", lambda: np.array([[3, 4], A()], dtype=np.float32))
t("mismatch, sequence first", lambda: np.array([[3.0, 4.0, 5.0], A()]))
t("mismatch, object first", lambda: np.array([A(), [3.0, 4.0, 5.0]]))
t("mismatch, deeper", lambda: np.array([[A(), [1.0, 2.0]], [[1.0, 2.0], [3.0]]]))
# NumPy's message names the shape detected (no protocol involved)
for i, v in enumerate([[[3.0, 4.0, 5.0], [1.0, 2.0]], [[1, 2], 3], [1, [2, 3]], [[[1, 2], [3]], [[4, 5], [6, 7]]],
                       [[[1], [2]], [[3], [4, 5]]], [[1, 2], [[3, 4]]]]):
    t("inhomogeneous %d" % i, lambda v=v: np.array(v))
