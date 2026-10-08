"""The real and complex double fields RDF and CDF, as in Sage (machine
doubles, printed as Python prints floats: 0.3333333333333333, 1.0 + 2.0*I),
and numerical linear algebra for matrices over RDF, CDF, RR and CC
(determinants, inverses, eigenvalues and eigenvectors, SVD, QR) by numpy."""

import cmath
import math


def _sa():
    import sage_all
    return sage_all


def _frepr(x):
    if x != x:
        return "NaN"
    if x == float("inf"):
        return "+infinity"
    if x == float("-inf"):
        return "-infinity"
    return float.__repr__(float(x))


# ------------------------------------------------------------------ RDF

class RealDoubleField_:
    """RDF: real numbers as machine doubles.

    EXAMPLES::

        sage: RDF, RDF(1/3), RDF(2).sqrt()
        (Real Double Field, 0.3333333333333333, 1.4142135623730951)
    """

    _is_generic_field = True
    _numeric = True
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = object.__new__(cls)
        return cls._instance

    def __repr__(self):
        return "Real Double Field"

    def _latex_(self):
        return "\\Bold{R}"

    def __call__(self, x=0):
        """Convert x to a double.

        EXAMPLES::

            sage: RDF(pi), RDF('1.5'), RDF(10^20)
            (3.141592653589793, 1.5, 1e+20)
        """
        if isinstance(x, (complex, ComplexDoubleElement)) or type(x).__name__ in ("ComplexNumber", "ComplexNumberMP"):
            z = complex(x)
            if z.imag:
                raise TypeError("unable to convert %r to a real number" % (x,))
            x = z.real
        return RealDoubleElement(float(x))

    def __eq__(self, o):
        return isinstance(o, RealDoubleField_)

    def __hash__(self):
        return hash("RDF")

    def zero(self):
        """0.

        EXAMPLES::

            sage: RDF.zero()
            0.0
        """
        return RealDoubleElement(0.0)

    def one(self):
        """1.

        EXAMPLES::

            sage: RDF.one()
            1.0
        """
        return RealDoubleElement(1.0)

    def is_exact(self):
        """False.

        EXAMPLES::

            sage: RDF.is_exact()
            False
        """
        return False

    def is_field(self, proof=True):
        """True.

        EXAMPLES::

            sage: RDF.is_field()
            True
        """
        return True

    def characteristic(self):
        """0.

        EXAMPLES::

            sage: RDF.characteristic()
            0
        """
        return 0

    def precision(self):
        """53.

        EXAMPLES::

            sage: RDF.precision()
            53
        """
        return 53

    prec = precision

    def pi(self):
        """pi.

        EXAMPLES::

            sage: RDF.pi()
            3.141592653589793
        """
        return RealDoubleElement(math.pi)

    def complex_field(self):
        """CDF.

        EXAMPLES::

            sage: RDF.complex_field()
            Complex Double Field
        """
        return CDF

    def random_element(self, min=-1, max=1):
        """A random element of [min, max].

        EXAMPLES::

            sage: RDF.random_element().parent()
            Real Double Field
        """
        import random as _r
        return RealDoubleElement(_r.uniform(float(min), float(max)))

    def __contains__(self, x):
        try:
            self(x)
            return True
        except (TypeError, ValueError):
            return False


