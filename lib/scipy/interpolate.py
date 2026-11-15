"""scipy.interpolate for Sagebrush: interp1d (linear, nearest, nearest-up,
previous and next), the piecewise polynomials PPoly, CubicHermiteSpline,
CubicSpline and PchipInterpolator, and pchip_interpolate.

The algorithms are SciPy 1.18's scipy/interpolate (BSD 3-Clause, see
NOTICE.md), followed line for line so that the results are SciPy's to the
last bit: _interpolate.py's interp1d and PPoly, _polyint.py's
_Interpolator1D, _cubic.py's splines.  PPoly's evaluation, fix_continuity
and integrate, which SciPy has in Cython (_ppoly.pyx), are the same loops in
numpy, and CubicSpline's tridiagonal solve is LAPACK's dgtsv (as SciPy's
solve_banded calls it), in its order of operations.  What is not ported (the
spline kinds of interp1d, make_interp_spline, BSpline, the FITPACK
routines, n-dimensional interpolation, PPoly.roots and solve) raises
NotImplementedError, never a plausible answer.  (Under CPython, use SciPy
itself.)
"""
import numpy as np

__all__ = ["interp1d", "PPoly", "CubicHermiteSpline", "CubicSpline", "PchipInterpolator",
           "pchip_interpolate"]

# scipy.interpolate's other public names: each raises NotImplementedError
_NOT_YET = ("Akima1DInterpolator", "BPoly", "BSpline", "BarycentricInterpolator", "CloughTocher2DInterpolator",
            "FloaterHormannInterpolator", "InterpolatedUnivariateSpline", "KroghInterpolator",
            "LSQBivariateSpline", "LSQSphereBivariateSpline", "LSQUnivariateSpline", "LinearNDInterpolator",
            "NdBSpline", "NdPPoly", "NearestNDInterpolator", "RBFInterpolator", "Rbf", "RectBivariateSpline",
            "RectSphereBivariateSpline", "RegularGridInterpolator", "SmoothBivariateSpline",
            "SmoothSphereBivariateSpline", "UnivariateSpline", "AAA", "approximate_taylor_polynomial",
            "barycentric_interpolate", "bisplev", "bisplrep", "generate_knots", "griddata", "insert", "interp2d",
            "interpn", "krogh_interpolate", "lagrange", "make_interp_spline", "make_lsq_spline",
            "make_smoothing_spline", "make_splprep", "make_splrep", "pade", "spalde", "splantider", "splder",
            "splev", "splint", "splprep", "splrep", "sproot")


def _unsupported(what):
    return NotImplementedError("scipy.interpolate.%s is not in Sagebrush yet (what is: %s)"
                               % (what, ", ".join(__all__)))


def __getattr__(name):
    if name in _NOT_YET:
        raise _unsupported(name)
    raise AttributeError("module 'scipy.interpolate' has no attribute %r" % name)


def __dir__():
    return sorted(list(globals()) + list(_NOT_YET))


def _prod(shape):
    p = 1
    for s in shape:
        p *= s
    return p


# ------------------------------------------------------------ _polyint.py

class _Interpolator1D:
    """Common features in univariate interpolation (SciPy's _Interpolator1D)."""

    def __init__(self, xi=None, yi=None, axis=None):
        self._y_axis = axis
        self._y_extra_shape = None
        self.dtype = None
        if yi is not None:
            self._set_yi(yi, xi=xi, axis=axis)

    def __call__(self, x):
        x, x_shape = self._prepare_x(x)
        y = self._evaluate(x)
        return self._finish_y(y, x_shape)

    def _evaluate(self, x):
        raise NotImplementedError()

    def _prepare_x(self, x):
        x = np.asarray(x)
        if not np.issubdtype(x.dtype, np.inexact):
            x = x.astype(np.float64)
        x_shape = x.shape
        return x.ravel(), x_shape

    def _finish_y(self, y, x_shape):
        y = y.reshape(x_shape + self._y_extra_shape)
        if self._y_axis != 0 and x_shape != ():
            nx = len(x_shape)
            ny = len(self._y_extra_shape)
            s = (list(range(nx, nx + self._y_axis))
                 + list(range(nx)) + list(range(nx + self._y_axis, nx + ny)))
            y = y.transpose(s)
        return y

    def _reshape_yi(self, yi, check=False):
        yi = np.moveaxis(np.asarray(yi), self._y_axis, 0)
        if check and yi.shape[1:] != self._y_extra_shape:
            ok_shape = (f"{self._y_extra_shape[-self._y_axis:]!r} + (N,) + "
                        f"{self._y_extra_shape[:-self._y_axis]!r}")
            raise ValueError(f"Data must be of shape {ok_shape}")
        return yi.reshape((yi.shape[0], -1))

    def _set_yi(self, yi, xi=None, axis=None):
        if axis is None:
            axis = self._y_axis
        if axis is None:
            raise ValueError("no interpolation axis specified")
        yi = np.asarray(yi)
        shape = yi.shape
        if shape == ():
            shape = (1,)
        if xi is not None and shape[axis] != len(xi):
            raise ValueError("x and y arrays must be equal in length along "
                             "interpolation axis.")
        self._y_axis = (axis % yi.ndim)
        self._y_extra_shape = yi.shape[:self._y_axis] + yi.shape[self._y_axis + 1:]
        self.dtype = None
        self._set_dtype(yi.dtype)

    def _set_dtype(self, dtype, union=False):
        if np.issubdtype(dtype, np.complexfloating) \
                or (self.dtype is not None and np.issubdtype(self.dtype, np.complexfloating)):
            self.dtype = np.complex128
        else:
            if not union or self.dtype != np.complex128:
                self.dtype = np.float64


