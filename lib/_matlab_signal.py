"""MATLAB's spectral analysis functions, for lib/_matlab.py: the windows hamming and hann, the frequency response
freqz, Welch's power spectral density estimate pwelch, and the short-time Fourier transform spectrogram.  Each is
written from its documentation page and the published method (Welch, "The use of fast Fourier transform for the
estimation of power spectra", IEEE Trans. Audio Electroacoust. 15, 1967; the discrete Fourier transform), with the
values of observed MATLAB R2026b runs where the page is silent (the default segmentation, spectrogram's times).
Loaded lazily: lib/_matlab.py registers each name as a stub that imports this module the first time one of them is
called, so it is in the lazy matlab-more chunk (web/lib-chunks.mts); importing it registers the real built-ins.
An option these do not implement is refused with an error, never ignored.
"""

import math as _math

import numpy as np

import _matlab as _m
from _matlab import Char, NOVAL, _bi, _bs, _err, _istext, _text
from _matlab_data import _md, _out

_TWO_PI = 2 * _math.pi


def _vec(x, name, what="the input"):
    """x as a 1-D float64 or complex128 array; a matrix is refused"""
    if _istext(x) or not _m._isnumlike(x):
        raise _err("%s: %s must be numeric." % (name, what))
    M = _md(x)
    if M.ndim != 2 or (M.shape[0] != 1 and M.shape[1] != 1 and M.size):
        raise _err("%s: %s must be a vector." % (name, what))
    return M.reshape(-1)


def _empty(v):
    return v is None or (not _istext(v) and _m._isnumlike(v) and _m._numel(v) == 0)


def _posint(v, name, what, zero=False):
    """a scalar integer (positive, or nonnegative when zero is allowed)"""
    if _istext(v) or not _m._isnumlike(v) or _m._numel(v) != 1:
        raise _err("%s: %s must be a scalar integer." % (name, what))
    f = float(np.real(_md(v).reshape(-1)[0]))
    if not (f == f and abs(f) != _math.inf and f == _math.floor(f) and (f >= 0 if zero else f >= 1)):
        raise _err("%s: %s must be a %s integer." % (name, what, "nonnegative" if zero else "positive"))
    return int(f)


def _col(a):
    """a 1-D array as a MATLAB column vector"""
    return _out(np.asarray(a).reshape((-1, 1)))


def _row(a):
    return _out(np.asarray(a).reshape((1, -1)))


# ------------------------------------------------------------------ windows

def _cospi(x):
    """cos(pi x), exact where 2x is an integer (1, 0 or -1: cos(pi / 2) is 0, not 6.1e-17), after the exact
    reduction of x modulo 2"""
    r = np.abs(_m._fmod(x, 2.0))
    c = np.cos(_math.pi * r)
    c = np.where(r == 0.5, 0.0, np.where(r == 1.5, 0.0, np.where(r == 1.0, -1.0, np.where(r == 0.0, 1.0, c))))
    return c


def _cosine_window(name, args, a0, a1):
    """the generalized cosine window a0 - a1 cos(2 pi n / N), n = 0..L-1: N = L - 1 ('symmetric', the default)
    or L ('periodic', the first L points of the symmetric window of L + 1); the cosine exact at the quarter
    points (hann(5) is exactly [0 0.5 1 0.5 0], as MATLAB's)"""
    if not args:
        raise _err("%s: the window length is required." % name)
    L = _posint(args[0], name, "the window length", zero=True)
    sflag = "symmetric"
    if len(args) > 1:
        if not _istext(args[1]) or _text(args[1]).lower() not in ("symmetric", "periodic"):
            raise _err("%s: the sampling flag must be 'symmetric' or 'periodic'." % name)
        sflag = _text(args[1]).lower()
    if len(args) > 2:
        raise _err("%s: too many input arguments." % name)
    if L <= 1:
        return np.ones(L)
    N = L - 1 if sflag == "symmetric" else L
    n = np.arange(L, dtype=np.float64)
    w = a0 - a1 * _cospi(2 * n / N)
    if sflag == "symmetric":
        # (exactly symmetric: the second half mirrors the first)
        h = (L + 1) // 2
        w[L - h:] = w[:h][::-1]
    return w