class RealDoubleElement(float):
    """An element of RDF.

    EXAMPLES::

        sage: x = RDF(2); x, x / 3, x.sqrt(), x^0.5
        (2.0, 0.6666666666666666, 1.4142135623730951, 1.414213562373095)
    """

    __slots__ = ()

    def __repr__(self):
        return _frepr(self)

    __str__ = __repr__

    def _latex_(self):
        return repr(self)

    def parent(self):
        """RDF.

        EXAMPLES::

            sage: RDF(1).parent()
            Real Double Field
        """
        return RDF

    def _w(f):
        def g(self, *a):
            r = f(float(self), *(float(x) if isinstance(x, float) else x for x in a))
            if isinstance(r, float):
                return RealDoubleElement(r)
            return r
        g.__name__ = f.__name__
        return g

    def _num(self, o):
        if isinstance(o, (int, float)) or type(o).__name__ in ("Integer", "Rational", "RealNumber"):
            try:
                return float(o)
            except (TypeError, ValueError, OverflowError):
                return None
        try:
            from fractions import Fraction
            if isinstance(o, Fraction):
                return float(o)
        except ImportError:
            pass
        return None

    def __add__(self, o):
        v = self._num(o)
        return NotImplemented if v is None else RealDoubleElement(float(self) + v)

    __radd__ = __add__

    def __sub__(self, o):
        v = self._num(o)
        return NotImplemented if v is None else RealDoubleElement(float(self) - v)

    def __rsub__(self, o):
        v = self._num(o)
        return NotImplemented if v is None else RealDoubleElement(v - float(self))

    def __mul__(self, o):
        v = self._num(o)
        return NotImplemented if v is None else RealDoubleElement(float(self) * v)

    __rmul__ = __mul__

    def __truediv__(self, o):
        v = self._num(o)
        if v is None:
            return NotImplemented
        if v == 0:
            x = float(self)
            return RealDoubleElement(float("nan") if x == 0 else math.copysign(float("inf"), x))
        return RealDoubleElement(float(self) / v)

    def __rtruediv__(self, o):
        v = self._num(o)
        if v is None:
            return NotImplemented
        return RealDoubleElement(v / float(self)) if float(self) else RealDoubleElement(math.copysign(float("inf"), v))

    def __neg__(self):
        return RealDoubleElement(-float(self))

    def __abs__(self):
        """The absolute value.

        EXAMPLES::

            sage: RDF(-2).abs()
            2.0
        """
        return RealDoubleElement(abs(float(self)))

    def __pow__(self, e, mod=None):
        x = float(self)
        if isinstance(e, int) or type(e).__name__ == "Integer":
            try:
                return RealDoubleElement(x ** int(e))
            except OverflowError:
                return RealDoubleElement(float("inf"))
        y = float(e)
        if x < 0:
            return CDF(x) ** y
        if x == 0:
            return RealDoubleElement(0.0 if y > 0 else float("inf"))
        # as Sage: exp(y log x)
        return RealDoubleElement(math.exp(y * math.log(x)))

    def __rpow__(self, b):
        return RDF(b) ** self

    def sqrt(self, extend=True, all=False):
        """The square root (in CDF for negative numbers).

        EXAMPLES::

            sage: RDF(2).sqrt(), RDF(-2).sqrt()
            (1.4142135623730951, 1.4142135623730951*I)
        """
        x = float(self)
        if x < 0:
            r = ComplexDoubleElement(0.0, math.sqrt(-x))
        else:
            r = RealDoubleElement(math.sqrt(x))
        return [r, -r] if all else r

    def exp(self):
        """e^self.

        EXAMPLES::

            sage: RDF(1).exp()
            2.718281828459045
        """
        return RealDoubleElement(math.exp(float(self)))

    def log(self, base=None):
        """The natural logarithm (or to the given base).

        EXAMPLES::

            sage: RDF(2).log(), RDF(8).log(2)
            (0.6931471805599453, 3.0)
        """
        x = float(self)
        if x < 0:
            return CDF(x).log() if base is None else CDF(x).log() / math.log(float(base))
        if x == 0:
            return RealDoubleElement(float("-inf"))
        return RealDoubleElement(math.log(x) if base is None else math.log(x) / math.log(float(base)))

    def sin(self):
        """The sine.

        EXAMPLES::

            sage: RDF(1).sin()
            0.8414709848078965
        """
        return RealDoubleElement(math.sin(float(self)))

    def cos(self):
        """The cosine.

        EXAMPLES::

            sage: RDF(1).cos()
            0.5403023058681398
        """
        return RealDoubleElement(math.cos(float(self)))

    def tan(self):
        """The tangent.

        EXAMPLES::

            sage: RDF(1).tan()
            1.557407724654902
        """
        x = float(self)
        return RealDoubleElement(math.sin(x) / math.cos(x))

    def arctan(self):
        """The arctangent.

        EXAMPLES::

            sage: RDF(1).arctan()
            0.7853981633974483
        """
        return RealDoubleElement(math.atan(float(self)))

    def arcsin(self):
        """The arcsine.

        EXAMPLES::

            sage: RDF(1/2).arcsin()
            0.5235987755982989
        """
        return RealDoubleElement(math.asin(float(self)))

    def arccos(self):
        """The arccosine.

        EXAMPLES::

            sage: RDF(1/2).arccos()
            1.0471975511965979
        """
        return RealDoubleElement(math.acos(float(self)))

    def sinh(self):
        """The hyperbolic sine.

        EXAMPLES::

            sage: RDF(1).sinh()
            1.1752011936438014
        """
        return RealDoubleElement(math.sinh(float(self)))

    def cosh(self):
        """The hyperbolic cosine.

        EXAMPLES::

            sage: RDF(1).cosh()
            1.5430806348152437
        """
        return RealDoubleElement(math.cosh(float(self)))

    def tanh(self):
        """The hyperbolic tangent.

        EXAMPLES::

            sage: RDF(1).tanh()
            0.7615941559557649
        """
        return RealDoubleElement(math.tanh(float(self)))

    abs = __abs__

    def floor(self):
        """The greatest integer at most self.

        EXAMPLES::

            sage: RDF(2.5).floor()
            2
        """
        return _sa().Integer(math.floor(float(self)))

    def ceil(self):
        """The least integer at least self.

        EXAMPLES::

            sage: RDF(2.5).ceil()
            3
        """
        return _sa().Integer(math.ceil(float(self)))

    def round(self):
        """The nearest integer.

        EXAMPLES::

            sage: RDF(2.6).round()
            3
        """
        return _sa().Integer(round(float(self)))

    def is_integer(self):
        """Whether an integer.

        EXAMPLES::

            sage: RDF(2).is_integer(), RDF(2.5).is_integer()
            (True, False)
        """
        return float(self).is_integer()

    def real(self):
        """The number itself.

        EXAMPLES::

            sage: RDF(2).real()
            2.0
        """
        return self

    def imag(self):
        """0.

        EXAMPLES::

            sage: RDF(2).imag()
            0.0
        """
        return RealDoubleElement(0.0)

    def conjugate(self):
        """The number itself.

        EXAMPLES::

            sage: RDF(2).conjugate()
            2.0
        """
        return self

    def n(self, prec=None, digits=None):
        """A numerical approximation in RR or RealField(prec).

        EXAMPLES::

            sage: RDF(1/3).n(), RDF(1/3).n(10)
            (0.333333333333333, 0.33)
        """
        if prec is None and digits is None:
            return _sa().RR(float(self))
        import _sage_real
        return _sage_real.N(float(self), prec, digits)

    numerical_approx = N = n

    def __hash__(self):
        return float.__hash__(self)