# ------------------------------------------------------------ interp1d

def _check_broadcast_up_to(arr_from, shape_to, name):
    shape_from = arr_from.shape
    if len(shape_to) >= len(shape_from):
        for t, f in zip(shape_to[::-1], shape_from[::-1]):
            if f != 1 and f != t:
                break
        else:
            if arr_from.size != 1 and arr_from.shape != shape_to:
                arr_from = np.ones(shape_to, arr_from.dtype) * arr_from
            return arr_from.ravel()
    raise ValueError(f'{name} argument must be able to broadcast up '
                     f'to shape {shape_to} but had shape {shape_from}')


def _do_extrapolate(fill_value):
    return isinstance(fill_value, str) and fill_value == 'extrapolate'


class interp1d(_Interpolator1D):
    """Interpolate a 1-D function (legacy): kind 'linear', 'nearest',
    'nearest-up', 'previous' or 'next'."""

    def __init__(self, x, y, kind='linear', axis=-1,
                 copy=True, bounds_error=None, fill_value=np.nan,
                 assume_sorted=False):
        _Interpolator1D.__init__(self, x, y, axis=axis)
        self.bounds_error = bounds_error
        self.copy = copy
        if kind in ['zero', 'slinear', 'quadratic', 'cubic'] or isinstance(kind, int):
            raise NotImplementedError("scipy.interpolate.interp1d(kind=%r): its spline kinds (make_interp_spline) "
                                      "are not in Sagebrush yet; 'linear', 'nearest', 'nearest-up', 'previous' "
                                      "and 'next' are, and CubicSpline is" % (kind,))
        elif kind not in ('linear', 'nearest', 'nearest-up', 'previous', 'next'):
            raise NotImplementedError(f"{kind} is unsupported: Use fitpack "
                                      "routines for other types.")
        x = np.array(x, copy=True)
        y = np.array(y, copy=True)
        if not assume_sorted:
            ind = np.argsort(x, kind="mergesort")
            x = x[ind]
            y = np.take(y, ind, axis=axis)
        if x.ndim != 1:
            raise ValueError("the x array must have exactly one dimension.")
        if y.ndim == 0:
            raise ValueError("the y array must have at least one dimension.")
        if not np.issubdtype(y.dtype, np.inexact):
            y = y.astype(np.float64)
        self.axis = axis % y.ndim
        self.y = y
        self._y = self._reshape_yi(self.y)
        self.x = x
        del y, x
        self._kind = kind
        minval = 1
        if kind == 'nearest':
            self._side = 'left'
            self.x_bds = self.x / 2.0
            self.x_bds = self.x_bds[1:] + self.x_bds[:-1]
            self._call = self.__class__._call_nearest
        elif kind == 'nearest-up':
            self._side = 'right'
            self.x_bds = self.x / 2.0
            self.x_bds = self.x_bds[1:] + self.x_bds[:-1]
            self._call = self.__class__._call_nearest
        elif kind == 'previous':
            self._side = 'left'
            self._ind = 0
            self._x_shift = np.nextafter(self.x, -np.inf)
            self._call = self.__class__._call_previousnext
            if _do_extrapolate(fill_value):
                self._check_and_update_bounds_error_for_extrapolation()
                fill_value = (np.nan, np.take(self.y, -1, axis))
        elif kind == 'next':
            self._side = 'right'
            self._ind = 1
            self._x_shift = np.nextafter(self.x, np.inf)
            self._call = self.__class__._call_previousnext
            if _do_extrapolate(fill_value):
                self._check_and_update_bounds_error_for_extrapolation()
                fill_value = (np.take(self.y, 0, axis), np.nan)
        else:
            np_dtypes = (np.dtype(np.float64), np.dtype(int))
            cond = self.x.dtype in np_dtypes and self.y.dtype in np_dtypes
            cond = cond and self.y.ndim == 1
            cond = cond and not _do_extrapolate(fill_value)
            if cond:
                self._call = self.__class__._call_linear_np
            else:
                self._call = self.__class__._call_linear
        if len(self.x) < minval:
            raise ValueError(f"x and y arrays must have at least {minval} entries")
        self.fill_value = fill_value

    @property
    def fill_value(self):
        """The fill value."""
        return self._fill_value_orig

    @fill_value.setter
    def fill_value(self, fill_value):
        if _do_extrapolate(fill_value):
            self._check_and_update_bounds_error_for_extrapolation()
            self._extrapolate = True
        else:
            broadcast_shape = (self.y.shape[:self.axis] +
                               self.y.shape[self.axis + 1:])
            if len(broadcast_shape) == 0:
                broadcast_shape = (1,)
            if isinstance(fill_value, tuple) and len(fill_value) == 2:
                below_above = [np.asarray(fill_value[0]),
                               np.asarray(fill_value[1])]
                names = ('fill_value (below)', 'fill_value (above)')
                for ii in range(2):
                    below_above[ii] = _check_broadcast_up_to(
                        below_above[ii], broadcast_shape, names[ii])
            else:
                fill_value = np.asarray(fill_value)
                below_above = [_check_broadcast_up_to(
                    fill_value, broadcast_shape, 'fill_value')] * 2
            self._fill_value_below, self._fill_value_above = below_above
            self._extrapolate = False
            if self.bounds_error is None:
                self.bounds_error = True
        self._fill_value_orig = fill_value

    def _check_and_update_bounds_error_for_extrapolation(self):
        if self.bounds_error:
            raise ValueError("Cannot extrapolate and raise "
                             "at the same time.")
        self.bounds_error = False

    def _call_linear_np(self, x_new):
        return np.interp(x_new, self.x, self.y)

    def _call_linear(self, x_new):
        x_new_indices = np.searchsorted(self.x, x_new)
        x_new_indices = x_new_indices.clip(1, len(self.x) - 1).astype(int)
        lo = x_new_indices - 1
        hi = x_new_indices
        x_lo = self.x[lo]
        x_hi = self.x[hi]
        y_lo = self._y[lo]
        y_hi = self._y[hi]
        y_new = (
            ((x_new - x_lo) / (x_hi - x_lo))[:, None] * y_hi
            + ((x_hi - x_new) / (x_hi - x_lo))[:, None] * y_lo
        )
        return y_new

    def _call_nearest(self, x_new):
        x_new_indices = np.searchsorted(self.x_bds, x_new, side=self._side)
        x_new_indices = x_new_indices.clip(0, len(self.x) - 1).astype(np.intp)
        return self._y[x_new_indices]

    def _call_previousnext(self, x_new):
        x_new_indices = np.searchsorted(self._x_shift, x_new, side=self._side)
        x_new_indices = x_new_indices.clip(1 - self._ind,
                                           len(self.x) - self._ind).astype(np.intp)
        return self._y[x_new_indices + self._ind - 1]

    def _evaluate(self, x_new):
        x_new = np.asarray(x_new)
        y_new = self._call(self, x_new)
        if not self._extrapolate:
            below_bounds, above_bounds = self._check_bounds(x_new)
            if len(y_new) > 0:
                y_new[below_bounds] = self._fill_value_below
                y_new[above_bounds] = self._fill_value_above
        return y_new

    def _check_bounds(self, x_new):
        below_bounds = x_new < self.x[0]
        above_bounds = x_new > self.x[-1]
        if self.bounds_error and below_bounds.any():
            below_bounds_value = x_new[np.argmax(below_bounds)]
            raise ValueError(f"A value ({below_bounds_value}) in x_new is below "
                             f"the interpolation range's minimum value ({self.x[0]}).")
        if self.bounds_error and above_bounds.any():
            above_bounds_value = x_new[np.argmax(above_bounds)]
            raise ValueError(f"A value ({above_bounds_value}) in x_new is above "
                             f"the interpolation range's maximum value ({self.x[-1]}).")
        return below_bounds, above_bounds


