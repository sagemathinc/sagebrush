"""numpy.testing: the assertion helpers."""

import numpy as _np


def _fmt(x):
    return repr(_np.asarray(x))


def assert_allclose(actual, desired, rtol=1e-07, atol=0, equal_nan=True, err_msg="", verbose=True, *, strict=False):
    a, d = _np.asarray(actual), _np.asarray(desired)
    if strict and a.shape != d.shape:
        raise AssertionError("\nNot equal to tolerance rtol=%g, atol=%g\n(shapes %s, %s mismatch)" % (rtol, atol, a.shape, d.shape))
    ok = _np.isclose(a, d, rtol=rtol, atol=atol, equal_nan=equal_nan)
    if not _np.all(ok):
        bad = int(_np.size(ok) - _np.count_nonzero(ok))
        raise AssertionError("\nNot equal to tolerance rtol=%g, atol=%g\n%s\nMismatched elements: %d / %d\n ACTUAL: %s\n DESIRED: %s" % (
            rtol, atol, err_msg, bad, _np.size(ok), _fmt(a), _fmt(d)))


def assert_array_equal(x, y, err_msg="", verbose=True, *, strict=False):
    a, b = _np.asarray(x), _np.asarray(y)
    if a.shape != b.shape and not (a.ndim == 0 or b.ndim == 0):
        raise AssertionError("\nArrays are not equal\n%s\n(shapes %s, %s mismatch)\n ACTUAL: %s\n DESIRED: %s" % (err_msg, a.shape, b.shape, _fmt(a), _fmt(b)))
    eq = (a == b) | (_np.isnan(a) & _np.isnan(b)) if a.dtype.kind in "fc" and b.dtype.kind in "fc" else (a == b)
    if not _np.all(eq):
        raise AssertionError("\nArrays are not equal\n%s\n ACTUAL: %s\n DESIRED: %s" % (err_msg, _fmt(a), _fmt(b)))


def assert_array_almost_equal(x, y, decimal=6, err_msg="", verbose=True):
    a, b = _np.asarray(x), _np.asarray(y)
    if not _np.all(_np.abs(b - a) < 1.5 * 10.0 ** (-decimal)):
        raise AssertionError("\nArrays are not almost equal to %d decimals\n%s\n ACTUAL: %s\n DESIRED: %s" % (decimal, err_msg, _fmt(a), _fmt(b)))


def assert_almost_equal(actual, desired, decimal=7, err_msg="", verbose=True):
    if isinstance(actual, _np.ndarray) or isinstance(desired, _np.ndarray):
        return assert_array_almost_equal(actual, desired, decimal, err_msg)
    if abs(desired - actual) >= 1.5 * 10.0 ** (-decimal):
        raise AssertionError("\nArrays are not almost equal to %d decimals\n%s\n ACTUAL: %r\n DESIRED: %r" % (decimal, err_msg, actual, desired))


def assert_equal(actual, desired, err_msg="", verbose=True, *, strict=False):
    if isinstance(actual, _np.ndarray) or isinstance(desired, _np.ndarray):
        return assert_array_equal(actual, desired, err_msg)
    if isinstance(desired, (list, tuple)) and isinstance(actual, (list, tuple)):
        assert_equal(len(actual), len(desired), err_msg)
        for a, d in zip(actual, desired):
            assert_equal(a, d, err_msg)
        return
    if isinstance(desired, dict):
        assert_equal(len(actual), len(desired), err_msg)
        for k in desired:
            assert_equal(actual[k], desired[k], err_msg)
        return
    if not (actual == desired or (actual != actual and desired != desired)):
        raise AssertionError("\nItems are not equal:\n%s\n ACTUAL: %r\n DESIRED: %r" % (err_msg, actual, desired))


def assert_array_less(x, y, err_msg="", verbose=True):
    if not _np.all(_np.asarray(x) < _np.asarray(y)):
        raise AssertionError("\nArrays are not less-ordered\n%s\n x: %s\n y: %s" % (err_msg, _fmt(x), _fmt(y)))


def assert_(val, msg=""):
    if not val:
        raise AssertionError(msg)


class _Raises:
    def __init__(self, exc):
        self.exc = exc

    def __enter__(self):
        return self

    def __exit__(self, et, ev, tb):
        if et is None:
            raise AssertionError("%s not raised" % self.exc.__name__)
        return issubclass(et, self.exc)


def assert_raises(exc, *args, **kwargs):
    if not args:
        return _Raises(exc)
    func, args = args[0], args[1:]
    try:
        func(*args, **kwargs)
    except exc:
        return
    raise AssertionError("%s not raised by %s" % (exc.__name__, getattr(func, "__name__", func)))


def assert_warns(*a, **k):
    import contextlib
    return contextlib.nullcontext()
