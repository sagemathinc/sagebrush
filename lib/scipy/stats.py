"""scipy.stats for Sagebrush in the browser: the distributions William's
QRPM book corpus uses (norm, t, f, chi2, cauchy, levy and binom), as SciPy
1.18's: frozen or not, loc and scale, NumPy's broadcasting, SciPy's values at
the support's ends and nan for an invalid parameter.  The statistics
functions (skew, kurtosis, pearsonr, spearmanr, rankdata, ttest_ind, levene,
jarque_bera, describe, zscore) are lib/_scipy_stats_py.py's, a chunk of its
own, imported at the first call of one of them.  (Under CPython, use SciPy
itself.)

The values come from scipy.special (lib/_special.py and
lib/_special_ibeta.py), each tail computed directly rather than as 1 minus
the other: a cdf of 1e-300 or an sf of 1e-300 keeps its digits.  Where
Sagebrush computes no value (levy_stable, the fit methods, ...) it raises
NotImplementedError, never a guess."""

import math as _math

import numpy as np

import scipy.special as _sc

__all__ = ["norm", "t", "f", "chi2", "cauchy", "levy", "binom",
           "rv_continuous", "rv_discrete", "rv_frozen", "levy_stable", "genextreme", "genpareto",
           "skew", "kurtosis", "pearsonr", "spearmanr", "rankdata", "ttest_ind", "levene", "jarque_bera",
           "describe", "zscore"]

_NAN = float("nan")
_INF = float("inf")
_LOG_SQRT_2PI = 0.9189385332046727


def _scalar_or(a):
    # (SciPy's result for scalar input: a NumPy scalar, not a 0-d array; a NumPy scalar already one)
    if isinstance(a, np.ndarray):
        return a[()] if a.ndim == 0 else a
    return np.float64(a) if isinstance(a, float) else a


def _ibeta_root(a, b, p):
    """(x, y, log x) with I_x(a, b) = p and y = 1 - x, each to its own
    precision: y by the symmetry I_y(b, a) = 1 - p (betainccinv, p given
    exactly) where x > 1/2, so a root near 1 keeps 1 - x's digits; log x by
    the tail's leading term x^a / (a B(a, b)) = p where x underflows"""
    a, b, p = [np.array(v, dtype=float).reshape(-1) for v in np.broadcast_arrays(a, b, p)]
    x = np.asarray(_sc.betaincinv(a, b, p), dtype=float).reshape(-1).copy()
    y = 1 - x
    big = x > 0.5
    if np.any(big):
        y[big] = np.asarray(_sc.betainccinv(b[big], a[big], p[big]), dtype=float).reshape(-1)
        x[big] = 1 - y[big]
    with np.errstate(divide="ignore"):
        lx = np.log(x)
    tiny = (x < 1e-300) & (p > 0)
    if np.any(tiny):
        lx[tiny] = (np.log(p[tiny]) + np.log(a[tiny]) + _sc.betaln(a[tiny], b[tiny])) / a[tiny]
    return x, y, lx


def _flat(*arrays):
    """the arguments broadcast together, as float64 copies flattened to 1-d (the
    computation's masks need an axis), and the broadcast shape to restore"""
    b = np.broadcast_arrays(*[np.asarray(a, dtype=float) for a in arrays])
    shape = b[0].shape
    return shape, [np.array(x, dtype=float).reshape(-1) for x in b]


def _done(out, shape):
    return _scalar_or(np.asarray(out, dtype=float).reshape(shape))


def _unsupported(what):
    return NotImplementedError("scipy.stats.%s is not in Sagebrush yet (the distributions here: %s)"
                               % (what, ", ".join(__all__[:7])))


class rv_frozen:
    """a distribution with its shape parameters, loc and scale fixed (SciPy's
    rv_continuous_frozen / rv_discrete_frozen)"""

    def __init__(self, dist, *args, **kwds):
        self.dist = dist
        self.args = args
        self.kwds = kwds

    def __getattr__(self, name):
        method = getattr(self.dist, name)
        if name in ("pdf", "logpdf", "pmf", "logpmf", "cdf", "logcdf", "sf", "logsf", "ppf", "isf"):
            return lambda x: method(x, *self.args, **self.kwds)
        if name in ("mean", "var", "std", "median", "entropy", "support"):
            return lambda: method(*self.args, **self.kwds)
        if name == "stats":
            return lambda moments="mv": method(*self.args, moments=moments, **self.kwds)
        if name == "interval":
            return lambda confidence: method(confidence, *self.args, **self.kwds)
        if name == "rvs":
            return lambda size=None, random_state=None: method(*self.args, size=size, random_state=random_state, **self.kwds)
        if name == "moment":
            return lambda order: method(order, *self.args, **self.kwds)
        raise AttributeError("'rv_frozen' object has no attribute %r" % name)