@_bs("hamming")
def hamming_(*args):
    """w = hamming(L), hamming(L, sflag): the L-point Hamming window as a column, 0.54 - 0.46 cos(2 pi n / N),
    symmetric (N = L - 1, the default) or periodic (N = L); hamming(1) is 1"""
    return _col(_hamming(args))


def _hamming(args):
    # (0.54 - 0.46, as MATLAB's first element, 0.080000000000000016, not the literal 0.08)
    return _cosine_window("hamming", args, 0.54, 0.46)


@_bs("hann")
def hann_(*args):
    """w = hann(L), hann(L, sflag): the L-point Hann window as a column, 0.5 (1 - cos(2 pi n / N)), symmetric
    (N = L - 1, the default: its ends are 0) or periodic (N = L); hann(1) is 1"""
    return _col(_cosine_window("hann", args, 0.5, 0.5))


# ------------------------------------------------------------------ freqz

def _horner(c, zi):
    """sum c_k zi^k for each element of zi (Horner's scheme from the last coefficient)"""
    h = np.zeros(zi.shape, dtype=np.complex128)
    for ck in c[::-1]:
        h = h * zi + ck
    return h


def _folded(c, N):
    """the coefficients summed modulo N: the polynomial's values at the N-th roots of unity are their DFT"""
    f = np.zeros(N, dtype=np.result_type(c.dtype, np.float64))
    for k in range(c.size):
        f[k % N] += c[k]
    return f


@_bi("freqz")
def freqz_(nargout, b, *args):
    """[h, w] = freqz(b, a, n), freqz(b, a, n, 'whole'), [h, f] = freqz(b, a, n, fs), h = freqz(b, a, w),
    h = freqz(b, a, f, fs): the frequency response H(e^jw) = B(e^jw) / A(e^jw) of the digital filter b, a
    (a = 1 by default) at n points (512 by default) spaced evenly over [0, pi), or [0, 2 pi) with 'whole', as
    columns; or at the frequencies of the vector w (rad/sample) or f (Hz with fs), h shaped as they are. With
    no output, plots the magnitude (dB) and phase (degrees)."""
    bv = _vec(b, "freqz", "b")
    rest = list(args)
    whole = False
    if any(_istext(v) for v in rest):
        for v in rest:
            if _istext(v) and _text(v).lower() != "whole":
                raise _err("freqz: '%s' is not supported in Sagebrush: the options are 'whole' and fs." % _text(v))
        whole = True
        rest = [v for v in rest if not _istext(v)]
    av = np.ones(1) if not rest or _empty(rest[0]) else _vec(rest[0], "freqz", "a")
    if av.size == 0 or av[0] == 0:
        raise _err("freqz: the first coefficient of a must not be zero.")
    p3 = rest[1] if len(rest) > 1 else None
    fs = None
    if len(rest) > 2 and not _empty(rest[2]):
        fs = float(_m._scalar(rest[2]))
        if not (fs > 0 and fs != _math.inf):
            raise _err("freqz: the sample rate fs must be a positive scalar.")
    if len(rest) > 3:
        raise _err("freqz: too many input arguments.")
    shape = None
    if p3 is not None and not _empty(p3) and _m._numel(p3) > 1:
        # (frequencies given: evaluated there directly, h shaped as they are)
        fv = _md(p3).astype(np.float64)
        shape = fv.shape
        w = fv.reshape(-1) * (_TWO_PI / fs if fs is not None else 1.0)
        zi = np.exp(-1j * w)
        h = _horner(bv, zi) / _horner(av, zi)
        x = fv.reshape(-1)
    else:
        n = 512 if p3 is None or _empty(p3) else _posint(p3, "freqz", "the number of points n")
        N = n if whole else 2 * n
        k = np.arange(n, dtype=np.float64)
        w = (_TWO_PI if whole else _math.pi) * k / n
        h = (np.fft.fft(_folded(bv, N)) / np.fft.fft(_folded(av, N)))[:n]
        x = w * fs / _TWO_PI if fs is not None else w
    if nargout == 0:
        _plot_freqz(x, h, fs)
        return NOVAL
    H = _out(h.reshape(shape)) if shape is not None else _col(h)
    X = _out(x.reshape(shape)) if shape is not None else _col(x)
    return [H, X][:max(nargout, 1)] if nargout > 1 else H