# ------------------------------------------------------------ _ppoly.pyx, in numpy

def _find_intervals(x, xv, extrapolate):
    """_ppoly's find_interval for ascending breakpoints x, at every point of
    xv: the interval i with x[i] <= v < x[i+1] (v == x[-1] in the last one;
    out of range, the first or last if extrapolating), and which points
    have none (NaN, or out of range without extrapolation)."""
    n = len(x)
    a, b = x[0], x[n - 1]
    idx = np.searchsorted(x, xv, side='right') - 1
    idx = idx.clip(0, n - 2)
    inside = (xv >= a) & (xv <= b)
    if extrapolate:
        valid = inside | (xv < a) | (xv > b)
    else:
        valid = inside
    return idx, valid


def _evaluate_poly1(s, c, ci, dx):
    """evaluate_poly1 at every point: s the offsets from each point's
    breakpoint, c (k, m, r), ci the intervals, dx the derivative (or
    antiderivative, < 0) order; the result (len(s), r)."""
    k = c.shape[0]
    res = np.zeros((len(s), c.shape[2]), dtype=c.dtype)
    z = np.ones(len(s))
    if dx < 0:
        for kp in range(-dx):
            z = z * (s / (kp + 1))
    for kp in range(k):
        if dx == 0:
            prefactor = 1.0
        elif dx > 0:
            if kp < dx:
                continue
            prefactor = 1.0
            for kk in range(kp, kp - dx, -1):
                prefactor *= kk
        else:
            prefactor = 1.0
            for kk in range(kp, kp - dx):
                prefactor /= kk + 1
        res = res + c[k - kp - 1][ci] * z[:, None] * prefactor
        if kp < k - 1 and kp >= dx:
            z = z * s
    return res


