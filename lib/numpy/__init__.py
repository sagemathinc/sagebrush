"""numpy for sagebrush: NumPy's API over the ndarray core in the runtime
(src/runtime/numpy.ts, module _numpy).

Arrays are typed-array views (shape, strides, offset); broadcasting,
indexing, NumPy 2's type promotion, pairwise summation and printing follow
NumPy, and the behaviour is checked against NumPy itself (see NUMPY.md).
The one deliberate difference: int64 and uint64 arrays are exact only up to
2**53.
"""

import math as _math
import builtins as _builtins
import _numpy as _np
from _numpy import ndarray, dtype

__version__ = "2.5.1+sagebrush"

pi = _math.pi
e = _math.e
euler_gamma = 0.5772156649015329
inf = Inf = PINF = float("inf")
NINF = -inf
nan = NaN = NAN = float("nan")
newaxis = None
little_endian = True


# ------------------------------------------------------------------ scalar types

class generic:
    """Base of NumPy's scalar types."""
    __slots__ = ()

    @property
    def dtype(self):
        return dtype(type(self).__name__ if type(self).__name__ != "bool_" else "bool")

    def item(self):
        return _PLAIN[type(self)](self)

    @property
    def shape(self):
        return ()

    @property
    def ndim(self):
        return 0

    @property
    def size(self):
        return 1

    def tolist(self):
        return self.item()

    def astype(self, dt):
        return array(self).astype(dt)[()]


class number(generic):
    __slots__ = ()


class integer(number):
    __slots__ = ()


class signedinteger(integer):
    __slots__ = ()


class unsignedinteger(integer):
    __slots__ = ()


class inexact(number):
    __slots__ = ()


class floating(inexact):
    __slots__ = ()


class complexfloating(inexact):
    __slots__ = ()


def _binop(name, rev=False):
    def f(self, other):
        if not isinstance(other, (int, float, complex, ndarray, generic)):
            return NotImplemented
        return _np.binary(name, other, self) if rev else _np.binary(name, self, other)
    f.__name__ = name
    return f


def _unop(name):
    def f(self):
        return getattr(_np, "u_" + name)(self)
    return f


def _arith(cls):
    for py, op in (("add", "add"), ("sub", "subtract"), ("mul", "multiply"), ("truediv", "true_divide"),
                   ("floordiv", "floor_divide"), ("mod", "remainder"), ("pow", "power")):
        setattr(cls, "__%s__" % py, _binop(op))
        setattr(cls, "__r%s__" % py, _binop(op, True))
    for py, op in (("lt", "less"), ("le", "less_equal"), ("gt", "greater"), ("ge", "greater_equal"),
                   ("eq", "equal"), ("ne", "not_equal")):
        setattr(cls, "__%s__" % py, _binop(op))
    cls.__neg__ = _unop("negative")
    cls.__pos__ = _unop("positive")
    cls.__abs__ = _unop("absolute")
    return cls


@_arith
class float64(float, floating):
    __slots__ = ()
    __hash__ = float.__hash__

    def __new__(cls, v=0.0):
        if isinstance(v, (list, tuple, ndarray)):
            return asarray(v, float64)  # as NumPy: a sequence gives an array
        return float.__new__(cls, v)

    def __repr__(self):
        return "np.float64(%s)" % float.__repr__(self)

    def __str__(self):
        return float.__repr__(self)

    def is_integer(self):
        return float.is_integer(self)


def _f32(v):
    return _np.array([float(v)], "float32").item()


@_arith
class float32(float, floating):
    __slots__ = ()
    __hash__ = float.__hash__

    def __new__(cls, v=0.0):
        if isinstance(v, (list, tuple, ndarray)):
            return asarray(v, float32)
        return float.__new__(cls, _f32(v))

    def __repr__(self):
        return "np.float32(%s)" % _np.format_f32(float(self))

    def __str__(self):
        return _np.format_f32(float(self))


float16 = half = float32


def _intrepr(name):
    def r(self):
        return "np.%s(%s)" % (name, int.__repr__(self))
    return r


_INT_NAMES = ("int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64")
_g = globals()
for _name in _INT_NAMES:
    _base = unsignedinteger if _name.startswith("u") else signedinteger
    _cls = type(_name, (int, _base), {"__slots__": (), "__repr__": _intrepr(_name),
                                     "__str__": int.__repr__, "__hash__": int.__hash__})
    _arith(_cls)
    _g[_name] = _cls


@_arith
class bool(int, generic):
    """np.bool_ (an int subclass here; NumPy's is not, but it compares the same)."""
    __slots__ = ()
    __hash__ = int.__hash__

    def __new__(cls, v=False):
        return int.__new__(cls, 1 if _builtins.bool(v) else 0)

    def __repr__(self):
        return "np.True_" if self else "np.False_"

    def __str__(self):
        return "True" if self else "False"

    def __bool__(self):
        return int(self) != 0

    def __and__(self, o):
        return _np.binary("logical_and", self, o) if isinstance(o, (_builtins.bool, bool_)) else _np.binary("bitwise_and", self, o)

    def __or__(self, o):
        return _np.binary("logical_or", self, o) if isinstance(o, (_builtins.bool, bool_)) else _np.binary("bitwise_or", self, o)

    def __invert__(self):
        return bool_(not self)

    def __format__(self, spec):
        return format(_builtins.bool(self), spec)


bool_ = bool  # NumPy 2 calls it np.bool, with np.bool_ an alias


@_arith
class complex128(complex, complexfloating):
    __slots__ = ()
    __hash__ = complex.__hash__

    def __repr__(self):
        r = complex.__repr__(self)
        return "np.complex128(%s)" % (r[1:-1] if r.startswith("(") else r)

    def __str__(self):
        return complex.__repr__(self)


@_arith
class complex64(complex, complexfloating):
    __slots__ = ()
    __hash__ = complex.__hash__

    def __repr__(self):
        r = complex.__repr__(self)
        return "np.complex64(%s)" % (r[1:-1] if r.startswith("(") else r)

    def __str__(self):
        return complex.__repr__(self)


True_ = bool_(True)
False_ = bool_(False)

_PLAIN = {float64: float, float32: float, complex128: complex, complex64: complex, bool_: _builtins.bool}
for _name in _INT_NAMES:
    _PLAIN[_g[_name]] = int
for _name, _cls in (("float64", float64), ("float32", float32), ("complex128", complex128), ("bool", bool_),
                    ("int8", int8), ("int16", int16), ("int32", int32), ("int64", int64),
                    ("uint8", uint8), ("uint16", uint16), ("uint32", uint32), ("uint64", uint64)):
    _np.register_scalar(_name, _cls)
_np.register_scalar("complex64", complex64)

double = float_ = float64
single = float32
int_ = intp = long = int64
uint = uintp = uint64
byte, ubyte, short, ushort, intc, uintc = int8, uint8, int16, uint16, int32, uint32
longlong, ulonglong = int64, uint64
cdouble = complex_ = complex128
csingle = complex64


class finfo:
    def __init__(self, dt=float64):
        dt = dtype(dt)
        self.dtype = dt
        if dt.name in ("float32", "complex64"):
            self.eps, self.max, self.tiny, self.bits, self.precision, self.resolution = 1.1920929e-07, 3.4028235e+38, 1.1754944e-38, 32, 6, 1e-06
        else:
            self.eps, self.max, self.tiny, self.bits, self.precision, self.resolution = 2.220446049250313e-16, 1.7976931348623157e+308, 2.2250738585072014e-308, 64, 15, 1e-15
        self.min = -self.max
        self.smallest_normal = self.tiny

    def __repr__(self):
        return "finfo(resolution=%s, min=%s, max=%s, dtype=%s)" % (self.resolution, self.min, self.max, self.dtype)


class iinfo:
    def __init__(self, dt=int64):
        dt = dtype(dt)
        self.dtype = dt
        self.bits = dt.itemsize * 8
        if dt.kind == "u":
            self.min, self.max = 0, 2 ** self.bits - 1
        else:
            self.min, self.max = -2 ** (self.bits - 1), 2 ** (self.bits - 1) - 1

    def __repr__(self):
        return "iinfo(min=%d, max=%d, dtype=%s)" % (self.min, self.max, self.dtype)


def issubdtype(arg1, arg2):
    kinds = {number: "biufc", integer: "iu", signedinteger: "i", unsignedinteger: "u", inexact: "fc",
             floating: "f", complexfloating: "c", generic: "biufc", bool_: "b"}
    k = dtype(arg1).kind
    if arg2 in kinds:
        return k in kinds[arg2]
    return dtype(arg1) == dtype(arg2)


def result_type(*arrays_and_dtypes):
    return _np.result_type(*arrays_and_dtypes)


def promote_types(type1, type2):
    return _np.result_type(dtype(type1), dtype(type2))


def can_cast(from_, to, casting="safe"):
    a, b = dtype(from_), dtype(to)
    if a == b or casting == "unsafe":
        return True
    return _np.result_type(a, b) == b


# ------------------------------------------------------------------ creation

def array(object, dtype=None, *, copy=True, order="K", subok=False, ndmin=0, like=None):
    return _np.array(object, dtype, copy, ndmin)


def asarray(a, dtype=None, order=None, *, copy=None, like=None):
    return _np.asarray(a, dtype)


asanyarray = ascontiguousarray = asfarray = asarray


def copy(a, order="K", subok=False):
    return _np.copy(a)


def _shape(shape):
    return shape if isinstance(shape, (tuple, list)) else (shape,)


def zeros(shape, dtype=float, order="C", *, like=None):
    return _np.zeros(_shape(shape), dtype)


def ones(shape, dtype=None, order="C", *, like=None):
    return _np.ones(_shape(shape), dtype)