RDF = RealDoubleField_()


# ------------------------------------------------------------------ CDF

class ComplexDoubleField_:
    """CDF: complex numbers as pairs of doubles.

    EXAMPLES::

        sage: CDF, CDF(1, 2), CDF.0
        (Complex Double Field, 1.0 + 2.0*I, 1.0*I)
    """

    _is_generic_field = True
    _numeric = True
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = object.__new__(cls)
        return cls._instance

    def __repr__(self):
        return "Complex Double Field"

    def _latex_(self):
        return "\\Bold{C}"

    def __call__(self, re=0, im=None):
        """A complex double from a number or real and imaginary parts.

        EXAMPLES::

            sage: CDF(1/3, -1), CDF(I), CDF(2)
            (0.3333333333333333 - 1.0*I, 1.0*I, 2.0)
        """
        if im is not None:
            return ComplexDoubleElement(float(re), float(im))
        z = complex(re)
        return ComplexDoubleElement(z.real, z.imag)

    def gen(self, i=0):
        """I.

        EXAMPLES::

            sage: CDF.gen()
            1.0*I
        """
        return ComplexDoubleElement(0.0, 1.0)

    def __eq__(self, o):
        return isinstance(o, ComplexDoubleField_)

    def __hash__(self):
        return hash("CDF")

    def zero(self):
        """0.

        EXAMPLES::

            sage: CDF.zero()
            0.0
        """
        return ComplexDoubleElement(0.0, 0.0)

    def one(self):
        """1.

        EXAMPLES::

            sage: CDF.one()
            1.0
        """
        return ComplexDoubleElement(1.0, 0.0)

    def is_exact(self):
        """False.

        EXAMPLES::

            sage: CDF.is_exact()
            False
        """
        return False

    def is_field(self, proof=True):
        """True.

        EXAMPLES::

            sage: CDF.is_field()
            True
        """
        return True

    def characteristic(self):
        """0.

        EXAMPLES::

            sage: CDF.characteristic()
            0
        """
        return 0

    def precision(self):
        """53.

        EXAMPLES::

            sage: CDF.precision(), CDF.prec()
            (53, 53)
        """
        return 53

    prec = precision

    def real_double_field(self):
        """RDF.

        EXAMPLES::

            sage: CDF.real_double_field()
            Real Double Field
        """
        return RDF