class _Dist:
    """What a continuous and a discrete distribution share: the parsing of
    shapes, loc and scale, their checks, broadcasting"""
    name = ""
    shapes = ()
    discrete = False

    def __call__(self, *args, **kwds):
        return rv_frozen(self, *args, **kwds)

    def freeze(self, *args, **kwds):
        return rv_frozen(self, *args, **kwds)

    def _parse(self, args, kwds, scale_ok=True):
        n = len(self.shapes)
        kwds = dict(kwds)
        args = list(args)
        for i, s in enumerate(self.shapes):
            if s in kwds:
                if i < len(args):
                    raise TypeError("_parse_args() got multiple values for argument '%s'" % s)
                args.append(kwds.pop(s))
        if len(args) < n:
            missing = self.shapes[len(args):]
            raise TypeError("_parse_args() missing %d required positional argument%s: %s"
                            % (len(missing), "" if len(missing) == 1 else "s", ", ".join("'%s'" % m for m in missing)))
        extra = args[n:]
        args = args[:n]
        for i, kw in enumerate(("loc", "scale")[:len(extra)]):
            if kw in kwds:
                raise TypeError("_parse_args() got multiple values for argument '%s'" % kw)
        loc = kwds.pop("loc", 0)
        scale = kwds.pop("scale", 1)
        if extra:
            loc = extra[0]
            if len(extra) > 1:
                if not scale_ok:
                    raise TypeError("_parse_args() takes from %d to %d positional arguments but %d were given" % (n, n + 1, n + len(extra)))
                scale = extra[1]
            if len(extra) > (2 if scale_ok else 1):
                raise TypeError("_parse_args() takes from %d to %d positional arguments but %d were given"
                                % (n, n + (2 if scale_ok else 1), n + len(extra)))
        if kwds:
            raise TypeError("%s() got an unexpected keyword argument '%s'" % (self.name, next(iter(kwds))))
        return args, loc, scale

    def _argcheck(self, *args):
        ok = True
        for a in args:
            ok = ok & (a > 0)
        return ok

    def support(self, *args, **kwds):
        """(a, b) for the parameters: broadcast together, nan where they are invalid, as SciPy's (a discrete
        distribution's in its parameters' own dtype where none is)"""
        args, loc, scale = self._parse(args, kwds, scale_ok=not self.discrete)
        fargs = [np.asarray(x, dtype=float) for x in args]
        a, b = self._support(*fargs)
        if all(np.ndim(x) == 0 for x in list(args) + [loc, scale]):
            ok = bool(self._argcheck(*fargs)) and (self.discrete or float(scale) > 0)
            if not ok:
                # (SciPy's: two Python floats, nan, for invalid parameters)
                return _NAN, _NAN
        if self.discrete:
            raw = [np.asarray(x) for x in args]
            ra, rb = self._support_raw(*raw)
            lo, hi = np.asarray(ra) + np.asarray(loc), np.asarray(rb) + np.asarray(loc)
        else:
            lo = np.asarray(loc, dtype=float) + np.asarray(scale, dtype=float) * a
            hi = np.asarray(loc, dtype=float) + np.asarray(scale, dtype=float) * b
        ok = self._argcheck(*fargs) & (True if self.discrete else (np.asarray(scale, dtype=float) > 0))
        shape = np.broadcast_arrays(np.asarray(lo), np.asarray(hi), np.asarray(ok))[0].shape
        lo, hi, ok = [np.broadcast_to(np.asarray(v), shape) for v in (lo, hi, ok)]
        if not np.all(ok):
            lo = np.where(ok, lo.astype(float), _NAN)
            hi = np.where(ok, hi.astype(float), _NAN)
        return _scalar_or(np.array(lo)), _scalar_or(np.array(hi))

    def fit(self, *args, **kwds):
        raise _unsupported("%s.fit" % self.name)

    def mean(self, *args, **kwds):
        return self.stats(*args, moments="m", **kwds)

    def var(self, *args, **kwds):
        return self.stats(*args, moments="v", **kwds)

    def std(self, *args, **kwds):
        return _scalar_or(np.sqrt(self.stats(*args, moments="v", **kwds)))

    def median(self, *args, **kwds):
        return self.ppf(0.5, *args, **kwds)

    def interval(self, confidence, *args, **kwds):
        c = np.asarray(confidence, dtype=float)
        if np.any((c > 1) | (c < 0)):
            raise ValueError("confidence must be in [0, 1]")
        return self.ppf((1 - c) / 2, *args, **kwds), self.ppf((1 + c) / 2, *args, **kwds)