def _plot(name, *args):
    _m._B[name].call(0, list(args))


def _xlabel_freq(fs):
    return Char("Frequency (Hz)") if fs is not None else Char("Normalized Frequency (\\times\\pi rad/sample)")


def _unwrap(p):
    """phase angles with jumps of more than pi between neighbours taken out (multiples of 2 pi), as unwrap's"""
    out = p.astype(np.float64).copy()
    shift = 0.0
    for k in range(1, out.size):
        d = p[k] - p[k - 1]
        if abs(d) > _math.pi:
            shift -= _TWO_PI * _math.floor((d + _math.pi) / _TWO_PI)
        out[k] = p[k] + shift
    return out


def _plot_freqz(x, h, fs):
    xs = x if fs is not None else x / _math.pi
    with np.errstate(divide="ignore"):
        mag = 20 * np.log10(np.abs(h))
    ph = _unwrap(np.angle(h)) * 180 / _math.pi
    _plot("subplot", 2.0, 1.0, 1.0)
    _plot("plot", _col(xs), _col(mag))
    _plot("grid", Char("on"))
    _plot("xlabel", _xlabel_freq(fs))
    _plot("ylabel", Char("Magnitude (dB)"))
    _plot("subplot", 2.0, 1.0, 2.0)
    _plot("plot", _col(xs), _col(ph))
    _plot("grid", Char("on"))
    _plot("xlabel", _xlabel_freq(fs))
    _plot("ylabel", Char("Phase (degrees)"))


# ------------------------------------------------------------------ pwelch, spectrogram

_RANGES = ("onesided", "twosided", "centered")


def _segments(N, window, noverlap, name):
    """the window (an array), its length L and the overlap: the default divides x into 8 segments with 50%
    overlap, as close to 8 as the length allows (L = fix(N / 4.5), the overlap fix(L / 2)), Hamming windows;
    an integer window is a Hamming window of that length; the overlap is 50% of L by default"""
    if _empty(window):
        if N <= 8:
            raise _err("The input record needs more than eight samples in order to use the default window and overlap.",
                       "signal:welchparse:NotEnoughSamplesForDefaultSettings")
        L = int(N / 4.5)
        win = _hamming([float(L)])
    elif _m._numel(window) == 1:
        L = _posint(window, name, "the window length")
        win = _hamming([float(L)])
    else:
        win = _vec(window, name, "the window").astype(np.float64)
        L = win.size
    if L > N:
        raise _err("%s: the window is longer than the input signal (%d > %d samples)." % (name, L, N))
    if _empty(noverlap):
        nov = int(L / 2)
    else:
        nov = _posint(noverlap, name, "noverlap", zero=True)
        if nov >= L:
            raise _err("%s: noverlap must be smaller than the window length." % name)
    return win, L, nov


def _nfft_default(L):
    return max(256, 1 << max(0, (L - 1).bit_length()))


def _wrapped_fft(seg, nfft):
    """the nfft-point DFT of a segment: zero-padded when shorter, wrapped (summed modulo nfft) when longer"""
    if seg.size > nfft:
        seg = _folded(seg, nfft)
    return np.fft.fft(seg, n=nfft)


def _options(rest, name, extra=()):
    """the trailing text options: the frequency range and any of extra; the numeric arguments before them"""
    rng, flags, nums = None, [], []
    for v in rest:
        if _istext(v):
            t = _text(v).lower()
            if t in _RANGES:
                rng = t
            elif t in extra:
                flags.append(t)
            else:
                raise _err("%s: '%s' is not supported in Sagebrush." % (name, _text(v)))
        else:
            if rng is not None or flags:
                raise _err("%s: the numeric arguments come before the text options." % name)
            nums.append(v)
    return nums, rng, flags