def _ppoly_evaluate(c, x, xv, dx, extrapolate):
    if len(x) > 1 and x[-1] < x[0]:
        raise NotImplementedError("scipy.interpolate: a PPoly with decreasing breakpoints is not in Sagebrush yet")
    out = np.empty((len(xv), c.shape[2]), dtype=c.dtype)
    if len(xv) == 0:
        return out
    idx, valid = _find_intervals(x, xv, extrapolate)
    s = xv - x[idx]
    out = _evaluate_poly1(s, c, idx, dx)
    if not valid.all():
        out[~valid] = np.nan
    return out


def _fix_continuity(c, x, order):
    """Make the added low-order coefficients of an antiderivative continuous
    up to `order` across each breakpoint (_ppoly's fix_continuity)."""
    k = c.shape[0]
    for ip in range(1, c.shape[1]):
        s = np.array([x[ip] - x[ip - 1]])
        for dx in range(order, -1, -1):
            res = _evaluate_poly1(s, c, np.array([ip - 1]), dx)[0]
            for kp in range(dx):
                res = res / (kp + 1)
            c[k - dx - 1, ip] = res


def _ppoly_integrate(c, x, a, b, extrapolate):
    """The integral over [a, b] (a <= b) of each column (_ppoly's integrate)."""
    xa = np.array([float(a)])
    xb = np.array([float(b)])
    ia, va_ok = _find_intervals(x, xa, extrapolate)
    ib, vb_ok = _find_intervals(x, xb, extrapolate)
    if not (va_ok[0] and vb_ok[0]):
        return np.full(c.shape[2], np.nan)
    start, end = int(ia[0]), int(ib[0])
    out = np.zeros(c.shape[2], dtype=c.dtype)
    for k in range(start, end + 1):
        hi = xb - x[k] if k == end else np.array([x[k + 1] - x[k]])
        lo = xa - x[k] if k == start else np.array([0.0])
        vb = _evaluate_poly1(hi, c, np.array([k]), -1)[0]
        va = _evaluate_poly1(lo, c, np.array([k]), -1)[0]
        out = out + vb - va
    return out


def _poch(z, m):
    """The rising factorial z (z+1) ... (z+m-1) of small integers."""
    r = np.ones(len(z))
    for j in range(m):
        r = r * (z + j)
    return r


# ------------------------------------------------------------ PPoly