def empty(shape, dtype=float, order="C", *, like=None):
    return _np.zeros(_shape(shape), dtype)


def full(shape, fill_value, dtype=None, order="C", *, like=None):
    return _np.full(_shape(shape), fill_value, dtype)


def zeros_like(a, dtype=None, order="K", subok=True, shape=None):
    a = asarray(a)
    return zeros(a.shape if shape is None else shape, a.dtype if dtype is None else dtype)


def ones_like(a, dtype=None, order="K", subok=True, shape=None):
    a = asarray(a)
    return ones(a.shape if shape is None else shape, a.dtype if dtype is None else dtype)


empty_like = zeros_like


def full_like(a, fill_value, dtype=None, order="K", subok=True, shape=None):
    a = asarray(a)
    return full(a.shape if shape is None else shape, fill_value, a.dtype if dtype is None else dtype)


def arange(start, stop=None, step=None, dtype=None, *, like=None):
    return _np.arange(start, stop, step, dtype)


def linspace(start, stop, num=50, endpoint=True, retstep=False, dtype=None, axis=0):
    a = _np.linspace(start, stop, num, endpoint, dtype)
    if retstep:
        div = (num - 1) if endpoint else num
        return a, ((stop - start) / div if div > 0 else nan)
    return a


def logspace(start, stop, num=50, endpoint=True, base=10.0, dtype=None, axis=0):
    return power(base, linspace(start, stop, num, endpoint)).astype(dtype or float64)


def geomspace(start, stop, num=50, endpoint=True, dtype=None, axis=0):
    out = power(10.0, linspace(_math.log10(start), _math.log10(stop), num, endpoint))
    if num > 0:
        out[0] = start
        if endpoint and num > 1:
            out[-1] = stop
    return out


def eye(N, M=None, k=0, dtype=float, order="C", *, like=None):
    return _np.eye(N, M, k, dtype)


def identity(n, dtype=None, *, like=None):
    return eye(n, dtype=dtype or float)


def diag(v, k=0):
    v = asarray(v)
    if v.ndim == 1:
        n = v.shape[0] + _builtins.abs(k)
        out = zeros((n, n), v.dtype)
        for i in range(v.shape[0]):
            out[i + _builtins.max(-k, 0), i + _builtins.max(k, 0)] = v[i]
        return out
    return diagonal(v, k)


def diagonal(a, offset=0, axis1=0, axis2=1):
    a = asarray(a)
    n = _builtins.min(a.shape[0] - _builtins.max(-offset, 0), a.shape[1] - _builtins.max(offset, 0))
    idx = arange(_builtins.max(n, 0))
    return a[idx + _builtins.max(-offset, 0), idx + _builtins.max(offset, 0)]


def tri(N, M=None, k=0, dtype=float):
    M = N if M is None else M
    return greater_equal.outer(arange(N), arange(-k, M - k)).astype(dtype)


def tril(m, k=0):
    m = asarray(m)
    return where(tri(m.shape[-2], m.shape[-1], k, dtype=bool_), m, zeros(1, m.dtype))


def triu(m, k=0):
    m = asarray(m)
    return where(tri(m.shape[-2], m.shape[-1], k - 1, dtype=bool_), zeros(1, m.dtype), m)


def meshgrid(*xi, indexing="xy", sparse=False, copy=True):
    xs = [asarray(x).ravel() for x in xi]
    n = len(xs)
    shape = [len(x) for x in xs]
    if indexing == "xy" and n >= 2:
        shape[0], shape[1] = shape[1], shape[0]
    out = []
    for i, x in enumerate(xs):
        s = [1] * n
        j = i
        if indexing == "xy" and n >= 2 and i < 2:
            j = 1 - i
        s[j] = len(x)
        out.append(broadcast_to(x.reshape(s), shape).copy())
    return out


def indices(dimensions, dtype=int):
    out = []
    n = len(dimensions)
    for i, d in enumerate(dimensions):
        s = [1] * n
        s[i] = d
        out.append(broadcast_to(arange(d, dtype=dtype).reshape(s), tuple(dimensions)).copy())
    return array(out)


def fromfunction(function, shape, *, dtype=float, **kwargs):
    grids = indices(shape, dtype=dtype)
    return function(*grids, **kwargs)


def fromiter(iterable, dtype, count=-1):
    return array(list(iterable), dtype=dtype)


# ------------------------------------------------------------------ ufuncs

class ufunc:
    def __init__(self, name, nin, op=None, identity=None):
        self.__name__ = name
        self.nin = nin
        self.nout = 1
        self._op = op or name
        self.identity = identity

    def __repr__(self):
        return "<ufunc '%s'>" % self.__name__

    def __call__(self, *args, out=None, dtype=None, where=True, casting="same_kind", **kw):
        if len(args) != self.nin:
            if len(args) == self.nin + 1 and out is None:
                out = args[-1]
                args = args[:-1]
            else:
                raise TypeError("%s() takes from %d to %d positional arguments but %d were given" % (self.__name__, self.nin, self.nin + 1, len(args)))
        if self.nin == 1:
            r = getattr(_np, "u_" + self._op)(args[0])
        else:
            r = _np.binary(self._op, args[0], args[1])
        if dtype is not None:
            r = asarray(r).astype(dtype)
        if where is not True:
            r = _np.where3(where, r, out if out is not None else r)
        if out is not None:
            if isinstance(out, tuple):
                out = out[0]
            out[...] = r
            return out
        return r

    def reduce(self, a, axis=0, dtype=None, out=None, keepdims=False, initial=None, where=True):
        a = asarray(a)
        quick = {"add": sum, "multiply": prod, "maximum": amax, "minimum": amin, "logical_and": all,
                 "logical_or": any}
        if self._op in quick and initial is None:
            return quick[self._op](a, axis=axis, keepdims=keepdims)
        if axis is None:
            a, axis = a.ravel(), 0
        a = moveaxis(a, axis, 0)
        if a.shape[0] == 0:
            if initial is not None:
                return full(a.shape[1:], initial)
            raise ValueError("zero-size array to reduction operation %s which has no identity" % self.__name__)
        acc = a[0] if initial is None else self(initial, a[0])
        for i in range(1, a.shape[0]):
            acc = self(acc, a[i])
        return acc

    def accumulate(self, a, axis=0, dtype=None, out=None):
        a = asarray(a)
        if self._op == "add":
            return cumsum(a, axis=axis, dtype=dtype)
        if self._op == "multiply":
            return cumprod(a, axis=axis, dtype=dtype)
        a = moveaxis(a, axis, 0)
        res = []
        acc = None
        for i in range(a.shape[0]):
            acc = a[i] if acc is None else self(acc, a[i])
            res.append(acc)
        return moveaxis(array(res), 0, axis)

    def outer(self, A, B, **kw):
        A, B = asarray(A), asarray(B)
        return self(A.reshape(A.shape + (1,) * B.ndim), B)


_BINARY = ["add", "subtract", "multiply", "true_divide", "floor_divide", "remainder", "power",
           "maximum", "minimum", "fmax", "fmin", "arctan2", "hypot", "copysign", "logaddexp",
           "equal", "not_equal", "less", "less_equal", "greater", "greater_equal",
           "logical_and", "logical_or", "logical_xor", "bitwise_and", "bitwise_or", "bitwise_xor",
           "left_shift", "right_shift"]
_UNARY = ["negative", "positive", "absolute", "sign", "square", "sqrt", "cbrt", "exp", "exp2", "expm1",
          "log", "log2", "log10", "log1p", "sin", "cos", "tan", "arcsin", "arccos", "arctan", "sinh",
          "cosh", "tanh", "arcsinh", "arccosh", "arctanh", "deg2rad", "rad2deg", "floor", "ceil",
          "trunc", "rint", "reciprocal", "isnan", "isinf", "isfinite", "signbit", "logical_not", "invert"]
for _name in _BINARY:
    _g[_name] = ufunc(_name, 2)
for _name in _UNARY:
    _g[_name] = ufunc(_name, 1)
divide = true_divide
mod = remainder
abs = absolute
fabs = absolute
degrees, radians = rad2deg, deg2rad
bitwise_not = bitwise_invert = invert
pow = power
acos, asin, atan, atan2 = arccos, arcsin, arctan, arctan2
acosh, asinh, atanh = arccosh, arcsinh, arctanh


def float_power(x, y):
    return power(asarray(x, float64), y)


def conjugate(x):
    x = asarray(x)
    return x.conj() if x.ndim else x.conj()[()]


conj = conjugate


def real(val):
    v = asarray(val)
    return v.real if v.ndim else v.real[()]


def imag(val):
    v = asarray(val)
    return v.imag if v.ndim else v.imag[()]


def angle(z, deg=False):
    z = asarray(z)
    a = arctan2(z.imag, z.real)
    return rad2deg(a) if deg else a


def iscomplexobj(x):
    return asarray(x).dtype.kind == "c"


def isrealobj(x):
    return not iscomplexobj(x)


def around(a, decimals=0, out=None):
    a = asarray(a)
    if a.dtype.kind in "iub" and decimals >= 0:
        return a.copy() if a.ndim else a[()]
    if decimals == 0:
        r = rint(a)
    else:
        f = 10.0 ** decimals
        r = rint(a * f) / f
    return r if a.ndim else r[()]


round = round_ = around


def clip(a, a_min=None, a_max=None, out=None, **kw):
    if a_min is None and "min" in kw:
        a_min = kw["min"]
    if a_max is None and "max" in kw:
        a_max = kw["max"]
    r = asarray(a)
    if a_min is not None:
        r = maximum(r, a_min)
    if a_max is not None:
        r = minimum(r, a_max)
    return _out(r, out)