class rv_continuous(_Dist):
    """A continuous distribution, as SciPy's rv_continuous: the standardized
    _pdf, _cdf, _sf, _ppf, _isf (and their logs where they lose digits) of
    each subclass, with loc and scale applied here"""
    _pdf_at_ends = False

    def _support(self, *args):
        return -_INF, _INF

    def _logpdf(self, z, *args):
        with np.errstate(divide="ignore"):
            return np.log(self._pdf(z, *args))

    def _logcdf(self, z, *args):
        # (log1p(-sf) where the cdf is above 1/2: log(cdf) would lose the sf's digits there)
        c = np.asarray(self._cdf(z, *args), dtype=float)
        with np.errstate(divide="ignore"):
            return np.where(c > 0.5, np.log1p(-np.asarray(self._sf(z, *args), dtype=float)), np.log(c))

    def _logsf(self, z, *args):
        c = np.asarray(self._sf(z, *args), dtype=float)
        with np.errstate(divide="ignore"):
            return np.where(c > 0.5, np.log1p(-np.asarray(self._cdf(z, *args), dtype=float)), np.log(c))

    def _isf(self, q, *args):
        return self._ppf(1 - q, *args)

    def _prep(self, x, args, kwds):
        args, loc, scale = self._parse(args, kwds)
        shape, arrs = _flat(x, loc, scale, *args)
        x, loc, scale = arrs[:3]
        shp = arrs[3:]
        ok = (scale > 0) & self._argcheck(*shp) & (loc == loc) & np.ones(x.shape, dtype=bool)
        a, b = self._support(*shp)
        a = a + np.zeros(x.shape)
        b = b + np.zeros(x.shape)
        return shape, x, loc, scale, shp, ok, a, b

    def _eval(self, which, x, args, kwds, inside, below, above):
        shape, x, loc, scale, shp, ok, a, b = self._prep(x, args, kwds)
        with np.errstate(invalid="ignore", divide="ignore", over="ignore"):
            z = (x - loc) / scale
        out = np.full(x.shape, _NAN)
        lo = ok & (z <= a) & (z == z)
        hi = ok & (z >= b) & (z == z)
        mid = ok & (z > a) & (z < b)
        out[lo] = below
        out[hi] = above
        if self._pdf_at_ends and which in ("pdf", "logpdf"):
            # (SciPy evaluates these distributions' density formula at the support's ends, 0 and inf: inf, a
            # value, 0 or nan by the shape, as chi2.pdf(0, 1) = inf, f.pdf(inf, 3, 7.5) = nan)
            ends = ok & ((z == a) | (z == b))
            if np.any(ends):
                with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
                    v = np.asarray(self._logpdf(z[ends], *[s_[ends] for s_ in shp]), dtype=float)
                    out[ends] = np.exp(v) / scale[ends] if which == "pdf" else v - np.log(scale[ends])
        if np.any(mid):
            sub = [s[mid] for s in shp]
            v = inside(z[mid], *sub)
            if which in ("pdf",):
                v = v / scale[mid]
            elif which == "logpdf":
                v = v - np.log(scale[mid])
            out[mid] = v
        return _done(out, shape)

    def pdf(self, x, *args, **kwds):
        return self._eval("pdf", x, args, kwds, self._pdf, 0.0, 0.0)

    def logpdf(self, x, *args, **kwds):
        return self._eval("logpdf", x, args, kwds, self._logpdf, -_INF, -_INF)

    def cdf(self, x, *args, **kwds):
        return self._eval("cdf", x, args, kwds, self._cdf, 0.0, 1.0)

    def logcdf(self, x, *args, **kwds):
        return self._eval("logcdf", x, args, kwds, self._logcdf, -_INF, 0.0)

    def sf(self, x, *args, **kwds):
        return self._eval("sf", x, args, kwds, self._sf, 1.0, 0.0)

    def logsf(self, x, *args, **kwds):
        return self._eval("logsf", x, args, kwds, self._logsf, 0.0, -_INF)

    def _quantile(self, q, args, kwds, inner, end0, end1):
        shape, q, loc, scale, shp, ok, a, b = self._prep(q, args, kwds)
        out = np.full(q.shape, _NAN)
        e0 = ok & (q == 0)
        e1 = ok & (q == 1)
        mid = ok & (q > 0) & (q < 1)
        out[e0] = (end0(a, b) * scale + loc)[e0]
        out[e1] = (end1(a, b) * scale + loc)[e1]
        if np.any(mid):
            out[mid] = inner(q[mid], *[s[mid] for s in shp]) * scale[mid] + loc[mid]
        return _done(out, shape)

    def ppf(self, q, *args, **kwds):
        return self._quantile(q, args, kwds, self._ppf, lambda a, b: a, lambda a, b: b)

    def isf(self, q, *args, **kwds):
        return self._quantile(q, args, kwds, self._isf, lambda a, b: b, lambda a, b: a)

    def stats(self, *args, moments="mv", **kwds):
        args, loc, scale = self._parse(args, kwds)
        shape, arrs = _flat(loc, scale, *args)
        loc, scale = arrs[:2]
        shp = arrs[2:]
        ok = (scale > 0) & self._argcheck(*shp) & np.ones(loc.shape, dtype=bool)
        m, v, s, k = self._stats(*shp)
        res = []
        for c in moments:
            if c == "m":
                r = np.asarray(m, dtype=float) * scale + loc
            elif c == "v":
                r = np.asarray(v, dtype=float) * scale * scale
            elif c == "s":
                r = np.broadcast_to(np.asarray(s, dtype=float), loc.shape).copy()
            elif c == "k":
                r = np.broadcast_to(np.asarray(k, dtype=float), loc.shape).copy()
            else:
                continue
            r = np.where(ok, r, _NAN)
            res.append(_done(r, shape))
        return res[0] if len(res) == 1 else tuple(res)

    def rvs(self, *args, size=None, random_state=None, **kwds):
        args, loc, scale = self._parse(args, kwds)
        shape, z_args = _rvs_shape(self, args, loc, scale, size, True)
        rs = _random_state(random_state)
        z = self._rvs(rs, shape, *[np.broadcast_to(np.asarray(a, dtype=float), shape) for a in args])
        out = np.asarray(z, dtype=float) * np.asarray(scale, dtype=float) + np.asarray(loc, dtype=float)
        return _scalar_or(np.asarray(out, dtype=float).reshape(shape))

    def _rvs(self, rs, shape, *args):
        # (by inversion of a uniform draw: SciPy's own default, rv_continuous._rvs, so the same seed gives
        # SciPy's numbers)
        u = rs.uniform(size=None if shape == () else shape)
        flat = np.asarray(u, dtype=float).reshape(-1)
        return np.asarray(self._ppf(flat, *[np.asarray(a, dtype=float).reshape(-1) for a in args]), dtype=float).reshape(shape)