def _logabs(x, y):
    """log |x + iy| as GSL computes it."""
    xa, ya = abs(x), abs(y)
    if xa >= ya:
        mx, u = xa, (ya / xa if xa else 0.0)
    else:
        mx, u = ya, xa / ya
    return math.log(mx) + 0.5 * math.log1p(u * u)


class ComplexDoubleElement:
    """An element of CDF.

    EXAMPLES::

        sage: z = CDF(1, 2); z^2, z.abs(), z.arg(), z.conjugate()
        (-2.9999999999999987 + 4.0*I, 2.23606797749979, 1.1071487177940904, 1.0 - 2.0*I)
    """

    __slots__ = ("_z",)

    def __init__(self, re, im=0.0):
        self._z = complex(float(re), float(im))

    def __repr__(self):
        re, im = self._z.real, self._z.imag
        if im == 0:
            return _frepr(re)
        si = _frepr(abs(im)) + "*I"
        if re == 0:
            return ("-" if im < 0 else "") + si
        return "%s %s %s" % (_frepr(re), "-" if im < 0 else "+", si)

    __str__ = __repr__

    def _latex_(self):
        return repr(self).replace("*I", "i")

    def parent(self):
        """CDF.

        EXAMPLES::

            sage: CDF(1).parent()
            Complex Double Field
        """
        return CDF

    def __complex__(self):
        return self._z

    def __float__(self):
        if self._z.imag:
            raise TypeError("unable to convert %r to float" % (self,))
        return self._z.real

    def __hash__(self):
        return hash(self._z)

    def _c(self, o):
        if isinstance(o, ComplexDoubleElement):
            return o._z
        try:
            return complex(o)
        except (TypeError, ValueError):
            return None

    def __add__(self, o):
        v = self._c(o)
        return NotImplemented if v is None else ComplexDoubleElement._of(self._z + v)

    __radd__ = __add__

    def __sub__(self, o):
        v = self._c(o)
        return NotImplemented if v is None else ComplexDoubleElement._of(self._z - v)

    def __rsub__(self, o):
        v = self._c(o)
        return NotImplemented if v is None else ComplexDoubleElement._of(v - self._z)

    def __mul__(self, o):
        v = self._c(o)
        return NotImplemented if v is None else ComplexDoubleElement._of(self._z * v)

    __rmul__ = __mul__

    def __truediv__(self, o):
        v = self._c(o)
        return NotImplemented if v is None else ComplexDoubleElement._of(self._z / v)

    def __rtruediv__(self, o):
        v = self._c(o)
        return NotImplemented if v is None else ComplexDoubleElement._of(v / self._z)

    def __neg__(self):
        return ComplexDoubleElement._of(-self._z)

    def __pow__(self, e, mod=None):
        z = self._z
        if z == 0:
            return ComplexDoubleElement(0.0, 0.0)
        w = self._c(e)
        # as Sage (GSL's gsl_complex_pow, with its log |z|)
        lr = _logabs(z.real, z.imag)
        th = math.atan2(z.imag, z.real)
        rho = math.exp(lr * w.real - w.imag * th)
        beta = th * w.real + w.imag * lr
        return ComplexDoubleElement(rho * math.cos(beta), rho * math.sin(beta))

    def __rpow__(self, b):
        return CDF(b) ** self

    def __eq__(self, o):
        v = self._c(o)
        return v is not None and v == self._z

    def __ne__(self, o):
        return not self == o

    def __bool__(self):
        return self._z != 0

    @staticmethod
    def _of(z):
        return ComplexDoubleElement(z.real, z.imag)

    def real(self):
        """The real part.

        EXAMPLES::

            sage: CDF(1, 2).real(), CDF(1, 2).imag()
            (1.0, 2.0)
        """
        return RealDoubleElement(self._z.real)

    real_part = real

    def imag(self):
        """The imaginary part.

        EXAMPLES::

            sage: CDF(1, 2).imag()
            2.0
        """
        return RealDoubleElement(self._z.imag)

    imag_part = imag

    def abs(self):
        """|self|.

        EXAMPLES::

            sage: CDF(3, 4).abs()
            5.0
        """
        return RealDoubleElement(abs(self._z))

    __abs__ = abs

    def norm(self):
        """|self|^2.

        EXAMPLES::

            sage: CDF(3, 4).norm()
            25.0
        """
        return RealDoubleElement(abs(self._z) ** 2)

    def arg(self):
        """The argument.

        EXAMPLES::

            sage: CDF(0, 1).arg()
            1.5707963267948966
        """
        return RealDoubleElement(cmath.phase(self._z))

    argument = arg

    def conjugate(self):
        """The complex conjugate.

        EXAMPLES::

            sage: CDF(1, 2).conjugate()
            1.0 - 2.0*I
        """
        return ComplexDoubleElement(self._z.real, -self._z.imag)

    def sqrt(self, all=False):
        """The principal square root.

        EXAMPLES::

            sage: CDF(-1).sqrt()
            1.0*I
        """
        r = ComplexDoubleElement._of(cmath.sqrt(self._z))
        return [r, -r] if all else r

    def exp(self):
        """e^self.

        EXAMPLES::

            sage: CDF(1, 1).exp()
            1.4686939399158851 + 2.2873552871788423*I
        """
        return ComplexDoubleElement._of(cmath.exp(self._z))

    def log(self):
        """The principal logarithm.

        EXAMPLES::

            sage: CDF(1, 1).log()
            0.34657359027997264 + 0.7853981633974483*I
        """
        return ComplexDoubleElement._of(cmath.log(self._z))

    def sin(self):
        """The sine.

        EXAMPLES::

            sage: CDF(1, 1).sin()
            1.2984575814159773 + 0.6349639147847361*I
        """
        return ComplexDoubleElement._of(cmath.sin(self._z))

    def cos(self):
        """The cosine.

        EXAMPLES::

            sage: CDF(1, 1).cos()
            0.8337300251311491 - 0.9888977057628651*I
        """
        return ComplexDoubleElement._of(cmath.cos(self._z))

    def n(self, prec=None, digits=None):
        """A numerical approximation in CC or ComplexField(prec).

        EXAMPLES::

            sage: CDF(1, 2).n(), CDF(1, 2).n(10)
            (1.00000000000000 + 2.00000000000000*I, 1.0 + 2.0*I)
        """
        if prec is None and digits is None:
            return _sa().CC(self._z.real, self._z.imag)
        import _sage_real
        p = _sage_real.digits_to_prec(digits) if digits is not None else int(prec)
        return _sage_real.ComplexField(p)(self._z.real, self._z.imag)