class PPoly:
    """Piecewise polynomial in the power basis: c[k, i] is the coefficient of
    (x - x[i])**(n-k) on the interval between x[i] and x[i+1]."""

    def __init__(self, c, x, extrapolate=None, axis=0):
        self.c = np.asarray(c)
        self.x = np.ascontiguousarray(x, dtype=np.float64)
        if extrapolate is None:
            extrapolate = True
        elif extrapolate != 'periodic':
            extrapolate = bool(extrapolate)
        self.extrapolate = extrapolate
        if self.c.ndim < 2:
            raise ValueError("Coefficients array must be at least "
                             "2-dimensional.")
        if not (0 <= axis < self.c.ndim - 1):
            raise ValueError(f"axis={axis} must be between 0 and {self.c.ndim - 1}")
        self.axis = axis
        if axis != 0:
            self.c = np.moveaxis(self.c, axis + 1, 0)
            self.c = np.moveaxis(self.c, axis + 1, 0)
        if self.x.ndim != 1:
            raise ValueError("x must be 1-dimensional")
        if self.x.size < 2:
            raise ValueError("at least 2 breakpoints are needed")
        if self.c.ndim < 2:
            raise ValueError("c must have at least 2 dimensions")
        if self.c.shape[0] == 0:
            raise ValueError("polynomial must be at least of order 0")
        if self.c.shape[1] != self.x.size - 1:
            raise ValueError("number of coefficients != len(x)-1")
        dx = np.diff(self.x)
        if not (np.all(dx >= 0) or np.all(dx <= 0)):
            raise ValueError("`x` must be strictly increasing or decreasing.")
        dtype = self._get_dtype(self.c.dtype)
        self.c = np.ascontiguousarray(self.c, dtype=dtype)

    def _get_dtype(self, dtype):
        if np.issubdtype(dtype, np.complexfloating) \
                or np.issubdtype(self.c.dtype, np.complexfloating):
            return np.complex128
        return np.float64

    @classmethod
    def construct_fast(cls, c, x, extrapolate=None, axis=0):
        self = object.__new__(cls)
        self.c = np.asarray(c)
        self.x = np.asarray(x)
        self.axis = axis
        if extrapolate is None:
            extrapolate = True
        self.extrapolate = extrapolate
        return self

    def _c3(self, c=None):
        c = self.c if c is None else c
        return c.reshape((c.shape[0], c.shape[1], -1))

    def __call__(self, x, nu=0, extrapolate=None):
        if extrapolate is None:
            extrapolate = self.extrapolate
        x = np.asarray(x)
        x_shape, x_ndim = x.shape, x.ndim
        x = np.ascontiguousarray(x.ravel(), dtype=np.float64)
        if extrapolate == 'periodic':
            x = self.x[0] + (x - self.x[0]) % (self.x[-1] - self.x[0])
            extrapolate = False
        out = _ppoly_evaluate(self._c3(), self.x, x, nu, bool(extrapolate))
        out = out.reshape(x_shape + self.c.shape[2:])
        if self.axis != 0:
            l = list(range(out.ndim))
            l = l[x_ndim:x_ndim + self.axis] + l[:x_ndim] + l[x_ndim + self.axis:]
            out = out.transpose(l)
        return out

    def derivative(self, nu=1):
        """The piecewise polynomial of the derivative of order nu."""
        if nu < 0:
            return self.antiderivative(-nu)
        if nu == 0:
            c2 = self.c.copy()
        else:
            c2 = self.c[:-nu, :].copy()
        if c2.shape[0] == 0:
            c2 = np.zeros((1,) + c2.shape[1:], dtype=c2.dtype)
        factor = _poch(np.arange(c2.shape[0], 0, -1), nu)
        c2 = c2 * factor.reshape((c2.shape[0],) + (1,) * (c2.ndim - 1))
        return self.construct_fast(c2, self.x, self.extrapolate, self.axis)

    def antiderivative(self, nu=1):
        """The piecewise polynomial of the antiderivative of order nu,
        continuous across the breakpoints."""
        if nu <= 0:
            return self.derivative(-nu)
        c = np.zeros((self.c.shape[0] + nu, self.c.shape[1]) + self.c.shape[2:],
                     dtype=self.c.dtype)
        factor = _poch(np.arange(self.c.shape[0], 0, -1), nu)
        c[:-nu] = self.c / factor.reshape((self.c.shape[0],) + (1,) * (self.c.ndim - 1))
        c3 = self._c3(c)
        _fix_continuity(c3, self.x, nu - 1)
        c = c3.reshape(c.shape)
        if self.extrapolate == 'periodic':
            extrapolate = False
        else:
            extrapolate = self.extrapolate
        return self.construct_fast(c, self.x, extrapolate, self.axis)

    def integrate(self, a, b, extrapolate=None):
        """The definite integral from a to b."""
        if extrapolate is None:
            extrapolate = self.extrapolate
        sign = 1
        if b < a:
            a, b = b, a
            sign = -1
        c3 = self._c3()
        if extrapolate == 'periodic':
            xs, xe = self.x[0], self.x[-1]
            period = xe - xs
            interval = b - a
            n_periods, left = divmod(interval, period)
            if n_periods > 0:
                range_int = _ppoly_integrate(c3, self.x, xs, xe, False) * n_periods
            else:
                range_int = np.zeros(c3.shape[2], dtype=self.c.dtype)
            a = xs + (a - xs) % period
            b = a + left
            if b <= xe:
                range_int = range_int + _ppoly_integrate(c3, self.x, a, b, False)
            else:
                range_int = range_int + _ppoly_integrate(c3, self.x, a, xe, False)
                range_int = range_int + _ppoly_integrate(c3, self.x, xs, xs + left + a - xe, False)
        else:
            range_int = _ppoly_integrate(c3, self.x, a, b, bool(extrapolate))
        range_int = range_int * sign
        return range_int.reshape(self.c.shape[2:])

    def solve(self, y=0., discontinuity=True, extrapolate=None):
        raise _unsupported("PPoly.solve")

    def roots(self, discontinuity=True, extrapolate=None):
        raise _unsupported("PPoly.roots")


# ------------------------------------------------------------ _cubic.py