def nan_to_num(x, copy=True, nan=0.0, posinf=None, neginf=None):
    x = asarray(x).copy()
    if x.dtype.kind != "f":
        return x
    big = finfo(x.dtype).max
    x[isnan(x)] = nan
    x[isposinf(x)] = big if posinf is None else posinf
    x[isneginf(x)] = -big if neginf is None else neginf
    return x


def isposinf(x):
    return logical_and(isinf(x), greater(x, 0))


def isneginf(x):
    return logical_and(isinf(x), less(x, 0))


def heaviside(x1, x2):
    x1 = asarray(x1, float64)
    return where(x1 < 0, 0.0, where(x1 > 0, 1.0, x2))


def sinc(x):
    x = asarray(x, float64)
    y = pi * where(x == 0, 1.0e-20, x)
    return sin(y) / y


def gcd(a, b):
    a, b = asarray(a), asarray(b)
    shape = broadcast_shapes(a.shape, b.shape)
    av, bv = broadcast_to(a, shape).ravel().tolist(), broadcast_to(b, shape).ravel().tolist()
    out = array([_math.gcd(int(x), int(y)) for x, y in zip(av, bv)], dtype=result_type(a, b))
    return out.reshape(shape) if shape else out[0]


def lcm(a, b):
    a, b = asarray(a), asarray(b)
    shape = broadcast_shapes(a.shape, b.shape)
    av, bv = broadcast_to(a, shape).ravel().tolist(), broadcast_to(b, shape).ravel().tolist()
    out = array([_math.lcm(int(x), int(y)) for x, y in zip(av, bv)], dtype=result_type(a, b))
    return out.reshape(shape) if shape else out[0]


# ------------------------------------------------------------------ reductions

def _axes(a, axis):
    if axis is None:
        return tuple(range(a.ndim))
    if isinstance(axis, (tuple, list)):
        return tuple(x % a.ndim for x in axis)
    return (axis % a.ndim if a.ndim else 0,)


def _count(a, axis):
    n = 1
    for ax in _axes(a, axis):
        n *= a.shape[ax]
    return n


def _out(r, out):
    if out is not None:
        out[...] = r
        return out
    return r


def sum(a, axis=None, dtype=None, out=None, keepdims=False, initial=None, where=True):
    a = asarray(a)
    if where is not True:
        a = _np.where3(where, a, zeros(1, a.dtype))
    r = _np.sum(a, axis, keepdims, dtype)
    if initial is not None:
        r = r + initial
    return _out(r, out)


def prod(a, axis=None, dtype=None, out=None, keepdims=False, initial=None, where=True):
    r = _np.prod(asarray(a), axis, keepdims, dtype)
    if initial is not None:
        r = r * initial
    return _out(r, out)


product = prod


def mean(a, axis=None, dtype=None, out=None, keepdims=False, *, where=True):
    a = asarray(a)
    n = _count(a, axis)
    if dtype is None and a.dtype.kind in "biu":
        dtype = float64
    s = _np.sum(a, axis, keepdims, dtype)
    return _out(s / n if n else s / 0.0, out)


def var(a, axis=None, dtype=None, out=None, ddof=0, keepdims=False, *, where=True, mean=None, correction=None):
    if correction is not None:
        ddof = correction
    a = asarray(a)
    n = _count(a, axis)
    if dtype is None and a.dtype.kind in "biu":
        dtype = float64
    arrmean = asarray(_np.sum(a, axis, True, dtype)) / n
    if axis is None and dtype is None and not keepdims:
        r = _np.sqdev_sum(a, arrmean.ravel()[0])  # no temporaries, the same bits
        if r is not None:
            return _out(float64(r) / _builtins.max(n - ddof, 0), out)
    x = asarray(a - arrmean)
    if x.dtype.kind == "c":
        x = (x * x.conj()).real
    elif x.dtype.kind == "f":
        x *= x  # in place, as NumPy
    else:
        x = x * x
    r = _np.sum(x, axis, keepdims, dtype)
    return _out(r / _builtins.max(n - ddof, 0), out)


def std(a, axis=None, dtype=None, out=None, ddof=0, keepdims=False, *, where=True, mean=None, correction=None):
    return _out(sqrt(var(a, axis, dtype, None, ddof, keepdims, correction=correction)), out)


def amax(a, axis=None, out=None, keepdims=False, initial=None, where=True):
    r = _np.amax(asarray(a), axis, keepdims)
    if initial is not None:
        r = maximum(r, initial)
    return _out(r, out)


def amin(a, axis=None, out=None, keepdims=False, initial=None, where=True):
    r = _np.amin(asarray(a), axis, keepdims)
    if initial is not None:
        r = minimum(r, initial)
    return _out(r, out)


max = amax
min = amin


def argmax(a, axis=None, out=None, *, keepdims=False):
    r = _np.argmax(asarray(a), axis)
    if keepdims and axis is not None:
        r = expand_dims(r, axis)
    return r


def argmin(a, axis=None, out=None, *, keepdims=False):
    r = _np.argmin(asarray(a), axis)
    if keepdims and axis is not None:
        r = expand_dims(r, axis)
    return r


def ptp(a, axis=None, out=None, keepdims=False):
    return amax(a, axis, keepdims=keepdims) - amin(a, axis, keepdims=keepdims)


def all(a, axis=None, out=None, keepdims=False, *, where=True):
    return _out(_np.all(asarray(a), axis, keepdims), out)


def any(a, axis=None, out=None, keepdims=False, *, where=True):
    return _out(_np.any(asarray(a), axis, keepdims), out)


def cumsum(a, axis=None, dtype=None, out=None):
    return _out(_np.cumsum(asarray(a), axis, dtype), out)


def cumprod(a, axis=None, dtype=None, out=None):
    return _out(_np.cumprod(asarray(a), axis, dtype), out)


cumulative_sum = cumsum
cumulative_prod = cumprod


def count_nonzero(a, axis=None, *, keepdims=False):
    return sum(asarray(a) != 0, axis=axis, keepdims=keepdims)


def _nanfill(a, value):
    a = asarray(a)
    if a.dtype.kind not in "fc":
        return a
    return where(isnan(a), value, a)


def nansum(a, axis=None, dtype=None, out=None, keepdims=False):
    return sum(_nanfill(a, 0), axis, dtype, out, keepdims)


def nanprod(a, axis=None, dtype=None, out=None, keepdims=False):
    return prod(_nanfill(a, 1), axis, dtype, out, keepdims)


def nanmax(a, axis=None, out=None, keepdims=False):
    return amax(_nanfill(a, -inf), axis, out, keepdims)


def nanmin(a, axis=None, out=None, keepdims=False):
    return amin(_nanfill(a, inf), axis, out, keepdims)


def nanmean(a, axis=None, dtype=None, out=None, keepdims=False):
    a = asarray(a)
    ok = ~isnan(a) if a.dtype.kind in "fc" else ones(a.shape, bool_)
    return sum(_nanfill(a, 0), axis, dtype, out, keepdims) / sum(ok, axis, keepdims=keepdims)


def nanvar(a, axis=None, dtype=None, out=None, ddof=0, keepdims=False):
    a = asarray(a)
    ok = ~isnan(a)
    n = sum(ok, axis, keepdims=True)
    m = sum(_nanfill(a, 0), axis, keepdims=True) / n
    d = where(ok, a - m, 0.0)
    return sum(d * d, axis, keepdims=keepdims) / (sum(ok, axis, keepdims=keepdims) - ddof)


def nanstd(a, axis=None, dtype=None, out=None, ddof=0, keepdims=False):
    return sqrt(nanvar(a, axis, dtype, out, ddof, keepdims))


def nanargmax(a, axis=None):
    return argmax(_nanfill(a, -inf), axis)


def nanargmin(a, axis=None):
    return argmin(_nanfill(a, inf), axis)


def median(a, axis=None, out=None, overwrite_input=False, keepdims=False):
    return quantile(a, 0.5, axis=axis, keepdims=keepdims)


def nanmedian(a, axis=None, out=None, overwrite_input=False, keepdims=False):
    a = asarray(a)
    if axis is None:
        a = a.ravel()
        return median(a[~isnan(a)])
    return apply_along_axis(lambda r: median(r[~isnan(r)]), axis, a)


def quantile(a, q, axis=None, out=None, overwrite_input=False, method="linear", keepdims=False):
    a = asarray(a)
    if axis is None:
        a, axis = a.ravel(), 0
    s = moveaxis(sort(a, axis=axis), axis, -1)
    n = s.shape[-1]
    qs = asarray(q, float64)
    vals = []
    for qq in qs.ravel().tolist():
        if not (0 <= qq <= 1):
            raise ValueError("Quantiles must be in the range [0, 1]")
        virtual = (n - 1) * qq
        if method in ("lower", "higher", "nearest"):
            k = {"lower": _math.floor, "higher": _math.ceil, "nearest": _builtins.round}[method](virtual)
            vals.append(s[..., int(k)])
            continue
        lo = int(_math.floor(virtual))
        hi = _builtins.min(lo + 1, n - 1)
        if method == "midpoint":
            vals.append((asarray(s[..., lo], float64) + s[..., hi]) / 2)
            continue
        t = virtual - lo
        av, bv = asarray(s[..., lo], float64), asarray(s[..., hi], float64)
        diff_b_a = bv - av
        vals.append(where(t >= 0.5, bv - diff_b_a * (1 - t), av + diff_b_a * t))  # NumPy's _lerp
    res = array(vals) if qs.ndim else asarray(vals[0])
    if qs.ndim:
        res = res.reshape(qs.shape + res.shape[1:])
    if keepdims:
        res = expand_dims(res, axis if qs.ndim == 0 else axis + qs.ndim)
    return res if res.ndim else res[()]