_DOMAIN = ("Domain error in arguments. The `scale` parameter must be positive for all distributions, and many "
           "distributions have restrictions on shape parameters. Please see the `scipy.stats.%s` documentation for details.")


def _rvs_shape(dist, args, loc, scale, size, continuous):
    """the sample's shape (size, else the parameters' broadcast shape) after SciPy's checks: every parameter in its
    domain (ValueError otherwise) and the parameters broadcasting to size"""
    fargs = [np.asarray(a, dtype=float) for a in args]
    ok = dist._argcheck(*fargs) & (np.asarray(scale, dtype=float) > 0 if continuous else True)
    if not np.all(ok):
        raise ValueError(_DOMAIN % dist.name)
    bshape = np.broadcast_arrays(np.asarray(loc), np.asarray(scale), *fargs)[0].shape
    if size is None:
        return bshape, fargs
    dims = list(size) if isinstance(size, (tuple, list)) else [size]
    for v in dims:
        # (SciPy's, from NumPy's: a dimension that isn't an integer is a TypeError, never truncated; checked before
        # any array is made of them)
        if isinstance(v, str):
            raise TypeError("'numpy.str_' object cannot be interpreted as an integer")
        if not isinstance(v, (int, np.integer)) or isinstance(v, bool):
            raise TypeError("'numpy.%s' object cannot be interpreted as an integer" % type(np.asarray(v)[()]).__name__)
    size_ = tuple(int(v) for v in dims)
    try:
        fits = np.broadcast_arrays(np.zeros(size_), np.zeros(bshape))[0].shape == size_
    except ValueError:
        fits = False
    if not fits:
        raise ValueError("size does not match the broadcast shape of the parameters. %s, %s, %s"
                         % (size, tuple(np.int64(v) for v in size_), bshape))
    return size_, fargs


def _no_sampler(name, method):
    def f(self, rs, shape, *args):
        raise NotImplementedError("scipy.stats.%s.rvs is not in Sagebrush yet: Sagebrush's numpy.random has no %s, "
                                  "SciPy's sampler for it" % (name, method))
    return f


def _random_state(seed):
    # (SciPy's check_random_state)
    if seed is None or seed is np.random:
        # (NumPy's global RandomState: numpy.random.mtrand._rand there, Sagebrush's numpy.random._global here; the
        # same stream np.random.seed sets)
        mt = getattr(np.random, "mtrand", None)
        return mt._rand if mt is not None else np.random._global
    if isinstance(seed, (int, np.integer)):
        return np.random.RandomState(seed)
    if isinstance(seed, (np.random.RandomState, np.random.Generator)):
        return seed
    raise ValueError("%r cannot be used to seed a numpy.random.RandomState instance" % (seed,))


# ------------------------------------------------------------------ norm

class norm_gen(rv_continuous):
    """the normal distribution: Phi by ndtr, its log by log_ndtr, the
    quantile by ndtri, each tail directly"""
    name = "norm"

    def _pdf(self, z):
        return np.exp(-0.5 * z * z - _LOG_SQRT_2PI)

    def _logpdf(self, z):
        return -0.5 * z * z - _LOG_SQRT_2PI

    def _cdf(self, z):
        return _sc.ndtr(z)

    def _sf(self, z):
        return _sc.ndtr(-z)

    def _logcdf(self, z):
        return _sc.log_ndtr(z)

    def _logsf(self, z):
        return _sc.log_ndtr(-z)

    def _ppf(self, q):
        return _sc.ndtri(q)

    def _isf(self, q):
        return -_sc.ndtri(q)

    def _stats(self):
        return 0.0, 1.0, 0.0, 0.0

    def _rvs(self, rs, shape):
        return rs.standard_normal(None if shape == () else shape)


norm = norm_gen()


# ------------------------------------------------------------------ Student's t

