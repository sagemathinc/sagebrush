# NumPy's __array__ protocol: an object whose type defines __array__ stands
# for the array it returns, in np.array/np.asarray, nested in lists, as a
# ufunc operand and on either side of an ndarray operator.  Every printed
# line is one t() case, and each case builds its own objects.
import numpy as np


def t(label, f):
    try:
        r = f()
        print(label, repr(r), getattr(r, "dtype", ""))
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
