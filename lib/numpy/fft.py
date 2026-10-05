"""numpy.fft: radix-2 and Bluestein transforms (src/runtime/numpy_fft.ts)
with numpy's API.  Results agree with NumPy's pocketfft to rounding error."""

import numpy as _np
import _npfft

__all__ = ["fft", "ifft", "rfft", "irfft", "fft2", "ifft2", "fftn", "ifftn", "rfft2", "irfft2", "rfftn", "irfftn",
           "hfft", "ihfft", "fftfreq", "rfftfreq", "fftshift", "ifftshift"]


def _scale(norm, n, inverse):
    if norm in (None, "backward"):
        return 1.0 / n if inverse else 1.0
    if norm == "ortho":
        return 1.0 / _np.sqrt(n)
    if norm == "forward":
        return 1.0 if inverse else 1.0 / n
    raise ValueError("Invalid norm value %r" % (norm,))


def _resize(a, n, axis):
    m = a.shape[axis]
    if n is None or n == m:
        return a
    if n < m:
        idx = [slice(None)] * a.ndim
        idx[axis] = slice(0, n)
        return a[tuple(idx)]
    pad = list(a.shape)
    pad[axis] = n - m
    return _np.concatenate([a, _np.zeros(pad, a.dtype)], axis=axis)


def _raw(a, n, axis, inverse, norm):
    a0 = _np.asarray(a)
    a = _resize(_np.asarray(a0, _np.complex128), n, axis)
    if a.shape[axis] < 1:
        raise ValueError("Invalid number of FFT data points (%d) specified." % a.shape[axis])
    x = _np.moveaxis(a, axis, -1)
    if x is a0 or a is a0 or axis % a.ndim != a.ndim - 1:
        x = x.copy()  # never transform the caller's array in place
    N = x.shape[-1]
    _npfft.rows(x, x.size // N if N else 0, N, inverse)
    s = _scale(norm, N, inverse)
    if s != 1.0:
        x = x * s
    return _np.moveaxis(x, -1, axis)


def fft(a, n=None, axis=-1, norm=None, out=None):
    return _raw(a, n, axis, False, norm)


def ifft(a, n=None, axis=-1, norm=None, out=None):
    return _raw(a, n, axis, True, norm)


def rfft(a, n=None, axis=-1, norm=None, out=None):
    a = _np.asarray(a)
    if a.dtype.kind == "c":
        a = a.real
    a = _resize(_np.asarray(a, _np.float64), n, axis)
    N = a.shape[axis]
    if N >= 2 and N % 2 == 0:
        x = _np.moveaxis(a, axis, -1)
        if axis % a.ndim != a.ndim - 1:
            x = x.copy()  # rfft_rows reads contiguous rows (and never writes them)
        res = _np.zeros(x.shape[:-1] + (N // 2 + 1,), _np.complex128)
        _npfft.rfft_rows(x, x.size // N, N, res)
        s = _scale(norm, N, False)
        if s != 1.0:
            res = res * s
        return _np.moveaxis(res, -1, axis)
    r = _raw(a, n, axis, False, norm)
    m = r.shape[axis] // 2 + 1
    idx = [slice(None)] * r.ndim
    idx[axis] = slice(0, m)
    return r[tuple(idx)]


def irfft(a, n=None, axis=-1, norm=None, out=None):
    a = _np.asarray(a, _np.complex128)
    m = a.shape[axis]
    if n is None:
        n = 2 * (m - 1)
    a = _resize(a, n // 2 + 1, axis)
    # rebuild the Hermitian-symmetric spectrum
    k = n // 2 + 1
    tail_len = n - k
    idx = [slice(None)] * a.ndim
    idx[axis] = slice(1, 1 + tail_len)
    tail = _np.flip(a[tuple(idx)], axis).conj()
    full = _np.concatenate([a, tail], axis=axis)
    zero = [slice(None)] * a.ndim
    zero[axis] = 0
    full[tuple(zero)] = full[tuple(zero)].real
    if n % 2 == 0:
        nyq = [slice(None)] * a.ndim
        nyq[axis] = n // 2
        full[tuple(nyq)] = full[tuple(nyq)].real
    return _raw(full, n, axis, True, norm).real


def hfft(a, n=None, axis=-1, norm=None):
    a = _np.asarray(a)
    if n is None:
        n = 2 * (a.shape[axis] - 1)
    s = _scale(norm, n, False)
    return irfft(a.conj(), n, axis, "forward") * (s if norm != "forward" else 1.0) if False else irfft(a.conj(), n, axis) * n * _scale(norm, n, False)


def ihfft(a, n=None, axis=-1, norm=None):
    a = _np.asarray(a)
    if n is None:
        n = a.shape[axis]
    return rfft(a, n, axis).conj() * _scale(norm, n, True)


def _axes(a, s, axes):
    if axes is None:
        axes = list(range(-len(s), 0)) if s is not None else list(range(a.ndim))
    if s is None:
        s = [a.shape[ax] for ax in axes]
    return list(s), list(axes)


def fftn(a, s=None, axes=None, norm=None, out=None):
    a = _np.asarray(a)
    s, axes = _axes(a, s, axes)
    for n, ax in zip(s, axes):
        a = fft(a, n, ax, norm)
    return a


def ifftn(a, s=None, axes=None, norm=None, out=None):
    a = _np.asarray(a)
    s, axes = _axes(a, s, axes)
    for n, ax in zip(s, axes):
        a = ifft(a, n, ax, norm)
    return a


def fft2(a, s=None, axes=(-2, -1), norm=None, out=None):
    return fftn(a, s, axes, norm)


def ifft2(a, s=None, axes=(-2, -1), norm=None, out=None):
    return ifftn(a, s, axes, norm)


def rfftn(a, s=None, axes=None, norm=None, out=None):
    a = _np.asarray(a)
    s, axes = _axes(a, s, axes)
    a = rfft(a, s[-1], axes[-1], norm)
    for n, ax in zip(s[:-1], axes[:-1]):
        a = fft(a, n, ax, norm)
    return a


def irfftn(a, s=None, axes=None, norm=None, out=None):
    a = _np.asarray(a)
    if axes is None:
        axes = list(range(-len(s), 0)) if s is not None else list(range(a.ndim))
    if s is None:
        s = [a.shape[ax] for ax in axes[:-1]] + [2 * (a.shape[axes[-1]] - 1)]
    for n, ax in zip(s[:-1], axes[:-1]):
        a = ifft(a, n, ax, norm)
    return irfft(a, s[-1], axes[-1], norm)


def rfft2(a, s=None, axes=(-2, -1), norm=None, out=None):
    return rfftn(a, s, axes, norm)


def irfft2(a, s=None, axes=(-2, -1), norm=None, out=None):
    return irfftn(a, s, axes, norm)


def fftfreq(n, d=1.0, device=None):
    val = 1.0 / (n * d)
    results = _np.empty(n, int)
    N = (n - 1) // 2 + 1
    results[:N] = _np.arange(0, N, dtype=int)
    results[N:] = _np.arange(-(n // 2), 0, dtype=int)
    return results * val


def rfftfreq(n, d=1.0, device=None):
    val = 1.0 / (n * d)
    return _np.arange(0, n // 2 + 1, dtype=int) * val


def fftshift(x, axes=None):
    x = _np.asarray(x)
    if axes is None:
        axes = tuple(range(x.ndim))
        shift = [dim // 2 for dim in x.shape]
    elif isinstance(axes, int):
        shift = x.shape[axes] // 2
        return _np.roll(x, shift, axes)
    else:
        shift = [x.shape[ax] // 2 for ax in axes]
    for ax, sh in zip(axes, shift):
        x = _np.roll(x, sh, ax)
    return x


def ifftshift(x, axes=None):
    x = _np.asarray(x)
    if axes is None:
        axes = tuple(range(x.ndim))
        shift = [-(dim // 2) for dim in x.shape]
    elif isinstance(axes, int):
        return _np.roll(x, -(x.shape[axes] // 2), axes)
    else:
        shift = [-(x.shape[ax] // 2) for ax in axes]
    for ax, sh in zip(axes, shift):
        x = _np.roll(x, sh, ax)
    return x