def _prepare_input(x, y, axis, dydx=None):
    x, y = np.asarray(x), np.asarray(y)
    if np.issubdtype(x.dtype, np.complexfloating):
        raise ValueError("`x` must contain real values.")
    x = x.astype(np.float64)
    if np.issubdtype(y.dtype, np.complexfloating):
        dtype = np.complex128
    else:
        dtype = np.float64
    if dydx is not None:
        dydx = np.asarray(dydx)
        if y.shape != dydx.shape:
            raise ValueError("The shapes of `y` and `dydx` must be identical.")
        if np.issubdtype(dydx.dtype, np.complexfloating):
            dtype = np.complex128
        dydx = dydx.astype(dtype)
    y = y.astype(dtype)
    axis = axis % y.ndim
    if x.ndim != 1:
        raise ValueError("`x` must be 1-dimensional.")
    if x.shape[0] < 2:
        raise ValueError("`x` must contain at least 2 elements.")
    if x.shape[0] != y.shape[axis]:
        raise ValueError(f"The length of `y` along `axis`={axis} doesn't "
                         "match the length of `x`")
    if not np.all(np.isfinite(x)):
        raise ValueError("`x` must contain only finite values.")
    if not np.all(np.isfinite(y)):
        raise ValueError("`y` must contain only finite values.")
    if dydx is not None and not np.all(np.isfinite(dydx)):
        raise ValueError("`dydx` must contain only finite values.")
    dx = np.diff(x)
    if np.any(dx <= 0):
        raise ValueError("`x` must be strictly increasing sequence.")
    y = np.moveaxis(y, axis, 0)
    if dydx is not None:
        dydx = np.moveaxis(dydx, axis, 0)
    return x, dx, y, axis, dydx


class CubicHermiteSpline(PPoly):
    """Piecewise cubic interpolator to fit values and first derivatives (C1 smooth)."""

    def __init__(self, x, y, dydx, axis=0, extrapolate=None):
        if extrapolate is None:
            extrapolate = True
        x, dx, y, axis, dydx = _prepare_input(x, y, axis, dydx)
        dxr = dx.reshape((dx.shape[0],) + (1,) * (y.ndim - 1))
        slope = np.diff(y, axis=0) / dxr
        t = (dydx[:-1, ...] + dydx[1:, ...] - 2 * slope) / dxr
        c = np.stack((
            t / dxr,
            (slope - dydx[:-1, ...]) / dxr - t,
            dydx[:-1, ...],
            y[:-1, ...]
        ))
        super().__init__(c, x, extrapolate=extrapolate)
        self.axis = axis


class PchipInterpolator(CubicHermiteSpline):
    """PCHIP 1-D monotonic cubic interpolation."""

    def __init__(self, x, y, axis=0, extrapolate=None):
        x, _, y, axis, _ = _prepare_input(x, y, axis)
        if np.issubdtype(y.dtype, np.complexfloating):
            msg = ("`PchipInterpolator` only works with real values for `y`. "
                   "If you are trying to use the real components of the passed array, "
                   "use `np.real` on the array before passing to `PchipInterpolator`.")
            raise ValueError(msg)
        xv = x.reshape((x.shape[0],) + (1,) * (y.ndim - 1))
        dk = self._find_derivatives(xv, y)
        super().__init__(x, y, dk, axis=0, extrapolate=extrapolate)
        self.axis = axis

    @staticmethod
    def _edge_case(h0, h1, m0, m1):
        d = ((2 * h0 + h1) * m0 - h0 * m1) / (h0 + h1)
        mask = np.sign(d) != np.sign(m0)
        mask2 = (np.sign(m0) != np.sign(m1)) & (np.abs(d) > 3. * np.abs(m0))
        mmm = (~mask) & mask2
        d[mask] = 0.
        d[mmm] = 3. * m0[mmm]
        return d

    @staticmethod
    def _find_derivatives(x, y):
        y_shape = y.shape
        if y.ndim == 1:
            x = x[:, None]
            y = y[:, None]
        hk = x[1:] - x[:-1]
        mk = (y[1:] - y[:-1]) / hk
        if y.shape[0] == 2:
            dk = np.zeros_like(y)
            dk[0] = mk
            dk[1] = mk
            return dk.reshape(y_shape)
        smk = np.sign(mk)
        condition = (smk[1:] != smk[:-1]) | (mk[1:] == 0) | (mk[:-1] == 0)
        w1 = 2 * hk[1:] + hk[:-1]
        w2 = hk[1:] + 2 * hk[:-1]
        with np.errstate(divide='ignore', invalid='ignore'):
            whmean = (w1 / mk[:-1] + w2 / mk[1:]) / (w1 + w2)
        inner = np.zeros_like(whmean)
        keep = ~condition
        inner[keep] = 1.0 / whmean[keep]
        dk = np.zeros_like(y)
        dk[1:-1] = inner
        dk[0] = PchipInterpolator._edge_case(hk[0], hk[1], mk[0], mk[1])
        dk[-1] = PchipInterpolator._edge_case(hk[-1], hk[-2], mk[-1], mk[-2])
        return dk.reshape(y_shape)


def pchip_interpolate(xi, yi, x, der=0, axis=0):
    """Convenience function for pchip interpolation."""
    P = PchipInterpolator(xi, yi, axis=axis)
    if der == 0:
        return P(x)
    elif np.isscalar(der) or (hasattr(der, 'shape') and der.shape == ()):
        return P.derivative(der)(x)
    else:
        return [P.derivative(nu)(x) for nu in der]