def _freqs(nfft, fs, rng):
    """the frequencies of the bins kept: rad/sample (0 to 2 pi) or Hz with fs"""
    scale = fs if fs is not None else _TWO_PI
    if rng == "onesided":
        k = np.arange(nfft // 2 + 1, dtype=np.float64)
    elif rng == "twosided":
        k = np.arange(nfft, dtype=np.float64)
    else:
        k = np.arange(-((nfft - 1) // 2), nfft // 2 + 1, dtype=np.float64)
    return k * scale / nfft


def _keep(X, nfft, rng):
    """the bins of the nfft-point spectra (rows) for the range: one-sided 0..nfft/2, two-sided all, centered
    -(nfft-1)/2..nfft/2"""
    if rng == "onesided":
        return X[:nfft // 2 + 1]
    if rng == "twosided":
        return X
    return np.roll(X, (nfft - 1) // 2, axis=0)[:nfft]


def _onesided_power(P, nfft):
    """a one-sided spectrum's power: the bins with a mirror image doubled (not DC, nor Nyquist for even nfft)"""
    P = P.copy()
    hi = P.shape[0] - (1 if nfft % 2 == 0 else 0)
    P[1:hi] *= 2
    return P


def _fs_arg(v, name):
    if _empty(v):
        return None
    fs = float(_m._scalar(v))
    if not (fs > 0 and fs != _math.inf):
        raise _err("%s: the sample rate fs must be a positive scalar." % name)
    return fs


@_bi("pwelch")
def pwelch_(nargout, x, *args):
    """[pxx, w] = pwelch(x, window, noverlap, nfft), [pxx, f] = pwelch(..., fs), pwelch(..., range): Welch's
    power spectral density estimate: x (a vector, or each column of a matrix) in overlapping windowed segments,
    the average of their periodograms |fft(segment .* window, nfft)|^2 / (U fs), U = sum(window.^2) (fs = 2 pi
    for rad/sample). By default 8 segments with 50% overlap and Hamming windows, nfft = max(256, 2^nextpow2(L)).
    range: 'onesided' (real x's default: the bins 0..nfft/2, the mirrored ones doubled), 'twosided' (complex
    x's default) or 'centered'. With no output, plots the estimate in dB."""
    nums, rng, _f = _options(list(args), "pwelch")
    if len(nums) > 5:
        raise _err("pwelch: too many input arguments.")
    nums += [None] * (5 - len(nums))
    window, noverlap, nfft, fsv = nums[0], nums[1], nums[2], nums[3]
    if nums[4] is not None:
        raise _err("pwelch: too many input arguments.")
    if _istext(x) or not _m._isnumlike(x):
        raise _err("pwelch: the input must be numeric.")
    M = _md(x)
    if M.ndim != 2:
        raise _err("pwelch: the input must be a vector or a matrix.")
    if M.shape[0] == 1:
        M = M.reshape((-1, 1))
    N = M.shape[0]
    win, L, nov = _segments(N, window, noverlap, "pwelch")
    if not _empty(nfft) and _m._numel(nfft) > 1:
        raise _err("pwelch: a vector of frequencies is not supported in Sagebrush: give nfft.")
    n = _nfft_default(L) if _empty(nfft) else _posint(nfft, "pwelch", "nfft")
    fs = _fs_arg(fsv, "pwelch")
    cplx = np.iscomplexobj(M)
    rng = rng or ("twosided" if cplx else "onesided")
    if rng == "onesided" and cplx:
        raise _err("pwelch: a one-sided estimate needs real input.")
    hop = L - nov
    K = (N - nov) // hop
    U = float(np.dot(win, win))
    cols = []
    for c in range(M.shape[1]):
        P = np.zeros(n)
        for k in range(K):
            X = _wrapped_fft(M[k * hop:k * hop + L, c] * win, n)
            P += (X.real * X.real + X.imag * X.imag)
        P = P / K / (U * (fs if fs is not None else _TWO_PI))
        P = _keep(P, n, rng)
        cols.append(_onesided_power(P, n) if rng == "onesided" else P)
    pxx = np.stack(cols, axis=1)
    f = _freqs(n, fs, rng)
    if nargout == 0:
        _plot("plot", _col(f if fs is not None else f / _math.pi), _out(10 * np.log10(pxx)))
        _plot("grid", Char("on"))
        _plot("xlabel", _xlabel_freq(fs))
        _plot("ylabel", Char("Power/frequency (dB/Hz)" if fs is not None else "Power/frequency (dB/(rad/sample))"))
        _plot("title", Char("Welch Power Spectral Density Estimate"))
        return NOVAL
    out = [_out(pxx), _col(f)]
    return out[:nargout] if nargout > 1 else out[0]


@_bi("spectrogram")
def spectrogram_(nargout, x, *args):
    """[s, w, t] = spectrogram(x, window, noverlap, nfft), [s, f, t] = spectrogram(..., fs), [s, w, t, ps]:
    the short-time Fourier transform of the vector x: column k of s is fft(segment k .* window, nfft), the
    segments as pwelch's (8 with 50% overlap and Hamming windows by default); t the segments' centres,
    ((k - 1) hop + L / 2) / fs (fs = 2 pi without one, as MATLAB gives them); ps each segment's power spectral
    density, scaled as pwelch's. nfft may be a vector of frequencies, the DFT evaluated there. range:
    'onesided' (real x's default), 'twosided' or 'centered'. With no output, plots ps in dB ('xaxis', the
    default, puts frequency on the x-axis; 'yaxis' on the y-axis)."""
    nums, rng, flags = _options(list(args), "spectrogram", ("xaxis", "yaxis"))
    if len(nums) > 4:
        raise _err("spectrogram: too many input arguments.")
    nums += [None] * (4 - len(nums))
    window, noverlap, nfft, fsv = nums
    xv = _vec(x, "spectrogram")
    N = xv.size
    win, L, nov = _segments(N, window, noverlap, "spectrogram")
    fs = _fs_arg(fsv, "spectrogram")
    scale = fs if fs is not None else _TWO_PI
    cplx = np.iscomplexobj(xv)
    hop = L - nov
    K = (N - nov) // hop
    segs = [xv[k * hop:k * hop + L] * win for k in range(K)]
    t = (np.arange(K, dtype=np.float64) * hop + L / 2) / scale
    U = float(np.dot(win, win))
    fvec = None
    if not _empty(nfft) and _m._numel(nfft) > 1:
        # (the DFT at the frequencies given, rad/sample or Hz with fs: sum_n x(n) e^(-j w n))
        fvec = _md(nfft).reshape(-1).astype(np.float64)
        if rng is not None:
            raise _err("spectrogram: a frequency range does not apply to a vector of frequencies.")
        w = fvec * (_TWO_PI / fs if fs is not None else 1.0)
        E = np.exp(-1j * np.outer(w, np.arange(L)))
        S = np.stack([E @ s for s in segs], axis=1) if K else np.zeros((fvec.size, 0), dtype=np.complex128)
        f = fvec
    else:
        n = _nfft_default(L) if _empty(nfft) else _posint(nfft, "spectrogram", "nfft")
        rng = rng or ("twosided" if cplx else "onesided")
        if rng == "onesided" and cplx:
            raise _err("spectrogram: a one-sided transform needs real input.")
        S = np.stack([_wrapped_fft(s, n) for s in segs], axis=1) if K else np.zeros((n, 0), dtype=np.complex128)
        S = _keep(S, n, rng)
        f = _freqs(n, fs, rng)
    want_ps = nargout >= 4 or nargout == 0
    if want_ps:
        if fvec is not None:
            raise _err("spectrogram: the power spectral density of a vector of frequencies is not supported in Sagebrush.")
        ps = (S.real * S.real + S.imag * S.imag) / (U * scale)
        if rng == "onesided":
            ps = _onesided_power(ps, n)
    if nargout == 0:
        with np.errstate(divide="ignore"):
            db = 10 * np.log10(ps + np.finfo(float).eps)
        fx = f if fs is not None else f / _math.pi
        ty = t if fs is not None else t * _TWO_PI
        if "yaxis" in flags:
            _plot("imagesc", _row(ty), _col(fx), _out(db))
            _plot("xlabel", Char("Time (s)" if fs is not None else "Samples"))
            _plot("ylabel", _xlabel_freq(fs))
        else:
            _plot("imagesc", _row(fx), _col(ty), _out(db.T))
            _plot("xlabel", _xlabel_freq(fs))
            _plot("ylabel", Char("Time (s)" if fs is not None else "Samples"))
        _plot("axis", Char("xy"))
        _plot("colorbar")
        return NOVAL
    out = [_out(S), _col(f), _row(t)]
    if want_ps:
        out.append(_out(ps))
    return out[:nargout] if nargout > 1 else out[0]