class t_gen(rv_continuous):
    """Student's t with df degrees of freedom: its cdf by the incomplete beta
    function, I_(df/(df+x^2))(df/2, 1/2)/2 in the tails, and
    1/2 + I_(x^2/(df+x^2))(1/2, df/2)/2 near 0, where the first argument
    would round to 1 (DLMF 8.17.4's symmetry, each form where its argument
    keeps its digits); the quantile by the inverse of the same form"""
    name = "t"
    shapes = ("df",)

    def _pdf(self, z, df):
        return np.exp(self._logpdf(z, df))

    def _logpdf(self, z, df):
        # (Gamma((df+1)/2) / (sqrt(df pi) Gamma(df/2)) = 1 / (sqrt(df) B(df/2, 1/2)))
        return -0.5 * np.log(df) - _sc.betaln(df / 2, 0.5) - (df + 1) / 2 * np.log1p(z * z / df)

    def _tail(self, z, df):
        # (P(T > |z|): the one-sided tail)
        z2 = z * z
        near = z2 < df
        w = np.empty(z.shape)
        if np.any(near):
            u = z2[near] / (df[near] + z2[near])
            w[near] = 0.5 * _sc.betaincc(0.5, df[near] / 2, u)
        far = ~near
        if np.any(far):
            v = df[far] / (df[far] + z2[far])
            w[far] = 0.5 * _sc.betainc(df[far] / 2, 0.5, v)
        return w

    def _cdf(self, z, df):
        w = self._tail(z, df)
        return np.where(z < 0, w, 1 - w)

    def _sf(self, z, df):
        w = self._tail(z, df)
        return np.where(z > 0, w, 1 - w)

    def _ppf(self, q, df):
        # (the two tails 2 min(q, 1 - q) = I_v(df/2, 1/2), v = df/(df + x^2), so x = sqrt(df (1 - v)/v), v and 1 - v
        # each to its precision (_ibeta_root), and through log v where v underflows; near the centre,
        # |1 - 2q| = I_u(1/2, df/2), u = x^2/(df + x^2), x = sqrt(df u/(1 - u)))
        s = np.minimum(q, 1 - q)
        two = 2 * s
        x = np.empty(q.shape)
        tail = two < 0.5
        if np.any(tail):
            v, w, lv = _ibeta_root(df[tail] / 2, 0.5, two[tail])
            dft = df[tail]
            with np.errstate(divide="ignore", over="ignore"):
                x[tail] = np.where(v >= 1e-300, np.sqrt(dft * (w / np.where(v > 0, v, 1.0))), np.exp(0.5 * (np.log(dft) - lv)))
        mid = ~tail
        if np.any(mid):
            u, w, lu = _ibeta_root(0.5, df[mid] / 2, np.abs(1 - 2 * q[mid]))
            x[mid] = np.sqrt(df[mid] * (u / w))
        return np.where(q < 0.5, -x, x)

    def _isf(self, q, df):
        return -self._ppf(q, df)

    def _stats(self, df):
        m = np.where(df > 1, 0.0, _INF)
        v = np.where(df > 2, df / np.where(df > 2, df - 2, 1.0), np.where(df > 1, _INF, _NAN))
        s = np.where(df > 3, 0.0, _NAN)
        k = np.where(df > 4, 6.0 / np.where(df > 4, df - 4, 1.0), np.where(df > 2, _INF, _NAN))
        return m, v, s, k

    _rvs = _no_sampler("t", "standard_t")


t = t_gen()


# ------------------------------------------------------------------ F

class f_gen(rv_continuous):
    """the F distribution: cdf I_w(dfn/2, dfd/2), w = dfn x/(dfn x + dfd), and
    sf I_(1-w)(dfd/2, dfn/2) with 1 - w = dfd/(dfn x + dfd) formed directly"""
    name = "f"
    shapes = ("dfn", "dfd")
    _pdf_at_ends = True

    def _support(self, dfn, dfd):
        return 0.0, _INF

    def _logpdf(self, z, dfn, dfd):
        # (n/2 log(n/m) + (n/2 - 1) log z - (n + m)/2 log1p(n z/m) - log B(n/2, m/2): the large terms
        # m/2 log m and (n + m)/2 log(m + n z) cancelled analytically)
        n, m = dfn, dfd
        return _sc.xlogy(n / 2, n / m) + _sc.xlogy(n / 2 - 1, z) - (n + m) / 2 * np.log1p(n * z / m) - _sc.betaln(n / 2, m / 2)

    def _pdf(self, z, dfn, dfd):
        return np.exp(self._logpdf(z, dfn, dfd))

    def _tails(self, z, dfn, dfd):
        # (cdf, sf) through whichever of w = dfn z/(dfn z + dfd) and 1 - w = dfd/(dfn z + dfd) is at most 1/2, so the
        # incomplete beta function's argument is never one that rounded near 1 (its complement would lose digits)
        d = dfn * z + dfd
        w = dfn * z / d
        c = dfd / d
        small = w <= 0.5
        cdf = np.where(small, _sc.betainc(dfn / 2, dfd / 2, np.where(small, w, 0.25)), _sc.betaincc(dfd / 2, dfn / 2, np.where(small, 0.25, c)))
        sf = np.where(small, _sc.betaincc(dfn / 2, dfd / 2, np.where(small, w, 0.25)), _sc.betainc(dfd / 2, dfn / 2, np.where(small, 0.25, c)))
        return cdf, sf

    def _cdf(self, z, dfn, dfd):
        return self._tails(z, dfn, dfd)[0]

    def _sf(self, z, dfn, dfd):
        return self._tails(z, dfn, dfd)[1]

    def _upper(self, c, w, lc, dfn, dfd):
        # (x = dfd (1 - c)/(dfn c) from c and w = 1 - c, through log c where c underflows)
        with np.errstate(divide="ignore", over="ignore"):
            return np.where(c >= 1e-300, dfd * w / (dfn * np.where(c > 0, c, 1.0)), np.exp(np.log(dfd / dfn) + np.log(w) - lc))

    def _ppf(self, q, dfn, dfd):
        # (q <= 1/2 by w with I_w(dfn/2, dfd/2) = q; above, by c = 1 - w with I_c(dfd/2, dfn/2) = 1 - q; each with its
        # complement to its own precision, _ibeta_root)
        out = np.empty(q.shape)
        lo = q <= 0.5
        if np.any(lo):
            w, c, lw = _ibeta_root(dfn[lo] / 2, dfd[lo] / 2, q[lo])
            out[lo] = dfd[lo] * w / (dfn[lo] * c)
        hi = ~lo
        if np.any(hi):
            c, w, lc = _ibeta_root(dfd[hi] / 2, dfn[hi] / 2, 1 - q[hi])
            out[hi] = self._upper(c, w, lc, dfn[hi], dfd[hi])
        return out

    def _isf(self, q, dfn, dfd):
        # (the upper tail q: c = 1 - w with I_c(dfd/2, dfn/2) = q directly)
        c, w, lc = _ibeta_root(dfd / 2, dfn / 2, q)
        return self._upper(c, w, lc, dfn, dfd)

    def _stats(self, dfn, dfd):
        v1, v2 = dfn, dfd
        m = np.where(v2 > 2, v2 / np.where(v2 > 2, v2 - 2, 1.0), _INF)
        v = np.where(v2 > 4, 2 * v2 * v2 * (v1 + v2 - 2) / (v1 * (v2 - 2) ** 2 * np.where(v2 > 4, v2 - 4, 1.0)), _INF)
        s = np.where(v2 > 6, (2 * v1 + v2 - 2) * np.sqrt(8 * np.where(v2 > 4, v2 - 4, 1.0)) / (np.where(v2 > 6, v2 - 6, 1.0) * np.sqrt(v1 * (v1 + v2 - 2))), _NAN)
        k = np.where(v2 > 8, 12 * (v1 * (5 * v2 - 22) * (v1 + v2 - 2) + (v2 - 4) * (v2 - 2) ** 2)
                     / (v1 * np.where(v2 > 8, v2 - 6, 1.0) * np.where(v2 > 8, v2 - 8, 1.0) * (v1 + v2 - 2)), _NAN)
        return m, v, s, k

    _rvs = _no_sampler("f", "f")