CDF = ComplexDoubleField_()


# ------------------------------------------------------------------ numerical linear algebra

def _np():
    import numpy
    return numpy


def _is_complex_base(base):
    return base is CDF or type(base).__name__ in ("ComplexField_",) or repr(base).startswith("Complex")


def _array(M):
    np = _np()
    cx = _is_complex_base(M._base)
    rows = [[complex(x) if cx else float(x) for x in r] for r in M._rows]
    return np.array(rows, dtype=complex if cx else float) if rows else np.zeros((0, M._ncols))


def _elt(base, x):
    """A numpy scalar as an element of base (or CDF/CC when complex)."""
    z = complex(x)
    if abs(z.imag) > 0 and not _is_complex_base(base):
        cb = CDF if base is RDF else _sa().CC
        return cb(z.real, z.imag) if cb is CDF else cb(z.real, z.imag)
    if _is_complex_base(base):
        return base(z.real, z.imag) if base is CDF else base(z)
    return base(z.real)


def _from_array(base, a):
    import _sage_ffmat
    rows = [[_elt(base, x) for x in r] for r in a.tolist()]
    b = base
    if not _is_complex_base(base) and any(_is_complex_base(x.parent()) for r in rows for x in r if hasattr(x, "parent")):
        b = CDF if base is RDF else _sa().CC
        rows = [[b(complex(x)) for x in r] for r in rows]
    return _sage_ffmat.FFMatrix(b, rows, a.shape[1] if len(a.shape) > 1 else 0)


def _det(M):
    """The determinant (LU with partial pivoting)."""
    np = _np()
    if not M.is_square():
        raise ValueError("self must be a square matrix")
    n = M.nrows()
    if n == 0:
        return M._base.one()
    if n <= 3:
        # small matrices: by the cofactor formula, as Sage
        a = M._rows
        if n == 1:
            return a[0][0]
        if n == 2:
            return a[0][0] * a[1][1] - a[0][1] * a[1][0]
        return (a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
                - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
                + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]))
    return _elt(M._base, np.linalg.det(_array(M)))


def _inverse(M):
    np = _np()
    if not M.is_square():
        raise ArithmeticError("self must be a square matrix")
    return _from_array(M._base, np.linalg.inv(_array(M)))


def _rank(M):
    np = _np()
    if M.nrows() == 0 or M.ncols() == 0:
        return _sa().Integer(0)
    return _sa().Integer(int(np.linalg.matrix_rank(_array(M))))