def percentile(a, q, axis=None, out=None, overwrite_input=False, method="linear", keepdims=False):
    return quantile(a, asarray(q, float64) / 100, axis=axis, method=method, keepdims=keepdims)


def average(a, axis=None, weights=None, returned=False, *, keepdims=False):
    a = asarray(a)
    if weights is None:
        avg = mean(a, axis, keepdims=keepdims)
        scl = float64(_count(a, axis))
    else:
        w = asarray(weights)
        if w.shape != a.shape and axis is not None:
            s = [1] * a.ndim
            s[axis] = w.shape[0]
            w = w.reshape(s)
        scl = sum(broadcast_to(w, a.shape) * 1.0, axis, keepdims=keepdims)
        avg = sum(a * w, axis, keepdims=keepdims) / scl
    return (avg, scl) if returned else avg


def cov(m, y=None, rowvar=True, bias=False, ddof=None):
    X = atleast_2d(asarray(m, float64))
    if not rowvar and X.shape[0] != 1:
        X = X.T
    if y is not None:
        y = atleast_2d(asarray(y, float64))
        if not rowvar and y.shape[0] != 1:
            y = y.T
        X = concatenate((X, y), axis=0)
    if ddof is None:
        ddof = 0 if bias else 1
    n = X.shape[1]
    X = X - mean(X, axis=1, keepdims=True)
    c = X @ X.T.conj() / (n - ddof)
    return c.squeeze() if c.size == 1 else c


def corrcoef(x, y=None, rowvar=True):
    c = cov(x, y, rowvar)
    if asarray(c).ndim == 0:
        return c / c
    d = sqrt(diag(c))
    c = c / d[:, None]
    c = c / d[None, :]
    return clip(c, -1, 1)


# ------------------------------------------------------------------ shapes

def shape(a):
    return asarray(a).shape


def ndim(a):
    return asarray(a).ndim


def size(a, axis=None):
    a = asarray(a)
    return a.size if axis is None else a.shape[axis]


def reshape(a, shape=None, order="C", *, newshape=None, copy=None):
    return _np.reshape(asarray(a), _shape(shape if shape is not None else newshape))


def ravel(a, order="C"):
    return _np.ravel(asarray(a))


def transpose(a, axes=None):
    return _np.transpose(asarray(a), axes)


def swapaxes(a, axis1, axis2):
    return asarray(a).swapaxes(axis1, axis2)


def moveaxis(a, source, destination):
    a = asarray(a)
    src = [s % a.ndim for s in (source if isinstance(source, (tuple, list)) else [source])]
    dst = [d % a.ndim for d in (destination if isinstance(destination, (tuple, list)) else [destination])]
    order = [i for i in range(a.ndim) if i not in src]
    for d, s in sorted(zip(dst, src)):
        order.insert(d, s)
    return _np.transpose(a, order)


def squeeze(a, axis=None):
    a = asarray(a)
    if axis is None:
        return a.reshape(tuple(n for n in a.shape if n != 1))
    axes = [x % a.ndim for x in (axis if isinstance(axis, (tuple, list)) else [axis])]
    for x in axes:
        if a.shape[x] != 1:
            raise ValueError("cannot select an axis to squeeze out which has size not equal to one")
    return a.reshape(tuple(n for i, n in enumerate(a.shape) if i not in axes))


def expand_dims(a, axis):
    a = asarray(a)
    axes = axis if isinstance(axis, (tuple, list)) else [axis]
    nd = a.ndim + len(axes)
    shape = list(a.shape)
    for x in sorted(x % nd for x in axes):
        shape.insert(x, 1)
    return a.reshape(shape)


def atleast_1d(*arys):
    res = [asarray(a) if asarray(a).ndim >= 1 else asarray(a).reshape(1) for a in arys]
    return res[0] if len(res) == 1 else res


def atleast_2d(*arys):
    res = []
    for a in arys:
        a = asarray(a)
        res.append(a.reshape(1, 1) if a.ndim == 0 else a.reshape(1, -1) if a.ndim == 1 else a)
    return res[0] if len(res) == 1 else res


def atleast_3d(*arys):
    res = []
    for a in arys:
        a = asarray(a)
        if a.ndim == 0:
            a = a.reshape(1, 1, 1)
        elif a.ndim == 1:
            a = a.reshape(1, -1, 1)
        elif a.ndim == 2:
            a = a.reshape(a.shape + (1,))
        res.append(a)
    return res[0] if len(res) == 1 else res


def concatenate(arrays, axis=0, out=None, dtype=None):
    r = _np.concatenate([asarray(a) for a in arrays], axis)
    if dtype is not None:
        r = r.astype(dtype)
    return _out(r, out)


concat = concatenate


def stack(arrays, axis=0, out=None):
    arrs = [asarray(a) for a in arrays]
    if not arrs:
        raise ValueError("need at least one array to stack")
    for a in arrs:
        if a.shape != arrs[0].shape:
            raise ValueError("all input arrays must have the same shape")
    ax = axis % (arrs[0].ndim + 1)
    return concatenate([expand_dims(a, ax) for a in arrs], axis=ax)


def vstack(tup, *, dtype=None):
    return concatenate([atleast_2d(a) for a in tup], axis=0, dtype=dtype)


row_stack = vstack


def hstack(tup, *, dtype=None):
    arrs = [atleast_1d(a) for a in tup]
    return concatenate(arrs, axis=0 if arrs[0].ndim == 1 else 1, dtype=dtype)


def dstack(tup):
    return concatenate([atleast_3d(a) for a in tup], axis=2)


def column_stack(tup):
    arrs = []
    for a in tup:
        a = asarray(a)
        arrs.append(a.reshape(-1, 1) if a.ndim < 2 else a)
    return concatenate(arrs, axis=1)


def array_split(ary, indices_or_sections, axis=0):
    a = asarray(ary)
    n = a.shape[axis]
    if isinstance(indices_or_sections, int):
        k = indices_or_sections
        each, extra = divmod(n, k)
        bounds = [0]
        for i in range(k):
            bounds.append(bounds[-1] + each + (1 if i < extra else 0))
    else:
        bounds = [0] + list(indices_or_sections) + [n]
    res = []
    for lo, hi in zip(bounds[:-1], bounds[1:]):
        idx = [slice(None)] * a.ndim
        idx[axis] = slice(lo, hi)
        res.append(a[tuple(idx)])
    return res


def split(ary, indices_or_sections, axis=0):
    if isinstance(indices_or_sections, int) and asarray(ary).shape[axis] % indices_or_sections:
        raise ValueError("array split does not result in an equal division")
    return array_split(ary, indices_or_sections, axis)


def hsplit(ary, n):
    return split(ary, n, axis=1 if asarray(ary).ndim > 1 else 0)


def vsplit(ary, n):
    return split(ary, n, axis=0)


def take(a, indices, axis=None):
    a = asarray(a)
    if axis is None:
        return a.ravel()[asarray(indices)]
    idx = [slice(None)] * a.ndim
    idx[axis] = asarray(indices)
    return a[tuple(idx)]


def repeat(a, repeats, axis=None):
    a = asarray(a)
    if axis is None:
        a, axis = a.ravel(), 0
    n = a.shape[axis]
    reps = [repeats] * n if isinstance(repeats, int) else list(repeats)
    idx = []
    for i, r in enumerate(reps):
        idx.extend([i] * int(r))
    return take(a, array(idx, dtype=int64), axis=axis)


def tile(A, reps):
    A = asarray(A)
    reps = (reps,) if isinstance(reps, int) else tuple(reps)
    nd = _builtins.max(len(reps), A.ndim)
    A = A.reshape((1,) * (nd - A.ndim) + A.shape)
    reps = (1,) * (nd - len(reps)) + reps
    for ax, r in enumerate(reps):
        if r != 1:
            A = concatenate([A] * r, axis=ax)
    return A


def flip(m, axis=None):
    m = asarray(m)
    axes = range(m.ndim) if axis is None else ([axis] if isinstance(axis, int) else axis)
    idx = [slice(None)] * m.ndim
    for ax in axes:
        idx[ax] = slice(None, None, -1)
    return m[tuple(idx)]


def fliplr(m):
    return flip(m, 1)


def flipud(m):
    return flip(m, 0)


def roll(a, shift, axis=None):
    a = asarray(a)
    if axis is None:
        return roll(a.ravel(), shift, 0).reshape(a.shape)
    n = a.shape[axis]
    if n == 0:
        return a.copy()
    k = shift % n
    return take(a, concatenate([arange(n - k, n), arange(0, n - k)]), axis=axis)


def rot90(m, k=1, axes=(0, 1)):
    m = asarray(m)
    k %= 4
    a0, a1 = axes
    if k == 0:
        return m.copy()
    if k == 2:
        return flip(flip(m, a0), a1)
    if k == 1:
        return swapaxes(flip(m, a1), a0, a1)
    return flip(swapaxes(m, a0, a1), a1)


def broadcast_to(array, shape, subok=False):
    return _np.broadcast_to(asarray(array), _shape(shape))


def broadcast_arrays(*args, subok=False):
    shape = broadcast_shapes(*[asarray(a).shape for a in args])
    return [broadcast_to(a, shape) for a in args]


def broadcast_shapes(*args):
    return _np.broadcast_shapes(*[_shape(s) for s in args])


def append(arr, values, axis=None):
    arr = asarray(arr)
    if axis is None:
        return concatenate([arr.ravel(), asarray(values).ravel()])
    return concatenate([arr, values], axis=axis)