f = f_gen()


# ------------------------------------------------------------------ chi-squared

class chi2_gen(rv_continuous):
    """the chi-squared distribution: P(df/2, x/2) and Q(df/2, x/2), the
    quantile by their inverses"""
    name = "chi2"
    shapes = ("df",)
    _pdf_at_ends = True

    def _support(self, df):
        return 0.0, _INF

    def _logpdf(self, z, df):
        return _sc.xlogy(df / 2 - 1, z) - z / 2 - _sc.gammaln(df / 2) - (_math.log(2) * df / 2)

    def _pdf(self, z, df):
        return np.exp(self._logpdf(z, df))

    def _cdf(self, z, df):
        return _sc.gammainc(df / 2, z / 2)

    def _sf(self, z, df):
        return _sc.gammaincc(df / 2, z / 2)

    def _ppf(self, q, df):
        return 2 * _sc.gammaincinv(df / 2, q)

    def _isf(self, q, df):
        return 2 * _sc.gammainccinv(df / 2, q)

    def _stats(self, df):
        return df, 2 * df, 2 * np.sqrt(2.0 / df), 12.0 / df

    _rvs = _no_sampler("chi2", "chisquare")


chi2 = chi2_gen()


# ------------------------------------------------------------------ Cauchy

class cauchy_gen(rv_continuous):
    """the Cauchy distribution: 1/2 + atan(x)/pi, each tail as atan(1/|x|)/pi
    where it is the smaller (no 1 - ... for large |x|)"""
    name = "cauchy"

    def _pdf(self, z):
        return 1.0 / (np.pi * (1.0 + z * z))

    def _logpdf(self, z):
        # (-log(pi (1 + z^2)), through log|z| where z^2 overflows)
        az = np.abs(z)
        with np.errstate(over="ignore", divide="ignore"):
            return np.where(az < 1e150, -np.log(np.pi) - np.log1p(z * z), -np.log(np.pi) - 2 * np.log(az))

    def _cdf(self, z):
        return np.where(z < -1, np.arctan(-1.0 / z) / np.pi, 0.5 + np.arctan(z) / np.pi)

    def _sf(self, z):
        return self._cdf(-z)

    def _ppf(self, q):
        # (SciPy's tan(pi (q - 1/2)); for q < 1/4, -1/tan(pi q), whose argument is exact)
        return np.where(q < 0.25, -1.0 / np.tan(np.pi * q), np.where(q > 0.75, 1.0 / np.tan(np.pi * (1 - q)), np.tan(np.pi * (q - 0.5))))

    def _isf(self, q):
        return -self._ppf(q)

    def _stats(self):
        return _NAN, _NAN, _NAN, _NAN

    _rvs = _no_sampler("cauchy", "standard_cauchy")


cauchy = cauchy_gen()


# ------------------------------------------------------------------ Levy

class levy_gen(rv_continuous):
    """the Levy distribution: cdf erfc(1/sqrt(2x)), sf erf(1/sqrt(2x)) (by
    erfc's complement only where that is the larger), the quantile
    1/(2 erfcinv(q)^2)"""
    name = "levy"

    def _support(self):
        return 0.0, _INF

    def _pdf(self, z):
        return 1 / np.sqrt(2 * np.pi * z) / z * np.exp(-1 / (2 * z))

    def _cdf(self, z):
        return _sc.erfc(np.sqrt(0.5 / z))

    def _sf(self, z):
        return _sc.erf(np.sqrt(0.5 / z))

    def _ppf(self, q):
        val = _sc.erfcinv(q)
        return 1.0 / (2 * val * val)

    def _isf(self, q):
        val = _sc.erfinv(q)
        return 1.0 / (2 * val * val)

    def _stats(self):
        return _INF, _INF, _NAN, _NAN