def _solve_banded_11(ab, b):
    """solve_banded((1, 1), ab, b) for b of shape (n, r): SciPy hands a
    tridiagonal system to LAPACK's dgtsv, Gaussian elimination with partial
    pivoting, here in its order of operations."""
    n = ab.shape[1]
    du = ab[0, 1:].astype(np.float64)
    d = ab[1, :].astype(np.float64)
    dl = ab[2, :-1].astype(np.float64)
    B = np.array(b, dtype=np.float64)
    nr = B.shape[1]
    for i in range(n - 1):
        last = i == n - 2
        if abs(d[i]) >= abs(dl[i]):
            if d[i] == 0:
                raise np.linalg.LinAlgError("singular matrix")
            fact = dl[i] / d[i]
            d[i + 1] = d[i + 1] - fact * du[i]
            for j in range(nr):
                B[i + 1, j] = B[i + 1, j] - fact * B[i, j]
            if not last:
                dl[i] = 0.0
        else:
            fact = d[i] / dl[i]
            d[i] = dl[i]
            temp = d[i + 1]
            d[i + 1] = du[i] - fact * temp
            if not last:
                dl[i] = du[i + 1]
                du[i + 1] = -fact * dl[i]
            du[i] = temp
            for j in range(nr):
                temp = B[i, j]
                B[i, j] = B[i + 1, j]
                B[i + 1, j] = temp - fact * B[i + 1, j]
    if d[n - 1] == 0:
        raise np.linalg.LinAlgError("singular matrix")
    for j in range(nr):
        B[n - 1, j] = B[n - 1, j] / d[n - 1]
        if n > 1:
            B[n - 2, j] = (B[n - 2, j] - du[n - 2] * B[n - 1, j]) / d[n - 2]
        for i in range(n - 3, -1, -1):
            B[i, j] = (B[i, j] - du[i] * B[i + 1, j] - dl[i] * B[i + 2, j]) / d[i]
    return B