def _eigenvalues(M, *args, **kwds):
    """The eigenvalues, in the order LAPACK gives them."""
    np = _np()
    w = np.linalg.eigvals(_array(M))
    out = []
    real = all(abs(complex(x).imag) == 0 for x in w.tolist())
    for x in w.tolist():
        z = complex(x)
        if real and not _is_complex_base(M._base):
            out.append(M._base(z.real) if M._base is not RDF else RealDoubleElement(z.real))
        else:
            out.append(CDF(z.real, z.imag) if M._base in (RDF, CDF) else _sa().CC(z.real, z.imag))
    return out


def _eigenvectors_right(M, *args, **kwds):
    """[(eigenvalue, [unit eigenvector], 1)], as LAPACK gives them."""
    np = _np()
    w, v = np.linalg.eig(_array(M))
    return _pairs(M, w, v)


def _eigenvectors_left(M, *args, **kwds):
    np = _np()
    w, v = np.linalg.eig(_array(M).T)
    return _pairs(M, w, v)


def _pairs(M, w, v):
    out = []
    ws = w.tolist()
    vs = v.tolist()
    real = all(abs(complex(x).imag) == 0 for x in ws) and all(abs(complex(x).imag) == 0 for r in vs for x in r)
    base = M._base if real or _is_complex_base(M._base) else (CDF if M._base is RDF else _sa().CC)
    for j, lam in enumerate(ws):
        vec = [_elt(base, r[j]) for r in vs]
        out.append((_elt(base, lam), [_sa().vector(base, vec)], 1))
    return out


def _eigenmatrix_right(M):
    np = _np()
    w, v = np.linalg.eig(_array(M))
    n = len(w.tolist())
    import _sage_ffmat
    base = M._base
    D = _from_array(base, np.diag(w))
    P = _from_array(base, v)
    return D, P


def _SVD(M):
    """(U, S, V) with self = U S V^*."""
    np = _np()
    u, s, vh = np.linalg.svd(_array(M))
    m, n = M.nrows(), M.ncols()
    S = np.zeros((m, n))
    for i, x in enumerate(s.tolist()):
        S[i][i] = x
    V = vh.conj().T if _is_complex_base(M._base) else vh.T
    return _from_array(M._base, u), _from_array(M._base, S), _from_array(M._base, V)


def _singular_values(M):
    np = _np()
    return [RealDoubleElement(x) for x in np.linalg.svd(_array(M), compute_uv=False).tolist()]


def _QR(M):
    np = _np()
    q, r = np.linalg.qr(_array(M), mode="complete")
    return _from_array(M._base, q), _from_array(M._base, r)


def _norm(M, p=2):
    np = _np()
    a = _array(M)
    if p == "frob" or p == "fro":
        return RealDoubleElement(float(np.linalg.norm(a, "fro")))
    if p == _Infinity_sym():
        return RealDoubleElement(float(np.linalg.norm(a, np.inf)))
    return RealDoubleElement(float(np.linalg.norm(a, p)))


def _Infinity_sym():
    return float("inf")


def _solve_right(M, b):
    np = _np()
    import _sage_ffmat
    if isinstance(b, _sage_ffmat.FFMatrix):
        return _from_array(M._base, np.linalg.solve(_array(M), _array(b)))
    x = np.linalg.solve(_array(M), np.array([complex(t) if _is_complex_base(M._base) else float(t) for t in b]))
    return _sa().vector(M._base, [_elt(M._base, t) for t in x.tolist()])


def _numpy(M, dtype=None):
    return _array(M)


def _is_symmetric(M, tol=0):
    return M.is_square() and all(abs(complex(M._rows[i][j]) - complex(M._rows[j][i])) <= tol for i in range(M.nrows()) for j in range(M.ncols()))


def _diagonal(M):
    return [M._rows[i][i] for i in range(min(M.nrows(), M.ncols()))]


NUMERIC = {
    "eigenvalues": _eigenvalues, "eigenvectors_right": _eigenvectors_right, "eigenvectors_left": _eigenvectors_left,
    "right_eigenvectors": _eigenvectors_right, "left_eigenvectors": _eigenvectors_left,
    "eigenmatrix_right": _eigenmatrix_right, "SVD": _SVD, "singular_values": _singular_values, "QR": _QR,
    "norm": _norm, "numpy": _numpy, "is_symmetric": _is_symmetric,
}