levy = levy_gen()


# ------------------------------------------------------------------ binomial

class rv_discrete(_Dist):
    """A discrete distribution on the integers, as SciPy's rv_discrete: loc
    shifts it; there is no scale"""
    discrete = True

    def _prep(self, k, args, kwds, shift=True):
        args, loc, _ = self._parse(args, kwds, scale_ok=False)
        shape, arrs = _flat(k, loc, *args)
        k, loc = arrs[:2]
        shp = arrs[2:]
        ok = self._argcheck(*shp) & (loc == loc) & np.ones(k.shape, dtype=bool)
        a, b = self._support(*shp)
        return shape, (k - loc if shift else k), loc, shp, ok, a + np.zeros(k.shape), b + np.zeros(k.shape)

    def pmf(self, k, *args, **kwds):
        shape, k, loc, shp, ok, a, b = self._prep(k, args, kwds)
        out = np.where(ok & (k == k), 0.0, _NAN)
        mid = ok & (k >= a) & (k <= b) & (k == np.floor(k))
        if np.any(mid):
            out[mid] = self._pmf(k[mid], *[s[mid] for s in shp])
        return _done(out, shape)

    def logpmf(self, k, *args, **kwds):
        shape, k, loc, shp, ok, a, b = self._prep(k, args, kwds)
        out = np.where(ok & (k == k), -_INF, _NAN)
        mid = ok & (k >= a) & (k <= b) & (k == np.floor(k))
        if np.any(mid):
            out[mid] = self._logpmf(k[mid], *[s[mid] for s in shp])
        return _done(out, shape)

    def cdf(self, k, *args, **kwds):
        shape, k, loc, shp, ok, a, b = self._prep(k, args, kwds)
        k = np.floor(k)
        out = np.full(k.shape, _NAN)
        out[ok & (k < a)] = 0.0
        out[ok & (k >= b)] = 1.0
        mid = ok & (k >= a) & (k < b)
        if np.any(mid):
            out[mid] = self._cdf(k[mid], *[s[mid] for s in shp])
        return _done(out, shape)

    def sf(self, k, *args, **kwds):
        shape, k, loc, shp, ok, a, b = self._prep(k, args, kwds)
        k = np.floor(k)
        out = np.full(k.shape, _NAN)
        out[ok & (k < a)] = 1.0
        out[ok & (k >= b)] = 0.0
        mid = ok & (k >= a) & (k < b)
        if np.any(mid):
            out[mid] = self._sf(k[mid], *[s[mid] for s in shp])
        return _done(out, shape)

    def logcdf(self, k, *args, **kwds):
        # (SciPy's: log(cdf), and 0 at k >= the support's end even where the parameters are invalid)
        shape, kk, loc, shp, ok, a, b = self._prep(k, args, kwds)
        with np.errstate(divide="ignore"):
            out = np.log(np.asarray(self.cdf(k, *args, **kwds), dtype=float)).reshape(-1)
        out[np.floor(kk) >= b] = 0.0
        return _done(out, shape)

    def logsf(self, k, *args, **kwds):
        # (SciPy's: log(sf), and 0 below the support's start even where the parameters are invalid)
        shape, kk, loc, shp, ok, a, b = self._prep(k, args, kwds)
        with np.errstate(divide="ignore"):
            out = np.log(np.asarray(self.sf(k, *args, **kwds), dtype=float)).reshape(-1)
        out[ok & (np.floor(kk) < a)] = 0.0
        return _done(out, shape)

    def ppf(self, q, *args, **kwds):
        # (the least k with cdf(k) >= q; SciPy's: a - 1 at q = 0, b at q = 1, nan outside [0, 1])
        shape, q, loc, shp, ok, a, b = self._prep(q, args, kwds, shift=False)
        out = np.full(q.shape, _NAN)
        e0 = ok & (q == 0)
        e1 = ok & (q == 1)
        out[e0] = (a - 1)[e0]
        out[e1] = b[e1]
        mid = ok & (q > 0) & (q < 1)
        if np.any(mid):
            out[mid] = self._ppf(q[mid], *[s[mid] for s in shp])
        return _done(out + loc, shape)

    def isf(self, q, *args, **kwds):
        # (SciPy's: ppf(1 - q), 1 - q rounded)
        return self.ppf(1 - np.asarray(q, dtype=float), *args, **kwds)

    def stats(self, *args, moments="mv", **kwds):
        args, loc, _ = self._parse(args, kwds, scale_ok=False)
        shape, arrs = _flat(loc, *args)
        loc = arrs[0]
        shp = arrs[1:]
        ok = self._argcheck(*shp) & np.ones(loc.shape, dtype=bool)
        m, v, s, k = self._stats(*shp)
        res = []
        for c in moments:
            r = {"m": np.asarray(m, dtype=float) + loc, "v": np.asarray(v, dtype=float) + 0 * loc,
                 "s": np.asarray(s, dtype=float) + 0 * loc, "k": np.asarray(k, dtype=float) + 0 * loc}.get(c)
            if r is None:
                continue
            res.append(_done(np.where(ok, r, _NAN), shape))
        return res[0] if len(res) == 1 else tuple(res)

    def rvs(self, *args, size=None, random_state=None, **kwds):
        args, loc, _ = self._parse(args, kwds, scale_ok=False)
        shape, fargs = _rvs_shape(self, args, loc, 1, size, False)
        rs = _random_state(random_state)
        z = self._rvs(rs, shape, *[np.broadcast_to(np.asarray(a), shape) for a in args])
        return _scalar_or(np.asarray(np.asarray(z) + np.asarray(loc), dtype=np.int64).reshape(shape))


