"""sympy.Matrix in Sagebrush: a matrix of expressions, with jacobian, subs and
conversion to a NumPy array."""

import sympy as _s


class Matrix(object):
    """Matrix([[a, b], [c, d]]) by rows, or Matrix([f, g]) for a column."""

    __slots__ = ("rows", "cols", "_m")

    def __init__(self, data):
        if isinstance(data, Matrix):
            rows = [list(r) for r in data._m]
        else:
            data = list(data)
            if data and all(isinstance(r, (list, tuple)) for r in data):
                rows = [list(r) for r in data]
            elif data and any(isinstance(r, (list, tuple)) for r in data):
                raise ValueError("Matrix: mixed rows and entries")
            else:
                rows = [[x] for x in data]
        if rows and len(set(len(r) for r in rows)) != 1:
            raise ValueError("Matrix: rows of different lengths")
        self._m = [[_s.sympify(x) for x in r] for r in rows]
        self.rows = len(rows)
        self.cols = len(rows[0]) if rows else 0

    @property
    def shape(self):
        return (self.rows, self.cols)

    def __len__(self):
        return self.rows * self.cols

    def __iter__(self):
        for r in self._m:
            for x in r:
                yield x

    def __getitem__(self, k):
        if isinstance(k, tuple):
            i, j = k
            return self._m[i][j]
        return list(self)[k]

    def tolist(self):
        return [list(r) for r in self._m]

    def applyfunc(self, f):
        return Matrix([[f(x) for x in r] for r in self._m])

    def subs(self, *args):
        return self.applyfunc(lambda x: x.subs(*args) if isinstance(x, _s.Expr) else x)

    def jacobian(self, X):
        """The Jacobian of this vector of functions with respect to the
        symbols X (a Matrix or a list): row i holds f_i's derivatives."""
        if self.rows != 1 and self.cols != 1:
            raise TypeError("jacobian: this Matrix is not a vector")
        vs = list(X)
        if isinstance(X, Matrix) and X.rows != 1 and X.cols != 1:
            raise TypeError("jacobian: the symbols are not a vector")
        return Matrix([[_s.diff(f, v) for v in vs] for f in self])

    def __eq__(self, other):
        return isinstance(other, Matrix) and self.shape == other.shape and all(a == b for a, b in zip(self, other))

    def __ne__(self, other):
        return not self.__eq__(other)

    __hash__ = None

    def __array__(self, dtype=None, copy=None):
        import numpy as np
        if dtype is None:
            dtype = object
        return np.array([[x if dtype is object else float(x) for x in r] for r in self._m], dtype=dtype)

    def _entry(self, x, latex):
        if isinstance(x, _s.Expr):
            return x._latex() if latex else str(x)
        if isinstance(x, float):
            return _s._latex_float(float(x)) if latex else repr(x)
        return str(x)

    def __str__(self):
        return "Matrix([%s])" % ", ".join("[%s]" % ", ".join(self._entry(x, False) for x in r) for r in self._m)

    __repr__ = __str__

    def _latex(self):
        body = "\\\\".join(" & ".join(self._entry(x, True) for x in r) for r in self._m)
        return "\\left[\\begin{matrix}%s\\end{matrix}\\right]" % body

    def _repr_latex_(self):
        return "$\\displaystyle %s$" % self._latex()