def insert(arr, obj, values, axis=None):
    arr = asarray(arr)
    if axis is None:
        arr, axis = arr.ravel(), 0
    n = arr.shape[axis]
    i = obj if obj >= 0 else obj + n
    before = take(arr, arange(0, i), axis)
    after = take(arr, arange(i, n), axis)
    v = asarray(values, arr.dtype)
    if v.ndim < arr.ndim:
        s = list(arr.shape)
        s[axis] = 1 if v.ndim == 0 else v.shape[0]
        v = broadcast_to(v.reshape(s) if v.ndim else v, s)
    return concatenate([before, v, after], axis=axis)


def delete(arr, obj, axis=None):
    arr = asarray(arr)
    if axis is None:
        arr, axis = arr.ravel(), 0
    n = arr.shape[axis]
    drop = set(range(n)[obj]) if isinstance(obj, slice) else {int(i) % n for i in atleast_1d(asarray(obj)).tolist()}
    return take(arr, array([i for i in range(n) if i not in drop], dtype=int64), axis)


def resize(a, new_shape):
    a = asarray(a).ravel()
    shape = _shape(new_shape)
    n = 1
    for s in shape:
        n *= s
    if a.size == 0:
        return zeros(shape, a.dtype)
    reps = -(-n // a.size)
    return concatenate([a] * reps)[:n].reshape(shape)


def pad(array, pad_width, mode="constant", constant_values=0):
    a = asarray(array)
    pw = pad_width
    if isinstance(pw, int):
        pw = [(pw, pw)] * a.ndim
    elif isinstance(pw, (tuple, list)) and len(pw) == 2 and isinstance(pw[0], int):
        pw = [tuple(pw)] * a.ndim
    res = a
    for ax, (lo, hi) in enumerate(pw):
        if mode == "constant":
            parts = []
            s = list(res.shape)
            if lo:
                s[ax] = lo
                parts.append(full(s, constant_values, a.dtype))
            parts.append(res)
            if hi:
                s[ax] = hi
                parts.append(full(s, constant_values, a.dtype))
        elif mode == "edge":
            n = res.shape[ax]
            parts = [take(res, [0] * lo, ax), res, take(res, [n - 1] * hi, ax)]
        else:
            raise NotImplementedError("pad mode %r" % mode)
        res = concatenate(parts, axis=ax)
    return res


# ------------------------------------------------------------------ searching and sorting

def where(condition, x=None, y=None):
    if x is None and y is None:
        return nonzero(condition)
    if x is None or y is None:
        raise ValueError("either both or neither of x and y should be given")
    return _np.where3(asarray(condition, bool_), x, y)


def nonzero(a):
    return _np.nonzero(asarray(a))


def flatnonzero(a):
    return nonzero(ravel(a))[0]


def argwhere(a):
    nz = nonzero(a)
    return stack(nz, axis=1) if nz else zeros((0, 0), int64)


def sort(a, axis=-1, kind=None, order=None, *, stable=None):
    return _np.sort(asarray(a), axis)


def argsort(a, axis=-1, kind=None, order=None, *, stable=None):
    return _np.argsort(asarray(a), axis)


def lexsort(keys, axis=-1):
    keys = [asarray(k).tolist() for k in keys]
    n = len(keys[0])
    return array(sorted(range(n), key=lambda i: tuple(k[i] for k in reversed(keys))), dtype=int64)


def searchsorted(a, v, side="left", sorter=None):
    import bisect
    a = asarray(a).tolist()
    if sorter is not None:
        a = [a[i] for i in asarray(sorter).tolist()]
    f = bisect.bisect_left if side == "left" else bisect.bisect_right
    vv = asarray(v)
    res = [f(a, x) for x in vv.ravel().tolist()]
    return array(res, dtype=int64).reshape(vv.shape) if vv.ndim else int64(res[0])


def unique(ar, return_index=False, return_inverse=False, return_counts=False, axis=None, *, equal_nan=True):
    if not (return_index or return_inverse or return_counts) and asarray(ar).dtype.kind != "c":
        return _np.unique1d(ar)
    a = asarray(ar).ravel()
    order = argsort(a)
    s = a[order]
    if s.size == 0:
        flags = zeros(0, bool_)
    else:
        flags = concatenate([array([True]), s[1:] != s[:-1]])
        if s.dtype.kind in "fc" and equal_nan:
            nans = isnan(s)
            flags = flags & ~(nans & concatenate([array([False]), nans[:-1]]))
    u = s[flags]
    if not (return_index or return_inverse or return_counts):
        return u
    res = [u]
    starts = flatnonzero(flags)
    if return_index:
        res.append(order[starts])
    if return_inverse:
        inv = zeros(a.shape, int64)
        inv[order] = cumsum(flags) - 1
        res.append(inv.reshape(asarray(ar).shape))
    if return_counts:
        res.append(diff(concatenate([starts, array([s.size])])))
    return tuple(res)


def isin(element, test_elements, assume_unique=False, invert=False):
    e = asarray(element)
    t = set(asarray(test_elements).ravel().tolist())
    r = array([v in t for v in e.ravel().tolist()], dtype=bool_).reshape(e.shape)
    return ~r if invert else r


in1d = isin


def intersect1d(a, b, assume_unique=False):
    return unique(array(sorted(set(asarray(a).ravel().tolist()) & set(asarray(b).ravel().tolist())), dtype=result_type(asarray(a), asarray(b))))


def union1d(a, b):
    return unique(concatenate([asarray(a).ravel(), asarray(b).ravel()]))


def setdiff1d(a, b, assume_unique=False):
    bs = set(asarray(b).ravel().tolist())
    return unique(array([v for v in asarray(a).ravel().tolist() if v not in bs], dtype=asarray(a).dtype))


def diff(a, n=1, axis=-1, prepend=None, append=None):
    a = asarray(a)
    if prepend is not None or append is not None:
        parts = []
        for extra, first in ((prepend, True), (append, False)):
            if extra is None:
                continue
            p = asarray(extra)
            if p.ndim == 0:
                s = list(a.shape)
                s[axis] = 1
                p = broadcast_to(p, s)
            parts.append((first, p))
        a = concatenate([p for f, p in parts if f] + [a] + [p for f, p in parts if not f], axis=axis)
    for _ in range(n):
        lo = [slice(None)] * a.ndim
        hi = [slice(None)] * a.ndim
        lo[axis] = slice(None, -1)
        hi[axis] = slice(1, None)
        a = a[tuple(hi)] - a[tuple(lo)] if a.dtype.kind != "b" else not_equal(a[tuple(hi)], a[tuple(lo)])
    return a


def ediff1d(ary, to_end=None, to_begin=None):
    a = diff(asarray(ary).ravel())
    parts = ([asarray(to_begin).ravel()] if to_begin is not None else []) + [a] + ([asarray(to_end).ravel()] if to_end is not None else [])
    return concatenate(parts)


def gradient(f, *varargs, axis=None, edge_order=1):
    f = asarray(f, float64)
    axes = list(range(f.ndim)) if axis is None else ([axis] if isinstance(axis, int) else list(axis))
    spacing = list(varargs) if varargs else [1.0] * len(axes)
    if len(spacing) == 1 and len(axes) > 1:
        spacing = spacing * len(axes)
    res = []
    for ax, h in zip(axes, spacing):
        fm = moveaxis(f, ax, 0)
        if fm.shape[0] < 2:
            raise ValueError("Shape of array too small to calculate a numerical gradient, at least (edge_order + 1) elements are required.")
        hv = asarray(h, float64)
        g = zeros(fm.shape, float64)
        if hv.ndim == 0:
            hh = float(hv)
            g[1:-1] = (fm[2:] - fm[:-2]) / (2 * hh)
            g[0] = (fm[1] - fm[0]) / hh
            g[-1] = (fm[-1] - fm[-2]) / hh
        else:
            dx = diff(hv)
            dx1, dx2 = dx[:-1], dx[1:]
            a = -dx2 / (dx1 * (dx1 + dx2))
            b = (dx2 - dx1) / (dx1 * dx2)
            c = dx1 / (dx2 * (dx1 + dx2))
            sh = (-1,) + (1,) * (fm.ndim - 1)
            g[1:-1] = a.reshape(sh) * fm[:-2] + b.reshape(sh) * fm[1:-1] + c.reshape(sh) * fm[2:]
            g[0] = (fm[1] - fm[0]) / dx[0]
            g[-1] = (fm[-1] - fm[-2]) / dx[-1]
        res.append(moveaxis(g, 0, ax))
    return res[0] if len(res) == 1 else res


def trapezoid(y, x=None, dx=1.0, axis=-1):
    y = asarray(y)
    n = y.shape[axis]
    lo = [slice(None)] * y.ndim
    hi = [slice(None)] * y.ndim
    lo[axis] = slice(None, -1)
    hi[axis] = slice(1, None)
    if x is None:
        d = dx
    else:
        x = asarray(x)
        d = diff(x) if x.ndim == 1 else diff(x, axis=axis)
        if x.ndim == 1 and y.ndim > 1:
            s = [1] * y.ndim
            s[axis] = n - 1
            d = d.reshape(s)
    return sum(d * (y[tuple(hi)] + y[tuple(lo)]) / 2.0, axis=axis)


trapz = trapezoid


def cross(a, b, axisa=-1, axisb=-1, axisc=-1, axis=None):
    a, b = asarray(a), asarray(b)
    if a.shape[-1] == 2 and b.shape[-1] == 2:
        return a[..., 0] * b[..., 1] - a[..., 1] * b[..., 0]
    a0, a1, a2 = a[..., 0], a[..., 1], a[..., 2]
    b0, b1, b2 = b[..., 0], b[..., 1], b[..., 2]
    return stack([a1 * b2 - a2 * b1, a2 * b0 - a0 * b2, a0 * b1 - a1 * b0], axis=-1)


def interp(x, xp, fp, left=None, right=None, period=None):
    import bisect
    xp_l = asarray(xp, float64).tolist()
    fp_a = asarray(fp)
    cplx = fp_a.dtype.kind == "c"
    fp_l = fp_a.tolist()
    xs = asarray(x, float64)
    lo_v = fp_l[0] if left is None else left
    hi_v = fp_l[-1] if right is None else right
    res = []
    n = len(xp_l)
    for v in xs.ravel().tolist():
        if v != v:
            res.append(nan)
        elif v < xp_l[0]:
            res.append(lo_v)
        elif v > xp_l[-1]:
            res.append(hi_v)
        else:
            j = bisect.bisect_right(xp_l, v) - 1
            if j >= n - 1:
                res.append(fp_l[-1])
            else:
                slope = (fp_l[j + 1] - fp_l[j]) / (xp_l[j + 1] - xp_l[j])
                res.append(slope * (v - xp_l[j]) + fp_l[j])
    r = array(res, dtype=complex128 if cplx else float64).reshape(xs.shape)
    return r if r.ndim else r[()]


def convolve(a, v, mode="full"):
    a, v = asarray(a).ravel(), asarray(v).ravel()
    if a.size < v.size:
        a, v = v, a
    n, m = a.size, v.size
    av, vv = a.tolist(), v.tolist()
    full_ = [0] * (n + m - 1)
    for i in range(n):
        ai = av[i]
        for j in range(m):
            full_[i + j] += ai * vv[j]
    r = array(full_, dtype=result_type(a, v))
    if mode == "full":
        return r
    if mode == "same":
        start = (m - 1) // 2
        return r[start:start + n]
    if mode == "valid":
        return r[m - 1:n]
    raise ValueError("mode must be 'full', 'same' or 'valid'")


def correlate(a, v, mode="valid"):
    return convolve(a, asarray(v)[::-1].conj(), mode)


def histogram(a, bins=10, range=None, density=None, weights=None):
    import bisect
    a = asarray(a).ravel()
    if isinstance(bins, int):
        if range is None:
            lo, hi = (float(amin(a)), float(amax(a))) if a.size else (0.0, 1.0)
        else:
            lo, hi = float(range[0]), float(range[1])
        if lo == hi:
            lo, hi = lo - 0.5, hi + 0.5
        edges = linspace(lo, hi, bins + 1)
    else:
        edges = asarray(bins, float64)
    nb = edges.size - 1
    if isinstance(bins, int) and weights is None:
        hist = _np.hist_uniform(a, edges[0], edges[-1], nb, edges)
        if density:
            hist = hist / diff(edges) / sum(hist)
        return hist, edges
    e = edges.tolist()
    counts = [0] * nb
    w = asarray(weights).ravel().tolist() if weights is not None else None
    lo, hi = e[0], e[-1]
    uniform = isinstance(bins, int)
    for i, v in enumerate(a.tolist()):
        if v < lo or v > hi or v != v:
            continue
        if uniform:
            k = int((v - lo) / (hi - lo) * nb)
            if k >= nb:
                k = nb - 1
            if v < e[k]:
                k -= 1
            elif k < nb - 1 and v >= e[k + 1]:
                k += 1
        else:
            k = bisect.bisect_right(e, v) - 1
            if k == nb:
                k = nb - 1
        counts[k] += w[i] if w is not None else 1
    hist = array(counts, dtype=float64 if (weights is not None and asarray(weights).dtype.kind == "f") else int64)
    if density:
        hist = hist / diff(edges) / sum(hist)
    return hist, edges


def histogram_bin_edges(a, bins=10, range=None, weights=None):
    return histogram(a, bins, range)[1]


def bincount(x, weights=None, minlength=0):
    xs = asarray(x).tolist()
    n = _builtins.max((_builtins.max(xs) + 1) if xs else 0, minlength)
    if weights is None:
        res = [0] * n
        for v in xs:
            res[v] += 1
        return array(res, dtype=int64)
    w = asarray(weights).tolist()
    res = [0.0] * n
    for v, wt in zip(xs, w):
        res[v] += wt
    return array(res)


def digitize(x, bins, right=False):
    b = asarray(bins).tolist()
    increasing = len(b) < 2 or b[1] >= b[0]
    side = "left" if right else "right"
    if increasing:
        return searchsorted(b, x, side=side)
    return len(b) - searchsorted(b[::-1], x, side="left" if side == "right" else "right")


# ------------------------------------------------------------------ products

def dot(a, b, out=None):
    a, b = asarray(a), asarray(b)
    if a.ndim == 0 or b.ndim == 0:
        r = multiply(a, b)
        return _out(r if r.ndim else r[()], out)
    if b.ndim > 2:
        return _out(tensordot(a, b, axes=([a.ndim - 1], [b.ndim - 2])), out)
    return _out(_np.matmul(a, b), out)


def matmul(a, b, out=None):
    return _out(_np.matmul(asarray(a), asarray(b)), out)


def vdot(a, b):
    return dot(asarray(a).ravel().conj(), asarray(b).ravel())


def inner(a, b):
    a, b = asarray(a), asarray(b)
    if a.ndim == 0 or b.ndim == 0:
        return a * b
    return tensordot(a, b, axes=([a.ndim - 1], [b.ndim - 1]))


def outer(a, b, out=None):
    a, b = asarray(a).ravel(), asarray(b).ravel()
    return _out(multiply(a[:, None], b[None, :]), out)


def tensordot(a, b, axes=2):
    a, b = asarray(a), asarray(b)
    if isinstance(axes, int):
        axa = list(range(a.ndim - axes, a.ndim))
        axb = list(range(axes))
    else:
        axa, axb = axes
        axa = [axa] if isinstance(axa, int) else list(axa)
        axb = [axb] if isinstance(axb, int) else list(axb)
    axa = [x % a.ndim for x in axa]
    axb = [x % b.ndim for x in axb]
    fa = [i for i in range(a.ndim) if i not in axa]
    fb = [i for i in range(b.ndim) if i not in axb]
    k = 1
    for x in axa:
        k *= a.shape[x]
    A = transpose(a, fa + axa).reshape(-1, k)
    B = transpose(b, axb + fb).reshape(k, -1)
    r = asarray(A @ B).reshape(tuple(a.shape[i] for i in fa) + tuple(b.shape[i] for i in fb))
    return r if r.ndim else r[()]


def einsum(subscripts, *operands, optimize=False):
    ops = [asarray(o) for o in operands]
    subscripts = subscripts.replace(" ", "")
    if "->" in subscripts:
        ins, out = subscripts.split("->")
    else:
        ins = subscripts
        letters = "".join(ins.split(","))
        out = "".join(sorted(c for c in set(letters) if letters.count(c) == 1))
    ins = ins.split(",")
    dims = {}
    for spec, op in zip(ins, ops):
        if len(set(spec)) != len(spec):
            # a repeated index in one operand: take the diagonal
            raise NotImplementedError("einsum with a repeated index in one operand")
        for c, n in zip(spec, op.shape):
            dims[c] = n
    letters = sorted(dims)
    acc = None
    for spec, op in zip(ins, ops):
        o = transpose(op, [spec.index(c) for c in letters if c in spec])
        o = o.reshape([dims[c] if c in spec else 1 for c in letters])
        acc = o if acc is None else acc * o
    summed = tuple(i for i, c in enumerate(letters) if c not in out)
    r = asarray(sum(acc, axis=summed) if summed else acc)
    remaining = [c for c in letters if c in out]
    if remaining:
        r = transpose(r, [remaining.index(c) for c in out])
    return r if r.ndim else r[()]


def kron(a, b):
    a, b = asarray(a), asarray(b)
    if a.ndim == 1 and b.ndim == 1:
        return outer(a, b).ravel()
    a2, b2 = atleast_2d(a), atleast_2d(b)
    r = a2[:, None, :, None] * b2[None, :, None, :]
    return r.reshape(a2.shape[0] * b2.shape[0], a2.shape[1] * b2.shape[1])


def trace(a, offset=0, axis1=0, axis2=1, dtype=None, out=None):
    return sum(diagonal(asarray(a), offset))


# ------------------------------------------------------------------ comparisons and helpers

def isclose(a, b, rtol=1e-05, atol=1e-08, equal_nan=False):
    a, b = asarray(a), asarray(b)
    r = logical_or(less_equal(absolute(a - b), atol + rtol * absolute(b)), equal(a, b))
    if equal_nan:
        r = logical_or(r, logical_and(isnan(a), isnan(b)))
    return r if r.ndim else r[()]


def allclose(a, b, rtol=1e-05, atol=1e-08, equal_nan=False):
    return _builtins.bool(all(isclose(a, b, rtol, atol, equal_nan)))


def array_equal(a1, a2, equal_nan=False):
    a1, a2 = asarray(a1), asarray(a2)
    if a1.shape != a2.shape:
        return False
    if equal_nan:
        return _builtins.bool(all((a1 == a2) | (isnan(a1) & isnan(a2))))
    return _builtins.bool(all(a1 == a2))


def array_equiv(a1, a2):
    try:
        return _builtins.bool(all(asarray(a1) == asarray(a2)))
    except ValueError:
        return False


def apply_along_axis(func1d, axis, arr, *args, **kwargs):
    arr = asarray(arr)
    a = moveaxis(arr, axis, -1)
    outer_shape = a.shape[:-1]
    flat = a.reshape(-1, a.shape[-1])
    res = array([asarray(func1d(flat[i], *args, **kwargs)) for i in range(flat.shape[0])])
    res = res.reshape(outer_shape + res.shape[1:])
    if res.ndim > len(outer_shape):
        res = moveaxis(res, -1, axis)
    return res


def vectorize(pyfunc, otypes=None, excluded=None, signature=None):
    def f(*args):
        arrs = broadcast_arrays(*[asarray(a) for a in args])
        flat = [a.ravel().tolist() for a in arrs]
        res = [pyfunc(*vals) for vals in zip(*flat)]
        r = array(res, dtype=otypes[0] if otypes else None) if res else zeros(0)
        r = r.reshape(arrs[0].shape) if arrs else r
        return r if r.ndim else r[()]
    return f


def piecewise(x, condlist, funclist, *args, **kw):
    x = asarray(x)
    res = zeros(x.shape, x.dtype if x.dtype.kind == "f" else float64)
    condlist = [asarray(c, bool_) for c in (condlist if isinstance(condlist, list) else [condlist])]
    if len(funclist) == len(condlist) + 1:
        rest = ones(x.shape, bool_)
        for c in condlist:
            rest = rest & ~c
        condlist.append(rest)
    for c, f in zip(condlist, funclist):
        res[c] = f(x[c], *args, **kw) if callable(f) else f
    return res


def select(condlist, choicelist, default=0):
    res = asarray(default)
    for c, v in reversed(list(zip(condlist, choicelist))):
        res = where(c, v, res)
    return res


class errstate:
    def __init__(self, **kw):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def __call__(self, f):
        return f


def seterr(**kw):
    return geterr()


def geterr():
    return {"divide": "warn", "over": "warn", "under": "ignore", "invalid": "warn"}


# ------------------------------------------------------------------ printing

def set_printoptions(precision=None, threshold=None, edgeitems=None, linewidth=None, suppress=None,
                     nanstr=None, infstr=None, formatter=None, sign=None, floatmode=None, legacy=None, override_repr=None):
    _np.set_printoptions(precision, threshold, edgeitems, linewidth, suppress)


def get_printoptions():
    return {k: _np.printopt(k) for k in ("precision", "threshold", "edgeitems", "linewidth", "suppress")}


class printoptions:
    def __init__(self, **kw):
        self.kw = kw

    def __enter__(self):
        self.saved = get_printoptions()
        set_printoptions(**self.kw)

    def __exit__(self, *exc):
        set_printoptions(**self.saved)
        return False


def array2string(a, max_line_width=None, precision=None, suppress_small=None, separator=" ", **kw):
    return str(asarray(a)) if separator == " " else repr(asarray(a))[6:-1]


def array_repr(arr, max_line_width=None, precision=None, suppress_small=None):
    return repr(asarray(arr))


def array_str(a, max_line_width=None, precision=None, suppress_small=None):
    return str(asarray(a))


def format_float_positional(x, precision=None, unique=True, fractional=True, trim="k", sign=False, pad_left=None, pad_right=None, min_digits=None):
    return _np.format_float(x)


# ------------------------------------------------------------------ ndarray methods with keyword arguments

def _m_astype(self, dtype, order="K", casting="unsafe", subok=True, copy=True):
    return _np.astype(self, dtype)


def _m_sort(self, axis=-1, kind=None, order=None):
    self[...] = sort(self, axis)


def _m_round(self, decimals=0, out=None):
    return around(self, decimals)


def _m_clip(self, min=None, max=None, out=None, **kw):
    return clip(self, min, max, out)


def _m_squeeze(self, axis=None):
    return squeeze(self, axis)


def _m_nonzero(self):
    return nonzero(self)


def _m_dot(self, b, out=None):
    return dot(self, b, out)


def _m_searchsorted(self, v, side="left", sorter=None):
    return searchsorted(self, v, side, sorter)


def _m_diagonal(self, offset=0, axis1=0, axis2=1):
    return diagonal(self, offset)


def _m_trace(self, offset=0, axis1=0, axis2=1, dtype=None, out=None):
    return trace(self, offset)


def _m_repeat(self, repeats, axis=None):
    return repeat(self, repeats, axis)


def _m_take(self, indices, axis=None, out=None, mode="raise"):
    return take(self, indices, axis)


def _m_ptp(self, axis=None, out=None, keepdims=False):
    return ptp(self, axis, keepdims=keepdims)


def _m_cumsum(self, axis=None, dtype=None, out=None):
    return cumsum(self, axis, dtype, out)


def _m_cumprod(self, axis=None, dtype=None, out=None):
    return cumprod(self, axis, dtype, out)


def _m_argmax(self, axis=None, out=None, *, keepdims=False):
    return argmax(self, axis, out, keepdims=keepdims)


def _m_argmin(self, axis=None, out=None, *, keepdims=False):
    return argmin(self, axis, out, keepdims=keepdims)


def _m_max(self, axis=None, out=None, keepdims=False, initial=None, where=True):
    return amax(self, axis, out, keepdims, initial)


def _m_min(self, axis=None, out=None, keepdims=False, initial=None, where=True):
    return amin(self, axis, out, keepdims, initial)


def _m_sum(self, axis=None, dtype=None, out=None, keepdims=False, initial=None, where=True):
    return sum(self, axis, dtype, out, keepdims, initial, where)


def _m_prod(self, axis=None, dtype=None, out=None, keepdims=False, initial=None, where=True):
    return prod(self, axis, dtype, out, keepdims, initial)


def _m_mean(self, axis=None, dtype=None, out=None, keepdims=False, *, where=True):
    return mean(self, axis, dtype, out, keepdims)


def _m_var(self, axis=None, dtype=None, out=None, ddof=0, keepdims=False, *, where=True):
    return var(self, axis, dtype, out, ddof, keepdims)


def _m_std(self, axis=None, dtype=None, out=None, ddof=0, keepdims=False, *, where=True):
    return std(self, axis, dtype, out, ddof, keepdims)


def _m_all(self, axis=None, out=None, keepdims=False, *, where=True):
    return all(self, axis, out, keepdims)


def _m_any(self, axis=None, out=None, keepdims=False, *, where=True):
    return any(self, axis, out, keepdims)


def _m_argsort(self, axis=-1, kind=None, order=None):
    return argsort(self, axis)


def _m_flatten(self, order="C"):
    return _np.copy(_np.ravel(self))


def _m_ravel(self, order="C"):
    return _np.ravel(self)


def frombuffer(buffer, dtype=float, count=-1, offset=0):
    """A 1-D array over a copy of the bytes (little-endian unless the dtype
    string starts with '>')."""
    if not isinstance(buffer, bytes):
        buffer = bytes(buffer)
    return _np.frombuffer(buffer, dtype, count, offset)


def _m_tobytes(self, order="C"):
    if order == "F":
        self = self.T
    return _np._tobytes(self)


def _m_argpartition(self, kth, axis=-1, kind="introselect", order=None):
    return argsort(self, axis)


def _m_partition(self, kth, axis=-1, kind="introselect", order=None):
    self[...] = sort(self, axis)


for _name, _f in list(globals().items()):
    if _name.startswith("_m_"):
        _np.install(_name[3:], _f)


def _contains(self, value):
    return _builtins.bool(any(self == value))


def _format(self, spec):
    if self.ndim == 0:
        return format(self.item(), spec)
    if spec:
        raise TypeError("unsupported format string passed to numpy.ndarray.__format__")
    return str(self)


def _round_dunder(self, ndigits=None):
    return around(self, ndigits or 0)


_np.install("__contains__", _contains)
_np.install("__format__", _format)
_np.install("__round__", _round_dunder)


# ------------------------------------------------------------------ text files

def _gz_bytes(data):
    """data (bytes) as a gzip file (RFC 1952), from zlib's deflate stream."""
    import zlib
    import struct
    z = zlib.compress(data)
    raw = z[2:-4]  # without the zlib header and Adler-32 trailer
    return b"\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\xff" + raw + struct.pack("<II", zlib.crc32(data) & 0xFFFFFFFF, len(data) & 0xFFFFFFFF)


def _read_text(fname):
    if hasattr(fname, "read"):
        t = fname.read()
        return t.decode() if isinstance(t, bytes) else t
    if str(fname).endswith(".gz"):
        # every member of the file, as gzip.open reads it (zlib.decompress
        # stops after the first: rows were dropped, the systematic review's
        # R2-DOC-F5); each member's CRC and length are checked
        import zlib
        with open(fname, "rb") as f:
            data = f.read()
        parts, pos = [], 0
        while pos < len(data):
            if data[pos:].strip(b"\x00") == b"":
                break  # trailing zero padding, which gzip allows
            out, pos = zlib._gzip_member(data, pos)
            parts.append(out)
        return b"".join(parts).decode()
    with open(fname) as f:
        return f.read()


def savetxt(fname, X, fmt="%.18e", delimiter=" ", newline="\n", header="", footer="", comments="# ", encoding=None):
    X = asarray(X)
    X = X.reshape(-1, 1) if X.ndim == 1 else X
    lines = []
    # every line of a multiline header/footer is a comment (never data)
    if header:
        lines.append(comments + header.replace("\n", "\n" + comments))
    for row in X.tolist():
        lines.append(delimiter.join(fmt % v for v in row))
    if footer:
        lines.append(comments + footer.replace("\n", "\n" + comments))
    text = newline.join(lines) + newline
    if hasattr(fname, "write"):
        fname.write(text)
    elif str(fname).endswith(".gz"):
        # NumPy's convention: a .gz name is written gzip-compressed
        with open(fname, "wb") as f:
            f.write(_gz_bytes(text.encode()))
    else:
        with open(fname, "w") as f:
            f.write(text)


def loadtxt(fname, dtype=float, comments="#", delimiter=None, skiprows=0, usecols=None, unpack=False, ndmin=0):
    if ndmin not in (0, 1, 2):
        raise ValueError("Illegal value of ndmin keyword: %s" % (ndmin,))
    text = _read_text(fname)
    if isinstance(usecols, int):
        usecols = [usecols]
    import numpy as _self
    conv = (lambda t: complex(t)) if _self.dtype(dtype).kind == "c" else float
    rows = []
    for i, line in enumerate(text.splitlines()):
        if i < skiprows:
            continue
        line = line.split(comments, 1)[0].strip() if comments else line.strip()
        if not line:
            continue
        parts = line.split(delimiter)
        if usecols is not None:
            parts = [parts[c] for c in usecols]
        rows.append([conv(p) for p in parts])
    a = array(rows, dtype=dtype)
    # NumPy: squeeze extra dimensions, then at least ndmin of them
    if a.ndim > ndmin:
        a = squeeze(a)
    if a.ndim < ndmin:
        a = atleast_1d(a) if ndmin == 1 else atleast_2d(a).T
    return a.T if unpack else a


genfromtxt = loadtxt

from numpy import linalg, random, fft, testing  # noqa: E402


# ------------------------------------------------------------------ polynomials (numpy/lib/_polynomial_impl.py)

def sort_complex(a):
    b = array(a, copy=True)
    vals = b.ravel().tolist()
    vals.sort(key=lambda z: (z.real, z.imag) if isinstance(z, complex) else (z, 0))
    return array(vals, dtype=complex128)


def vander(x, N=None, increasing=False):
    # as NumPy: repeated multiplication (multiply.accumulate), not power
    x = asarray(x)
    if N is None:
        N = len(x)
    v = empty((len(x), N), dtype=promote_types(x.dtype, int64))
    tmp = v[:, ::-1] if not increasing else v
    if N > 0:
        tmp[:, 0] = 1
    if N > 1:
        tmp[:, 1] = x
        for j in range(2, N):
            multiply(tmp[:, j - 1], x, out=tmp[:, j])
    return v


def polyval(p, x):
    p = asarray(p)
    x = asarray(x)
    y = zeros_like(x) if x.dtype.kind in "fc" else zeros(x.shape, result_type(p, float64) if p.dtype.kind == "f" else p.dtype)
    if isinstance(p, poly1d):
        p = p.coeffs
    for pv in p:
        y = y * x + pv
    return y if y.ndim else y[()]


def polyfit(x, y, deg, rcond=None, full=False, w=None, cov=False):
    x = asarray(x, float64)
    y = asarray(y, float64)
    order = int(deg) + 1
    if rcond is None:
        rcond = len(x) * finfo(float64).eps
    lhs = vander(x, order)
    rhs = y
    if w is not None:
        w = asarray(w, float64)
        lhs = lhs * w[:, None]
        rhs = rhs * w if rhs.ndim == 1 else rhs * w[:, None]
    scale = sqrt((lhs * lhs).sum(axis=0))
    lhs = lhs / scale
    c, resids, rank, s = linalg.lstsq(lhs, rhs, rcond)
    c = (c.T / scale).T
    if full:
        return c, resids, rank, s, rcond
    return c


def roots(p):
    p = atleast_1d(asarray(p))
    nz = flatnonzero(p)
    if len(nz) == 0:
        return array([])
    trailing = len(p) - nz[-1] - 1
    p = p[int(nz[0]):int(nz[-1]) + 1]
    N = len(p)
    if N > 1:
        A = diag(ones(N - 2, float64), -1)
        A[0, :] = -p[1:] / p[0]
        r = linalg.eigvals(A)
    else:
        r = array([])
    return concatenate([r, zeros(trailing, r.dtype)]) if trailing else r


def poly(seq_of_zeros):
    a = array([1.0])
    for z in atleast_1d(asarray(seq_of_zeros)).tolist():
        a = convolve(a, array([1.0, -z]))
    if a.dtype.kind == "c" and allclose(a.imag, 0):
        a = a.real.copy()
    return a


def polyadd(a1, a2):
    a1, a2 = atleast_1d(asarray(a1)), atleast_1d(asarray(a2))
    diff = len(a2) - len(a1)
    if diff > 0:
        a1 = concatenate([zeros(diff, a1.dtype), a1])
    elif diff < 0:
        a2 = concatenate([zeros(-diff, a2.dtype), a2])
    return a1 + a2


def polysub(a1, a2):
    return polyadd(a1, -asarray(a2))


def polymul(a1, a2):
    return convolve(a1, a2)


def polydiv(u, v):
    u, v = atleast_1d(asarray(u, float64)), atleast_1d(asarray(v, float64))
    m, n = len(u) - 1, len(v) - 1
    scale = 1.0 / v[0]
    q = zeros(_builtins.max(m - n + 1, 1), float64)
    r = u.copy()
    for k in range(m - n + 1):
        d = scale * r[k]
        q[k] = d
        r[k:k + n + 1] -= d * v
    while allclose(r[0], 0, rtol=1e-14) and r.shape[-1] > 1:
        r = r[1:]
    return q, r


def polyder(p, m=1):
    p = asarray(p)
    for _ in range(m):
        n = len(p) - 1
        p = p[:-1] * arange(n, 0, -1)
    return p


def polyint(p, m=1, k=None):
    p = asarray(p, float64)
    k = [0] * m if k is None else (list(k) if isinstance(k, (list, tuple)) else [k] * m)
    for i in range(m):
        n = len(p)
        p = concatenate([p / arange(n, 0, -1), array([k[i]], float64)])
    return p


class poly1d:
    """A one-dimensional polynomial, highest power first."""

    def __init__(self, c_or_r, r=False, variable=None):
        if isinstance(c_or_r, poly1d):
            c_or_r = c_or_r.coeffs
        c = poly(c_or_r) if r else atleast_1d(asarray(c_or_r))
        nz = flatnonzero(c)
        self.coeffs = c[int(nz[0]):] if len(nz) else c[-1:] * 0
        self.variable = variable or "x"

    @property
    def order(self):
        return len(self.coeffs) - 1

    o = order

    @property
    def roots(self):
        return roots(self.coeffs)

    r = roots

    @property
    def c(self):
        return self.coeffs

    coef = coefficients = c

    def __call__(self, val):
        return polyval(self.coeffs, val)

    def __len__(self):
        return self.order

    def __getitem__(self, power):
        if power > self.order or power < 0:
            return self.coeffs.dtype.type(0) if False else 0
        return self.coeffs[self.order - power]

    def __array__(self, *a):
        return self.coeffs

    def __repr__(self):
        vals = repr(self.coeffs)
        vals = vals[6:-1]
        return "poly1d(%s)" % vals

    def __str__(self):
        thestr = "0"
        var = self.variable
        coeffs = self.coeffs[flatnonzero(self.coeffs)[0]:] if len(flatnonzero(self.coeffs)) else self.coeffs
        N = len(coeffs) - 1

        def fmt_float(q):
            s = "%.4g" % q
            if s.endswith(".0000"):
                s = s[:-5]
            return s

        for k, coeff in enumerate(coeffs.tolist()):
            if isinstance(coeff, complex):
                coefstr = "(" + fmt_float(coeff.real) + (" + " if coeff.imag >= 0 else " - ") + fmt_float(abs(coeff.imag)) + "j)"
            else:
                coefstr = fmt_float(abs(coeff))
            power = N - k
            if power == 0:
                newstr = "" if coefstr == "0" else coefstr
            elif power == 1:
                newstr = "" if coefstr == "0" else (var if coefstr == "b" else ("%s %s" % (coefstr, var) if coefstr != "1" else var))
            else:
                newstr = "" if coefstr == "0" else ("%s %s**%d" % (coefstr, var, power) if coefstr != "1" else "%s**%d" % (var, power))
            if k > 0:
                if newstr != "":
                    if newstr.startswith("-"):
                        thestr = "%s - %s" % (thestr, newstr[1:])
                    elif not isinstance(coeff, complex) and coeff < 0:
                        thestr = "%s - %s" % (thestr, newstr)
                    else:
                        thestr = "%s + %s" % (thestr, newstr)
            else:
                thestr = ("-" + newstr) if (not isinstance(coeff, complex) and coeff < 0) else newstr
        # NumPy puts the exponents on a line above; ours keeps them inline with **
        return thestr

    def _other(self, o):
        return o.coeffs if isinstance(o, poly1d) else asarray(o)

    def __add__(self, o):
        return poly1d(polyadd(self.coeffs, self._other(o)))

    __radd__ = __add__

    def __sub__(self, o):
        return poly1d(polysub(self.coeffs, self._other(o)))

    def __rsub__(self, o):
        return poly1d(polysub(self._other(o), self.coeffs))

    def __mul__(self, o):
        if not isinstance(o, poly1d) and asarray(o).ndim == 0:
            return poly1d(self.coeffs * o)
        return poly1d(polymul(self.coeffs, self._other(o)))

    __rmul__ = __mul__

    def __neg__(self):
        return poly1d(-self.coeffs)

    def __pow__(self, n):
        r = poly1d([1])
        for _ in range(n):
            r = r * self
        return r

    def __eq__(self, o):
        return isinstance(o, poly1d) and array_equal(self.coeffs, o.coeffs)

    def __truediv__(self, o):
        if not isinstance(o, poly1d) and asarray(o).ndim == 0:
            return poly1d(self.coeffs / o)
        q, r = polydiv(self.coeffs, self._other(o))
        return poly1d(q), poly1d(r)

    def deriv(self, m=1):
        return poly1d(polyder(self.coeffs, m))

    def integ(self, m=1, k=0):
        return poly1d(polyint(self.coeffs, m, k))


from numpy import polynomial  # noqa: E402