class CubicSpline(CubicHermiteSpline):
    """Cubic spline data interpolator: bc_type 'not-a-knot' (the default),
    'periodic', 'clamped', 'natural' or a pair of (order, value)."""

    def __init__(self, x, y, axis=0, bc_type='not-a-knot', extrapolate=None):
        x, dx, y, axis, _ = _prepare_input(x, y, axis)
        n = len(x)
        bc, y = self._validate_bc(bc_type, y, y.shape[1:], axis)
        if extrapolate is None:
            if bc[0] == 'periodic':
                extrapolate = 'periodic'
            else:
                extrapolate = True
        if y.size == 0:
            s = np.zeros_like(y)
        else:
            dxr = dx.reshape([dx.shape[0]] + [1] * (y.ndim - 1))
            slope = np.diff(y, axis=0) / dxr
            if n == 2:
                if bc[0] in ['not-a-knot', 'periodic']:
                    bc[0] = (1, slope[0])
                if bc[1] in ['not-a-knot', 'periodic']:
                    bc[1] = (1, slope[0])
            if n == 3 and bc[0] == 'not-a-knot' and bc[1] == 'not-a-knot':
                A = np.zeros((3, 3))
                b = np.empty((3,) + y.shape[1:], dtype=y.dtype)
                A[0, 0] = 1
                A[0, 1] = 1
                A[1, 0] = dx[1]
                A[1, 1] = 2 * (dx[0] + dx[1])
                A[1, 2] = dx[0]
                A[2, 1] = 1
                A[2, 2] = 1
                b[0] = 2 * slope[0]
                b[1] = 3 * (dxr[0] * slope[1] + dxr[1] * slope[0])
                b[2] = 2 * slope[1]
                m = b.shape[0]
                s = np.linalg.solve(A, b.reshape((m, -1))).reshape(b.shape)
            elif n == 3 and bc[0] == 'periodic':
                t = (slope / dxr).sum(0) / (1. / dxr).sum(0)
                s = np.broadcast_to(t, (n,) + y.shape[1:])
            else:
                A = np.zeros((3, n))
                b = np.empty((n,) + y.shape[1:], dtype=y.dtype)
                A[1, 1:-1] = 2 * (dx[:-1] + dx[1:])
                A[0, 2:] = dx[:-1]
                A[-1, :-2] = dx[1:]
                b[1:-1] = 3 * (dxr[1:] * slope[:-1] + dxr[:-1] * slope[1:])
                bc_start, bc_end = bc
                if bc_start == 'periodic':
                    A = A[:, 0:-1].copy()
                    A[1, 0] = 2 * (dx[-1] + dx[0])
                    A[0, 1] = dx[-1]
                    b = b[:-1].copy()
                    a_m1_0 = dx[-2]
                    a_m1_m2 = dx[-1]
                    a_m1_m1 = 2 * (dx[-1] + dx[-2])
                    a_m2_m1 = dx[-3]
                    a_0_m1 = dx[0]
                    b[0] = 3 * (dxr[0] * slope[-1] + dxr[-1] * slope[0])
                    b[-1] = 3 * (dxr[-1] * slope[-2] + dxr[-2] * slope[-1])
                    Ac = A[:, :-1].copy()
                    b1 = b[:-1].copy()
                    b2 = np.zeros_like(b1)
                    b2[0] = -a_0_m1
                    b2[-1] = -a_m2_m1
                    m = b1.shape[0]
                    s1 = _solve_banded_11(Ac, b1.reshape((m, -1))).reshape(b1.shape)
                    m = b2.shape[0]
                    s2 = _solve_banded_11(Ac, b2.reshape((m, -1))).reshape(b2.shape)
                    s_m1 = ((b[-1] - a_m1_0 * s1[0] - a_m1_m2 * s1[-1]) /
                            (a_m1_m1 + a_m1_0 * s2[0] + a_m1_m2 * s2[-1]))
                    s = np.empty((n,) + y.shape[1:], dtype=y.dtype)
                    s[:-2] = s1 + s_m1 * s2
                    s[-2] = s_m1
                    s[-1] = s[0]
                else:
                    if bc_start == 'not-a-knot':
                        A[1, 0] = dx[1]
                        A[0, 1] = x[2] - x[0]
                        d = x[2] - x[0]
                        b[0] = ((dxr[0] + 2 * d) * dxr[1] * slope[0] +
                                dxr[0] ** 2 * slope[1]) / d
                    elif bc_start[0] == 1:
                        A[1, 0] = 1
                        A[0, 1] = 0
                        b[0] = bc_start[1]
                    elif bc_start[0] == 2:
                        A[1, 0] = 2 * dx[0]
                        A[0, 1] = dx[0]
                        b[0] = -0.5 * bc_start[1] * dx[0] ** 2 + 3 * (y[1] - y[0])
                    if bc_end == 'not-a-knot':
                        A[1, -1] = dx[-2]
                        A[-1, -2] = x[-1] - x[-3]
                        d = x[-1] - x[-3]
                        b[-1] = ((dxr[-1] ** 2 * slope[-2] +
                                  (2 * d + dxr[-1]) * dxr[-2] * slope[-1]) / d)
                    elif bc_end[0] == 1:
                        A[1, -1] = 1
                        A[-1, -2] = 0
                        b[-1] = bc_end[1]
                    elif bc_end[0] == 2:
                        A[1, -1] = 2 * dx[-1]
                        A[-1, -2] = dx[-1]
                        b[-1] = 0.5 * bc_end[1] * dx[-1] ** 2 + 3 * (y[-1] - y[-2])
                    m = b.shape[0]
                    s = _solve_banded_11(A, b.reshape((m, -1))).reshape(b.shape)
        super().__init__(x, y, s, axis=0, extrapolate=extrapolate)
        self.axis = axis

    @staticmethod
    def _validate_bc(bc_type, y, expected_deriv_shape, axis):
        if isinstance(bc_type, str):
            if bc_type == 'periodic':
                if not np.allclose(y[0], y[-1], rtol=1e-15, atol=1e-15):
                    raise ValueError(
                        f"The first and last `y` point along axis {axis} must "
                        "be identical (within machine precision) when "
                        "bc_type='periodic'.")
            bc_type = (bc_type, bc_type)
        else:
            if len(bc_type) != 2:
                raise ValueError("`bc_type` must contain 2 elements to "
                                 "specify start and end conditions.")
            if 'periodic' in bc_type:
                raise ValueError("'periodic' `bc_type` is defined for both "
                                 "curve ends and cannot be used with other "
                                 "boundary conditions.")
        validated_bc = []
        for bc in bc_type:
            if isinstance(bc, str):
                if bc == 'clamped':
                    validated_bc.append((1, np.zeros(expected_deriv_shape)))
                elif bc == 'natural':
                    validated_bc.append((2, np.zeros(expected_deriv_shape)))
                elif bc in ['not-a-knot', 'periodic']:
                    validated_bc.append(bc)
                else:
                    raise ValueError(f"bc_type={bc} is not allowed.")
            else:
                try:
                    deriv_order, deriv_value = bc
                except Exception as e:
                    raise ValueError(
                        "A specified derivative value must be "
                        "given in the form (order, value)."
                    ) from e
                if deriv_order not in [1, 2]:
                    raise ValueError("The specified derivative order must "
                                     "be 1 or 2.")
                deriv_value = np.asarray(deriv_value)
                if deriv_value.shape != expected_deriv_shape:
                    raise ValueError(
                        f"`deriv_value` shape {deriv_value.shape} is not "
                        f"the expected one {expected_deriv_shape}."
                    )
                if np.issubdtype(deriv_value.dtype, np.complexfloating):
                    y = y.astype(complex)
                validated_bc.append((deriv_order, deriv_value))
        return validated_bc, y