class binom_gen(rv_discrete):
    """the binomial distribution: its pmf through log C(n, k) =
    -log(n + 1) - betaln(n - k + 1, k + 1), its cdf and sf by the incomplete
    beta function, P(X <= k) = I_(1-p)(n - k, k + 1) and P(X > k) =
    I_p(k + 1, n - k), each computed directly (betaincc and betainc of p);
    the quantile by a search from the normal approximation, the least k with
    cdf(k) >= q"""
    name = "binom"
    shapes = ("n", "p")

    def _argcheck(self, n, p):
        return (n >= 0) & (n == np.floor(n)) & (p >= 0) & (p <= 1)

    def _support(self, n, p):
        return 0.0, n

    def _logpmf(self, k, n, p):
        # (log C(n, k) exactly 0 at k = 0 and k = n, so a pmf of 1 there, p = 0 or 1, is exactly 1)
        logc = np.where((k == 0) | (k == n), 0.0, -np.log1p(n) - _sc.betaln(n - k + 1, k + 1))
        return logc + _sc.xlogy(k, p) + _sc.xlog1py(n - k, -p)

    def _pmf(self, k, n, p):
        return np.exp(self._logpmf(k, n, p))

    def _cdf(self, k, n, p):
        return _sc.betaincc(k + 1, n - k, p)

    def _sf(self, k, n, p):
        return _sc.betainc(k + 1, n - k, p)

    def _search(self, q, n, p, upper):
        # (the least k in [0, n] with cdf(k) >= q, or with sf(k) <= q (upper): from the normal approximation, then
        # stepping by the exact cdf or sf, each step a betainc of p)
        out = np.empty(q.shape)
        for i in range(q.size):
            qi, ni, pi_ = float(q.flat[i]), float(n.flat[i]), float(p.flat[i])
            mu, sd = ni * pi_, _math.sqrt(ni * pi_ * (1 - pi_))
            z = float(_sc.ndtri(1 - qi if upper else qi))
            start = mu + z * sd if sd > 0 and _math.isfinite(z) else mu
            k = min(max(_math.floor(start), 0.0), ni)
            hit = (lambda k: float(self._sf(np.asarray(k), np.asarray(ni), np.asarray(pi_))) <= qi) if upper else \
                (lambda k: float(self._cdf(np.asarray(k), np.asarray(ni), np.asarray(pi_))) >= qi)
            if hit(k):
                while k > 0 and hit(k - 1):
                    k -= 1
            else:
                while k < ni and not hit(k):
                    k += 1
            out.flat[i] = k
        return out

    def _ppf(self, q, n, p):
        return self._search(q, n, p, False)


    def _stats(self, n, p):
        q = 1 - p
        mu = n * p
        var = n * p * q
        # (SciPy's form, whose inf and nan at a variance of 0 it keeps: 1/sqrt(npq) - 2p/sqrt(npq) and
        # 1/(npq) - 6/n)
        with np.errstate(divide="ignore", invalid="ignore"):
            sq = np.sqrt(var)
            g1 = 1.0 / sq - 2.0 * p / sq
            g2 = 1.0 / var - 6.0 / n
        return mu, var, g1, g2

    _rvs = _no_sampler("binom", "binomial")

    def _support_raw(self, n, p):
        return np.zeros_like(n), n


binom = binom_gen()


# ------------------------------------------------------------------ not in Sagebrush yet

class _NotYet:
    def __init__(self, name):
        self._name = name

    def __getattr__(self, attr):
        if attr.startswith("__"):
            raise AttributeError(attr)
        raise _unsupported("%s.%s" % (self._name, attr))

    def __call__(self, *args, **kwds):
        raise _unsupported(self._name)


levy_stable = _NotYet("levy_stable")
genextreme = _NotYet("genextreme")
genpareto = _NotYet("genpareto")


# ------------------------------------------------------------------ the statistics functions

def _py(name):
    # (lib/_scipy_stats_py.py's function, imported at its first call: its own library chunk in the browser,
    # mod-scipy-stats-py, so the distributions' users don't fetch it)
    def f(*args, **kwds):
        import _scipy_stats_py
        return getattr(_scipy_stats_py, name)(*args, **kwds)
    f.__name__ = f.__qualname__ = name
    return f


skew = _py("skew")
kurtosis = _py("kurtosis")
pearsonr = _py("pearsonr")
spearmanr = _py("spearmanr")
rankdata = _py("rankdata")
ttest_ind = _py("ttest_ind")
levene = _py("levene")
jarque_bera = _py("jarque_bera")
describe = _py("describe")
zscore = _py("zscore")

