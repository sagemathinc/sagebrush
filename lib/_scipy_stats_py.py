"""scipy.stats' statistics functions for Sagebrush (scipy.stats imports this
module at the first call of one of them: its own library chunk in the
browser, mod-scipy-stats-py): skew, kurtosis, pearsonr, spearmanr, rankdata,
ttest_ind, levene, jarque_bera, describe and zscore, as SciPy 1.18's: their
arguments (axis, bias, fisher, nan_policy, alternative, equal_var, center,
...), their result objects (tuples with named fields: PearsonRResult,
SignificanceResult, TtestResult, LeveneResult, DescribeResult) and their
values.  The formulas follow SciPy's scipy/stats/_stats_py.py and
_morestats.py (BSD 3-Clause, see NOTICE.md); the p-values come from
scipy.stats' distributions, each tail computed directly."""

import math as _math

import numpy as np

import scipy.special as _sc

_NAN = float("nan")
_EPS = 2.220446049250313e-16


# ------------------------------------------------------------------ results

class ConfidenceInterval(tuple):
    """(low, high): SciPy's ConfidenceInterval"""
    _fields = ("low", "high")

    def __new__(cls, low, high):
        return tuple.__new__(cls, (low, high))

    low = property(lambda self: self[0])
    high = property(lambda self: self[1])

    def __repr__(self):
        return "ConfidenceInterval(low=%r, high=%r)" % (self[0], self[1])


class PearsonRResult(tuple):
    """(statistic, pvalue), with confidence_interval(): SciPy's PearsonRResult"""

    def __new__(cls, statistic, pvalue, n=0, alternative="two-sided"):
        self = tuple.__new__(cls, (statistic, pvalue))
        self._n = n
        self._alternative = alternative
        return self

    statistic = property(lambda self: self[0])
    pvalue = property(lambda self: self[1])

    def __repr__(self):
        return "PearsonRResult(statistic=%r, pvalue=%r)" % (self[0], self[1])

    def confidence_interval(self, confidence_level=0.95, method=None):
        """Fisher's transformation, as SciPy's (method=None)"""
        if method is not None:
            raise NotImplementedError("scipy.stats.PearsonRResult.confidence_interval: method= is not supported in Sagebrush")
        r, n = float(self[0]), self._n
        # (three samples or fewer: the whole interval, (-1, 1), for any alternative, as SciPy's)
        if n <= 3:
            return ConfidenceInterval(np.float64(-1.0), np.float64(1.0))
        # (an undefined r stays undefined: atanh(nan) is nan, not an infinity of nan's sign)
        z = r if r != r else _math.atanh(r) if abs(r) < 1 else _math.copysign(_math.inf, r)
        se = 1 / _math.sqrt(n - 3)
        if self._alternative == "two-sided":
            h = float(_sc.ndtri(0.5 + confidence_level / 2))
            lo, hi = z - h * se, z + h * se
        elif self._alternative == "less":
            lo, hi = -_math.inf, z + float(_sc.ndtri(confidence_level)) * se
        else:
            lo, hi = z - float(_sc.ndtri(confidence_level)) * se, _math.inf
        return ConfidenceInterval(np.float64(_math.tanh(lo)), np.float64(_math.tanh(hi)))


class SignificanceResult(tuple):
    """(statistic, pvalue): SciPy's SignificanceResult (spearmanr's also as .correlation)"""

    def __new__(cls, statistic, pvalue):
        return tuple.__new__(cls, (statistic, pvalue))

    statistic = property(lambda self: self[0])
    pvalue = property(lambda self: self[1])
    correlation = property(lambda self: self[0])

    def __repr__(self):
        return "SignificanceResult(statistic=%r, pvalue=%r)" % (self[0], self[1])


class TtestResult(tuple):
    """(statistic, pvalue), with df and confidence_interval(): SciPy's TtestResult"""

    def __new__(cls, statistic, pvalue, df, estimate=None, se=None, alternative="two-sided"):
        self = tuple.__new__(cls, (statistic, pvalue))
        self._df, self._estimate, self._se, self._alternative = df, estimate, se, alternative
        return self

    statistic = property(lambda self: self[0])
    pvalue = property(lambda self: self[1])
    df = property(lambda self: self._df)

    def __repr__(self):
        return "TtestResult(statistic=%r, pvalue=%r, df=%r)" % (self[0], self[1], self._df)

    def confidence_interval(self, confidence_level=0.95):
        """as SciPy's _t_confidence_interval: t's quantiles (one-sided: an infinite one) scaled by the standard error
        and shifted by the estimate, low = q_low * se + estimate, so that an undefined or zero se leaves an
        undefined end, not an infinite one"""
        import scipy.stats as st
        if confidence_level < 0 or confidence_level > 1:
            raise ValueError("`confidence_level` must be a number between 0 and 1.")
        est, se, df = self._estimate, self._se, self._df
        inf = np.float64(_math.inf)
        if self._alternative == "less":
            q_lo, q_hi = -inf, st.t.ppf(confidence_level, df)
        elif self._alternative == "greater":
            q_lo, q_hi = st.t.ppf(1 - confidence_level, df), inf
        else:
            tail = (1 - confidence_level) / 2
            q_lo, q_hi = st.t.ppf(tail, df), st.t.ppf(1 - tail, df)
        with np.errstate(invalid="ignore", over="ignore"):
            lo = np.asarray(q_lo, dtype=float) * se + est
            hi = np.asarray(q_hi, dtype=float) * se + est
        # (n-d tests: both bounds arrays of the tests' shape, a one-sided interval's infinite end too)
        if np.ndim(lo) or np.ndim(hi):
            shape = np.shape(lo) if np.ndim(lo) else np.shape(hi)
            return ConfidenceInterval(np.asarray(lo, dtype=float) + np.zeros(shape), np.asarray(hi, dtype=float) + np.zeros(shape))
        return ConfidenceInterval(np.float64(float(lo)), np.float64(float(hi)))


class LeveneResult(tuple):
    """(statistic, pvalue): SciPy's LeveneResult"""

    def __new__(cls, statistic, pvalue):
        return tuple.__new__(cls, (statistic, pvalue))

    statistic = property(lambda self: self[0])
    pvalue = property(lambda self: self[1])

    def __repr__(self):
        return "LeveneResult(statistic=%r, pvalue=%r)" % (self[0], self[1])


class DescribeResult(tuple):
    """(nobs, minmax, mean, variance, skewness, kurtosis): SciPy's DescribeResult"""
    _fields = ("nobs", "minmax", "mean", "variance", "skewness", "kurtosis")

    def __new__(cls, *vals):
        return tuple.__new__(cls, vals)

    nobs = property(lambda self: self[0])
    minmax = property(lambda self: self[1])
    mean = property(lambda self: self[2])
    variance = property(lambda self: self[3])
    skewness = property(lambda self: self[4])
    kurtosis = property(lambda self: self[5])

    def __repr__(self):
        return "DescribeResult(%s)" % ", ".join("%s=%r" % (f, v) for f, v in zip(self._fields, self))


# ------------------------------------------------------------------ input handling

def _scalar_or(a):
    if isinstance(a, np.ndarray):
        return a[()] if a.ndim == 0 else a
    return np.float64(a) if isinstance(a, float) else a


def _array(a, axis):
    """a as a float64 array with the reduction axis last (axis=None: flattened), and the shape of the result"""
    a = np.asarray(a, dtype=float)
    if axis is None:
        return a.reshape(-1), ()
    if a.ndim == 0:
        a = a.reshape(1)
    # (an axis in range, a negative one counted from the end; beyond, SciPy's AxisError, not wrapped)
    if not -a.ndim <= axis < a.ndim:
        raise AxisError("`axis` is out of bounds for array of dimension %d" % a.ndim)
    ax = axis % a.ndim
    a = np.moveaxis(a, ax, -1)
    return a, a.shape[:-1]


def _check_nan_policy(nan_policy):
    if nan_policy not in ("propagate", "omit", "raise"):
        raise ValueError("nan_policy must be one of {'omit', 'raise', 'propagate'}.")


def _rows(a, shape, nan_policy):
    """each 1-d slice along the (last) axis, its nans dropped for nan_policy='omit' (a ValueError for 'raise')"""
    _check_nan_policy(nan_policy)
    # (the rows' count given, not inferred: an axis of length 0 leaves -1 nothing to infer it from)
    flat = a.reshape(int(np.prod(a.shape[:-1])), a.shape[-1]) if a.ndim > 1 else a.reshape(1, a.size)
    rows = []
    for r in flat:
        has = np.any(r != r)
        if has and nan_policy == "raise":
            raise ValueError("The input contains nan values")
        rows.append(r[r == r] if (has and nan_policy == "omit") else r)
    return rows


def _out(vals, shape):
    v = np.array(vals, dtype=float).reshape(shape)
    return _scalar_or(v)


def _moments(r):
    """(n, mean, m2, m3, m4): the central moments as SciPy's _moment, about the mean, by repeated multiplication"""
    n = r.size
    if n == 0:
        return 0, _NAN, _NAN, _NAN, _NAN
    mean = float(np.mean(r))
    d = r - mean
    d2 = d * d
    return n, mean, float(np.mean(d2)), float(np.mean(d2 * d)), float(np.mean(d2 * d2))


def _degenerate(r, mean, m2):
    # (SciPy's: a variance below the mean's rounding, (eps |mean|)^2, is zero: the moments' ratios are nan there)
    return m2 <= (_EPS * mean) ** 2


# ------------------------------------------------------------------ skew, kurtosis

def skew(a, axis=0, bias=True, nan_policy="propagate", *, keepdims=False):
    """the sample skewness m3 / m2^(3/2) (bias=False: times sqrt(n (n-1))/(n-2), the adjusted Fisher-Pearson
    coefficient), as SciPy's"""
    if keepdims:
        raise NotImplementedError("scipy.stats.skew: keepdims=True is not supported in Sagebrush")
    arr, shape = _array(a, axis)
    out = []
    for r in _rows(arr, shape, nan_policy):
        n, mean, m2, m3, _ = _moments(r)
        if n == 0 or _degenerate(r, mean, m2):
            out.append(_NAN)
            continue
        v = m3 / m2 ** 1.5
        if not bias and n > 2:
            # (SciPy's: corrected where it can be, n > 2; the biased value kept below)
            v = _math.sqrt((n - 1.0) * n) / (n - 2.0) * v
        out.append(v)
    return _out(out, shape)


def kurtosis(a, axis=0, fisher=True, bias=True, nan_policy="propagate", *, keepdims=False):
    """the sample kurtosis m4 / m2^2 (fisher: minus 3; bias=False: the unbiased estimator of the excess kurtosis,
    plus 3 for Pearson's), as SciPy's"""
    if keepdims:
        raise NotImplementedError("scipy.stats.kurtosis: keepdims=True is not supported in Sagebrush")
    arr, shape = _array(a, axis)
    out = []
    for r in _rows(arr, shape, nan_policy):
        n, mean, m2, _, m4 = _moments(r)
        if n == 0 or _degenerate(r, mean, m2):
            out.append(_NAN)
            continue
        v = m4 / (m2 * m2)
        if not bias and n > 3:
            # (SciPy's: corrected where it can be, n > 3; the biased value kept below)
            v = 1.0 / (n - 2) / (n - 3) * ((n * n - 1.0) * m4 / (m2 * m2) - 3 * (n - 1) ** 2.0) + 3.0
        out.append(v - 3 if fisher else v)
    return _out(out, shape)


# ------------------------------------------------------------------ ranks and correlations

def rankdata(a, method="average", *, axis=None, nan_policy="propagate"):
    """the ranks of a (from 1), ties by method ('average', 'min', 'max', 'dense' or 'ordinal'), as float64 as
    SciPy's; a nan propagates to every rank of its slice"""
    if method not in ("average", "min", "max", "dense", "ordinal"):
        raise ValueError('unknown method "%s"' % method)
    _check_nan_policy(nan_policy)
    arr = np.asarray(a)
    if axis is None:
        arr = arr.reshape(-1)
        res = _rank1(arr.astype(float), method, nan_policy)
        return np.asarray(res, dtype=float)
    # (an axis beyond the array's: SciPy's IndexError, not wrapped)
    if not -max(arr.ndim, 1) <= axis < max(arr.ndim, 1):
        raise IndexError("list index out of range")
    moved = np.moveaxis(np.asarray(arr, dtype=float), axis % max(arr.ndim, 1), -1)
    # (the rows' count given, not inferred, so that an empty axis or array ranks to an empty array of its shape)
    flat = moved.reshape(int(np.prod(moved.shape[:-1])), moved.shape[-1])
    out = np.array([_rank1(r, method, nan_policy) for r in flat], dtype=float).reshape(moved.shape)
    return np.moveaxis(out, -1, axis % max(arr.ndim, 1))


def _rank1(r, method, nan_policy):
    n = r.size
    if np.any(r != r):
        if nan_policy == "raise":
            raise ValueError("The input contains nan values")
        if nan_policy == "propagate":
            return [_NAN] * n
        # (omit: the nans keep nan, the others are ranked among themselves)
        keep = r == r
        sub = _rank1(r[keep], method, "propagate")
        out = [_NAN] * n
        it = iter(sub)
        for i in range(n):
            if keep[i]:
                out[i] = next(it)
        return out
    order = sorted(range(n), key=lambda i: (r[i], i))
    ranks = [0.0] * n
    if method == "ordinal":
        for pos, i in enumerate(order):
            ranks[i] = pos + 1.0
        return ranks
    pos = 0
    dense = 0
    while pos < n:
        end = pos
        while end + 1 < n and r[order[end + 1]] == r[order[pos]]:
            end += 1
        dense += 1
        val = {"average": (pos + end + 2) / 2.0, "min": pos + 1.0, "max": end + 1.0, "dense": float(dense)}[method]
        for j in range(pos, end + 1):
            ranks[order[j]] = val
        pos = end + 1
    return ranks


def _alt_p(st_dist, stat, alternative, *args):
    """a test statistic's p-value under st_dist for the alternative, each tail directly"""
    if alternative == "two-sided":
        return 2 * st_dist.sf(abs(stat), *args)
    if alternative == "greater":
        return st_dist.sf(stat, *args)
    if alternative == "less":
        return st_dist.cdf(stat, *args)
    raise ValueError("alternative must be 'less', 'greater' or 'two-sided'")


def pearsonr(x, y, *, alternative="two-sided", method=None, axis=0):
    """Pearson's r and its p-value under a bivariate normal's independence, SciPy's: r from the inputs
    normalized about their means; the p-value from r's exact distribution, a beta on [-1, 1] with
    a = b = n/2 - 1: 2 I_((1-|r|)/2)(a, a) for two-sided"""
    if method is not None:
        raise NotImplementedError("scipy.stats.pearsonr: method= is not supported in Sagebrush")
    if axis not in (0, -1):
        raise NotImplementedError("scipy.stats.pearsonr: axis=%r is not supported in Sagebrush" % (axis,))
    x = np.asarray(x, dtype=float).reshape(-1)
    y = np.asarray(y, dtype=float).reshape(-1)
    if x.size != y.size:
        raise ValueError("`x` and `y` must be broadcastable.")
    n = x.size
    if n < 2:
        raise ValueError("`x` and `y` must have length at least 2.")
    xm = x - np.mean(x)
    ym = y - np.mean(y)
    # (each norm as SciPy forms it, scaled by the largest |deviation| first, so that squaring neither overflows nor
    # underflows at any scale: max|xm| * sqrt(dot(xm/max, xm/max)))
    with np.errstate(invalid="ignore", divide="ignore", over="ignore"):
        xmax, ymax = float(np.max(np.abs(xm))), float(np.max(np.abs(ym)))
        if xmax == 0 or ymax == 0 or bool(np.all(x == x[0])) or bool(np.all(y == y[0])):
            r = _NAN
        else:
            ux, uy = xm / xmax, ym / ymax
            nx, ny = xmax * float(np.sqrt(np.dot(ux, ux))), ymax * float(np.sqrt(np.dot(uy, uy)))
            r = float(np.dot(xm / nx, ym / ny))
            r = max(min(r, 1.0), -1.0) if r == r else r
    if r != r:
        return PearsonRResult(np.float64(_NAN), np.float64(_NAN), n, alternative)
    ab = n / 2.0 - 1
    if n == 2:
        # (two samples: r is exactly 1 or -1, and the p-value 1 for every alternative, as SciPy's)
        r = float(round(r))
        p = 1.0
    elif alternative == "two-sided":
        p = 2 * float(_sc.betainc(ab, ab, (1 - abs(r)) / 2)) if abs(r) < 1 else 0.0
    elif alternative == "greater":
        p = float(_sc.betainc(ab, ab, (1 - r) / 2))
    elif alternative == "less":
        p = float(_sc.betainc(ab, ab, (1 + r) / 2))
    else:
        raise ValueError("alternative must be 'less', 'greater' or 'two-sided'")
    return PearsonRResult(np.float64(r), np.float64(min(p, 1.0)), n, alternative)


def spearmanr(a, b=None, axis=0, nan_policy="propagate", alternative="two-sided"):
    """Spearman's rho, Pearson's r of the ranks (rankdata 'average'), and its p-value from t = rho sqrt((n-2)/(1-rho^2))
    on n - 2 degrees of freedom, as SciPy's for two 1-d samples"""
    import scipy.stats as st
    if axis is None:
        # (axis=None: both samples flattened into one pair of variables, as SciPy's; one sample alone is one variable)
        if b is None:
            raise ValueError("`spearmanr` needs at least 2 variables to compare")
    else:
        if b is None:
            raise NotImplementedError("scipy.stats.spearmanr: a 2-d array of variables is not supported in Sagebrush (give two samples)")
        # (two n-d samples: SciPy's matrix of the variables' correlations, which Sagebrush doesn't compute: refused,
        # never the two flattened into one correlation)
        if np.ndim(a) > 1 or np.ndim(b) > 1:
            raise NotImplementedError("scipy.stats.spearmanr: 2-d samples (a matrix of the variables' correlations) are not supported in Sagebrush (give two 1-d samples)")
    _check_nan_policy(nan_policy)
    x = np.asarray(a, dtype=float).reshape(-1)
    y = np.asarray(b, dtype=float).reshape(-1)
    if x.size != y.size:
        raise ValueError("all the input array dimensions except for the concatenation axis must match exactly, but along "
                         "dimension 0, the array at index 0 has size %d and the array at index 1 has size %d" % (x.size, y.size))
    if x.size <= 1:
        # (an empty pair or a single observation: SciPy's (nan, nan), before it looks at NaNs, under every policy)
        return SignificanceResult(_NAN, _NAN)
    bad = (x != x) | (y != y)
    if np.any(bad):
        if nan_policy == "raise":
            raise ValueError("The input contains nan values")
        if nan_policy == "omit" and axis is None:
            # (SciPy 1.18's own failure here, for any samples: its omit path indexes a shape axis=None has flattened)
            raise IndexError("tuple index out of range")
        if nan_policy == "propagate":
            # (SciPy's: two Python floats here)
            return SignificanceResult(_NAN, _NAN)
        x, y = x[~bad], y[~bad]
    n = x.size
    rx, ry = rankdata(x), rankdata(y)
    # (rho as SciPy's spearmanr forms it, np.corrcoef of the ranks, not as its pearsonr: the two differ in the last
    # bits; a constant sample's rho nan)
    if n > 1 and not (bool(np.all(rx == rx[0])) or bool(np.all(ry == ry[0]))):
        with np.errstate(invalid="ignore", divide="ignore"):
            rho = max(min(float(np.corrcoef(rx, ry)[0, 1]), 1.0), -1.0)
    else:
        rho = _NAN
    if rho != rho:
        return SignificanceResult(np.float64(_NAN), np.float64(_NAN))
    dof = n - 2
    with np.errstate(divide="ignore", invalid="ignore"):
        t = rho * _math.sqrt(dof / ((rho + 1.0) * (1.0 - rho))) if abs(rho) < 1 else _math.copysign(_math.inf, rho)
    p = float(_alt_p(st.t, t, alternative, dof)) if dof > 0 else _NAN
    return SignificanceResult(np.float64(rho), np.float64(p))


# ------------------------------------------------------------------ tests

def ttest_ind(a, b, axis=0, equal_var=True, nan_policy="propagate", permutations=None, random_state=None,
              alternative="two-sided", trim=0, method=None, *, keepdims=False):
    """the t-test of two independent samples' means: pooled variance (equal_var) or Welch's, as SciPy's; the p-value
    from t on its degrees of freedom; along axis, one test a slice (axis=None: the samples flattened)"""
    if permutations is not None or trim or method is not None or keepdims:
        raise NotImplementedError("scipy.stats.ttest_ind: permutations, trim, method and keepdims are not supported in Sagebrush")
    _check_nan_policy(nan_policy)
    # (the axis checked first, against the samples' larger dimension, a scalar's counted as 1, as SciPy's)
    if axis is not None:
        nd = max(np.ndim(a), np.ndim(b), 1)
        if not -nd <= axis < nd:
            raise AxisError("`axis` is out of bounds for array of dimension %d" % nd)
    if axis is None or (np.ndim(a) <= 1 and np.ndim(b) <= 1):
        return _ttest_ind_1d(np.asarray(a, dtype=float).reshape(-1), np.asarray(b, dtype=float).reshape(-1),
                             equal_var, nan_policy, alternative)
    # (n-d samples: one test a slice along axis, as SciPy's: the samples left-padded with dimensions of length 1 to
    # the same rank first, then the axis taken, then the other dimensions broadcast against each other)
    pa, pb = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    pa = pa.reshape((1,) * (nd - pa.ndim) + pa.shape)
    pb = pb.reshape((1,) * (nd - pb.ndim) + pb.shape)
    xa, shape_a = _array(pa, axis)
    xb, shape_b = _array(pb, axis)
    try:
        shape = tuple(np.broadcast_shapes(shape_a, shape_b))
    except ValueError:
        raise ValueError("Array shapes are incompatible for broadcasting.") from None
    xa = np.broadcast_to(xa, shape + (xa.shape[-1],))
    xb = np.broadcast_to(xb, shape + (xb.shape[-1],))
    ra = xa.reshape(int(np.prod(shape)), xa.shape[-1])
    rb = xb.reshape(int(np.prod(shape)), xb.shape[-1])
    res = [_ttest_ind_1d(x, y, equal_var, nan_policy, alternative) for x, y in zip(ra, rb)]
    def field(get):
        return np.array([float(get(r_)) for r_ in res], dtype=float).reshape(shape)
    return TtestResult(field(lambda r_: r_[0]), field(lambda r_: r_[1]), field(lambda r_: r_._df),
                       field(lambda r_: r_._estimate), field(lambda r_: r_._se), alternative)


def _ttest_ind_1d(x, y, equal_var, nan_policy, alternative):
    import scipy.stats as st
    for v in (x, y):
        if np.any(v != v) and nan_policy == "raise":
            raise ValueError("The input contains nan values")
    if nan_policy == "omit":
        x, y = x[x == x], y[y == y]
    n1, n2 = x.size, y.size
    nan = np.float64(_NAN)
    # (an empty sample, or a NaN under nan_policy 'propagate': every result undefined, as SciPy's)
    if n1 == 0 or n2 == 0 or (nan_policy == "propagate" and (bool(np.any(x != x)) or bool(np.any(y != y)))):
        if alternative not in ("two-sided", "less", "greater"):
            raise ValueError("alternative must be 'less', 'greater' or 'two-sided'")
        return TtestResult(nan, nan, nan, nan, nan, alternative)
    m1, m2 = np.float64(np.mean(x)), np.float64(np.mean(y))
    # (SciPy's: the second moment times n/(n-1), NaN for one sample; the arithmetic below IEEE's, in float64)
    v1 = np.float64(np.var(x, ddof=1)) if n1 > 1 else nan
    v2 = np.float64(np.var(y, ddof=1)) if n2 > 1 else nan
    f1, f2 = np.float64(n1), np.float64(n2)
    with np.errstate(divide="ignore", invalid="ignore"):
        if equal_var:
            # (a sample of one adds no squared deviations: its (n - 1) v is 0, so the pooled variance is defined)
            if n1 == 1:
                v1 = np.float64(0.0)
            if n2 == 1:
                v2 = np.float64(0.0)
            df = f1 + f2 - 2.0
            svar = ((f1 - 1) * v1 + (f2 - 1) * v2) / df
            se = np.sqrt(svar * (1.0 / f1 + 1.0 / f2))
        else:
            vn1, vn2 = v1 / f1, v2 / f2
            df = (vn1 + vn2) ** 2 / (vn1 ** 2 / (f1 - 1) + vn2 ** 2 / (f2 - 1))
            # (an undefined df: both variances zero, where df doesn't matter; SciPy's 1)
            if df != df:
                df = np.float64(1.0)
            se = np.sqrt(vn1 + vn2)
        d = m1 - m2
        t = d / se
    p = np.float64(_alt_p(st.t, float(t), alternative, float(df))) if t == t else nan
    return TtestResult(np.float64(t), p, np.float64(df), np.float64(d), np.float64(se), alternative)


def levene(*samples, center="median", proportiontocut=0.05, axis=0, nan_policy="propagate", keepdims=False):
    """Levene's test for equal variances (center 'median': Brown and Forsythe's, 'mean': Levene's, 'trimmed'), as
    SciPy's: W = (N - k)/(k - 1) sum n_i (Z_i. - Z..)^2 / sum sum (Z_ij - Z_i.)^2, Z_ij = |Y_ij - center_i|; the
    p-value F's upper tail on (k - 1, N - k); along axis, one test a slice (axis=None: the samples flattened)"""
    if center not in ("mean", "median", "trimmed"):
        raise ValueError("center must be 'mean', 'median' or 'trimmed'.")
    if len(samples) < 2:
        raise ValueError("Must provide at least two samples.")
    _check_nan_policy(nan_policy)
    if axis is not None:
        nd = max(max(np.ndim(x) for x in samples), 1)
        if not -nd <= axis < nd:
            raise AxisError("`axis` is out of bounds for array of dimension %d" % nd)
    if axis is None or all(np.ndim(x) <= 1 for x in samples):
        W, p = _levene_1d([np.asarray(x, dtype=float).reshape(-1) for x in samples], center, proportiontocut, nan_policy)
        if keepdims:
            # (keepdims: the reduced axis, or every axis for axis=None, kept with length 1)
            nd = max(max(np.ndim(x) for x in samples), 1)
            return LeveneResult(np.full((1,) * nd, float(W)), np.full((1,) * nd, float(p)))
        return LeveneResult(W, p)
    # (n-d samples: one test a slice along axis, as SciPy's: left-padded to one rank, the axis taken, the other
    # dimensions broadcast against each other)
    moved, shapes = [], []
    for x in samples:
        px = np.asarray(x, dtype=float)
        px = px.reshape((1,) * (nd - px.ndim) + px.shape)
        mx, sh = _array(px, axis)
        moved.append(mx)
        shapes.append(sh)
    try:
        shape = tuple(np.broadcast_shapes(*shapes))
    except ValueError:
        raise ValueError("Array shapes are incompatible for broadcasting.") from None
    flat = [np.broadcast_to(m, shape + (m.shape[-1],)).reshape(int(np.prod(shape)), m.shape[-1]) for m in moved]
    res = [_levene_1d([f[i] for f in flat], center, proportiontocut, nan_policy) for i in range(int(np.prod(shape)))]
    W = np.array([float(r[0]) for r in res], dtype=float).reshape(shape)
    p = np.array([float(r[1]) for r in res], dtype=float).reshape(shape)
    if keepdims:
        W, p = np.expand_dims(W, axis % nd), np.expand_dims(p, axis % nd)
    return LeveneResult(W, p)


def _levene_1d(xs, center, proportiontocut, nan_policy):
    import scipy.stats as st
    k = len(xs)
    if any(np.any(x != x) for x in xs):
        if nan_policy == "raise":
            raise ValueError("The input contains nan values")
        if nan_policy == "propagate":
            return LeveneResult(np.float64(_NAN), np.float64(_NAN))
        xs = [x[x == x] for x in xs]
    # (a sample with no observations, given empty or emptied by nan_policy='omit': no statistic, as SciPy's)
    if any(x.size == 0 for x in xs):
        return LeveneResult(np.float64(_NAN), np.float64(_NAN))
    if center == "median":
        cen = [float(np.median(x)) for x in xs]
    elif center == "mean":
        cen = [float(np.mean(x)) for x in xs]
    else:
        cen = [float(np.mean(_trimboth(np.sort(x), proportiontocut))) for x in xs]
    ni = [x.size for x in xs]
    N = float(sum(ni))
    Z = [np.abs(x - c) for x, c in zip(xs, cen)]
    Zbari = [float(np.mean(z)) for z in Z]
    Zbar = sum(Zbari[i] * ni[i] for i in range(k)) / N
    numer = (N - k) * sum(ni[i] * (Zbari[i] - Zbar) ** 2 for i in range(k))
    dvar = sum(float(np.sum((Z[i] - Zbari[i]) ** 2)) for i in range(k))
    denom = (k - 1.0) * dvar
    with np.errstate(divide="ignore", invalid="ignore"):
        W = numer / denom if denom != 0 else (_NAN if numer == 0 else _math.inf)
    p = float(st.f.sf(W, k - 1.0, N - k)) if W == W else _NAN
    return LeveneResult(np.float64(W), np.float64(p))


def _trimboth(sorted_x, proportiontocut):
    n = sorted_x.size
    lo = int(proportiontocut * n)
    hi = n - lo
    if lo >= hi:
        raise ValueError("Proportion too big.")
    return sorted_x[lo:hi]


def jarque_bera(x, *, axis=None, nan_policy="propagate", keepdims=False):
    """the Jarque-Bera statistic n/6 (S^2 + K^2/4) (the biased skewness and excess kurtosis) and its p-value,
    chi-squared's upper tail on 2 degrees of freedom, as SciPy's"""
    import scipy.stats as st
    if keepdims:
        raise NotImplementedError("scipy.stats.jarque_bera: keepdims=True is not supported in Sagebrush")
    arr = np.asarray(x, dtype=float)
    arr = arr.reshape(-1) if axis is None else arr
    if axis is not None and arr.ndim > 1:
        raise NotImplementedError("scipy.stats.jarque_bera: an axis of a 2-d array is not supported in Sagebrush")
    r = _rows(arr.reshape(-1), (), nan_policy)[0]
    if r.size == 0:
        raise ValueError("At least one observation is required.")
    n, mean, m2, m3, m4 = _moments(r)
    s = m3 / m2 ** 1.5 if m2 > 0 else _NAN
    kk = m4 / (m2 * m2) - 3 if m2 > 0 else _NAN
    jb = n / 6.0 * (s * s + kk * kk / 4.0)
    return SignificanceResult(np.float64(jb), np.float64(st.chi2.sf(jb, 2)))


def describe(a, axis=0, ddof=1, bias=True, nan_policy="propagate"):
    """(nobs, (min, max), mean, variance (ddof), skewness, kurtosis (Fisher's)), as SciPy's"""
    _check_nan_policy(nan_policy)
    x = np.asarray(a, dtype=float)
    nan = bool(np.any(x != x))
    if nan and nan_policy == "raise":
        raise ValueError("The input contains nan values")
    nd = max(x.ndim, 1)
    if axis is not None and not -nd <= axis < nd:
        # (SciPy's errors for an axis out of range: NumPy's AxisError on its masked path, else NumPy's IndexError
        # indexing the shape)
        if nan and nan_policy == "omit":
            raise AxisError("axis %d is out of bounds for array of dimension %d" % (axis, nd))
        raise IndexError("index %d is out of bounds for axis 0 with size %d" % (axis, nd))
    arr, shape = _array(x, axis)
    if nan and nan_policy == "omit":
        return _describe_masked(arr, shape, ddof, bias)
    rows = _rows(arr, shape, nan_policy)
    if any(r.size == 0 for r in rows):
        raise ValueError("The input must not be empty.")
    n = np.int64(rows[0].size)
    mins = _out([float(np.min(r)) for r in rows], shape)
    maxs = _out([float(np.max(r)) for r in rows], shape)
    means = _out([float(np.mean(r)) for r in rows], shape)
    vars_ = _out([float(np.var(r, ddof=ddof)) for r in rows], shape)
    sk = skew(arr.reshape(-1) if axis is None else np.moveaxis(arr, -1, 0), axis=0, bias=bias, nan_policy=nan_policy)
    ku = kurtosis(arr.reshape(-1) if axis is None else np.moveaxis(arr, -1, 0), axis=0, bias=bias, nan_policy=nan_policy)
    return DescribeResult(n, (mins, maxs), means, vars_, sk, ku)


def _describe_masked(arr, shape, ddof, bias):
    """describe of a sample with NaNs under nan_policy='omit', as SciPy's: scipy.stats.mstats.describe of the
    NaNs masked. Each slice has its own count. A constant slice (m2 at most (1e-15 mean)^2, NumPy's resolution)
    has skewness 0 and kurtosis -3, corrected (bias=False) only where it isn't constant and n > 2 (skewness) or
    n > 3 (kurtosis). What SciPy masks (a slice with no values; a variance of count <= ddof) is nan here: Sagebrush
    has no masked arrays."""
    nobs, mins, maxs, means, vars_, sks, kus = [], [], [], [], [], [], []
    for r in _rows(arr, shape, "omit"):
        n = r.size
        nobs.append(n)
        if n == 0:
            for out in (mins, maxs, means, vars_, sks, kus):
                out.append(_NAN)
            continue
        mins.append(float(np.min(r)))
        maxs.append(float(np.max(r)))
        _, mean, m2, m3, m4 = _moments(r)
        means.append(mean)
        vars_.append(float(np.var(r, ddof=ddof)) if n - ddof > 0 else _NAN)
        if m2 <= (1e-15 * mean) ** 2:
            sks.append(0.0)
            kus.append(-3.0)
            continue
        sk = m3 / m2 ** 1.5
        ku = m4 / m2 ** 2.0
        if not bias and n > 2:
            sk = _math.sqrt((n - 1.0) * n) / (n - 2.0) * m3 / m2 ** 1.5
        if not bias and n > 3:
            ku = 1.0 / (n - 2) / (n - 3) * ((n * n - 1.0) * m4 / m2 ** 2.0 - 3 * (n - 1) ** 2.0) + 3.0
        sks.append(sk)
        kus.append(ku - 3)
    n_out = np.array(nobs, dtype=np.int64).reshape(shape)
    return DescribeResult(n_out[()] if n_out.ndim == 0 else n_out, (_out(mins, shape), _out(maxs, shape)),
                          _out(means, shape), _out(vars_, shape), _out(sks, shape), _out(kus, shape))


def zscore(a, axis=0, ddof=0, nan_policy="propagate"):
    """(a - mean) / std (ddof), along axis, as SciPy's"""
    _check_nan_policy(nan_policy)
    arr = np.asarray(a, dtype=float)
    if np.any(arr != arr) and nan_policy == "raise":
        raise ValueError("The input contains nan values")
    if nan_policy == "omit":
        mn = np.nanmean(arr, axis=axis, keepdims=True)
        sd = np.nanstd(arr, axis=axis, ddof=ddof, keepdims=True)
    else:
        mn = np.mean(arr, axis=axis, keepdims=True)
        sd = np.std(arr, axis=axis, ddof=ddof, keepdims=True)
    with np.errstate(divide="ignore", invalid="ignore"):
        return (arr - mn) / sd


# ------------------------------------------------------------------ bootstrap

class BootstrapResult:
    """SciPy's BootstrapResult: confidence_interval (low, high), bootstrap_distribution (the statistic of each
    resample, along the last axis) and standard_error (that distribution's standard deviation, ddof 1)"""

    def __init__(self, confidence_interval, bootstrap_distribution, standard_error):
        self.confidence_interval = confidence_interval
        self.bootstrap_distribution = bootstrap_distribution
        self.standard_error = standard_error

    def __repr__(self):
        return "BootstrapResult(confidence_interval=%r, bootstrap_distribution=%r, standard_error=%r)" % (
            self.confidence_interval, self.bootstrap_distribution, self.standard_error)


class AxisError(ValueError, IndexError):
    """NumPy's numpy.exceptions.AxisError, which SciPy raises for an axis a sample lacks (a ValueError and an
    IndexError, as NumPy's; Sagebrush's numpy has no numpy.exceptions yet)"""


class DegenerateDataWarning(RuntimeWarning):
    """SciPy's warning for data a method can't use (scipy.stats.DegenerateDataWarning)"""


def _vectorized(statistic):
    """an n-sample statistic made to take axis=: applied to each 1-d slice along the axis, as SciPy's
    _vectorize_statistic (the samples concatenated, split again for each call)"""
    def stat_nd(*data, axis=0):
        lengths = [s.shape[axis] for s in data]
        cuts = np.cumsum(lengths)[:-1].tolist()
        z = np.concatenate([np.moveaxis(s, axis, -1) for s in data], axis=-1)
        flat = z.reshape(-1, z.shape[-1])
        out = []
        for row in flat:
            parts = [row[a:b] for a, b in zip([0] + cuts, cuts + [row.shape[0]])]
            out.append(statistic(*parts))
        res = np.array(out, dtype=float).reshape(z.shape[:-1])
        return res[()] if res.ndim == 0 else res
    return stat_nd


def _quantile7(sorted_rows, p):
    """SciPy's stats.quantile, method "linear" (Hyndman and Fan's 7), of rows sorted ascending, at p: the
    position j + g = p n + 1 - p, between the j-th and the next (1-based), as SciPy computes it"""
    n = sorted_rows.shape[-1]
    jg = p * n + (1 - p)
    jp1 = _math.floor(jg)
    j = jp1 - 1
    g = jg % 1
    if j < 0:
        g = 0.0
    j = min(max(j, 0), n - 1)
    jp1 = min(max(jp1, 0), n - 1)
    return (1 - g) * sorted_rows[..., j] + g * sorted_rows[..., jp1]


def bootstrap(data, statistic, *, n_resamples=9999, batch=None, vectorized=None, paired=False, axis=0,
              confidence_level=0.95, alternative="two-sided", method="BCa", bootstrap_result=None, rng=None,
              random_state=None):
    """A two-sided (or one-sided) bootstrap confidence interval of a statistic of one or more samples, as SciPy
    1.18's bootstrap: n_resamples resamples drawn as SciPy draws them (rng: a Generator or a seed for
    default_rng; random_state: SciPy's older argument, a seed for a RandomState), so a seed gives SciPy's
    resamples; the percentile, basic or BCa (bias-corrected and accelerated, by the jackknife) interval."""
    import inspect
    import warnings
    if random_state is not None and rng is not None:
        raise TypeError("bootstrap() got an unexpected keyword argument 'random_state'")
    if vectorized not in (True, False, None):
        raise ValueError("`vectorized` must be `True`, `False`, or `None`.")
    if vectorized is None:
        try:
            vectorized = "axis" in inspect.signature(statistic).parameters
        except (TypeError, ValueError):
            vectorized = False
    if not vectorized:
        statistic = _vectorized(statistic)
    axis_int = int(axis)
    if axis != axis_int:
        raise ValueError("`axis` must be an integer.")
    try:
        n_samples = len(data)
    except TypeError:
        raise ValueError("`data` must be a sequence of samples.") from None
    if n_samples == 0:
        raise ValueError("`data` must contain at least one sample.")
    samples = [np.asarray(s) for s in data]
    for s in samples:
        if not -s.ndim <= axis_int < s.ndim:
            # (SciPy's: NumPy's AxisError, from a sample without that axis, a number among them, as when an
            #  array is passed where a tuple of samples belongs)
            raise AxisError("`axis` is out of bounds for array of dimension %d" % s.ndim)
    if any(s.dtype.kind not in "biuf" for s in samples):
        samples = [np.asarray(s, dtype=float) for s in samples]
    # (broadcast all but the axis, as SciPy's _broadcast_arrays with axis)
    nd = max(s.ndim for s in samples)
    samples = [s.reshape((1,) * (nd - s.ndim) + s.shape) for s in samples]
    ax = axis_int % nd if nd else 0
    other = [tuple(d for i, d in enumerate(s.shape) if i != ax) for s in samples]
    common = np.broadcast_shapes(*other)
    out = []
    for s in samples:
        moved = np.moveaxis(s, ax, -1)
        out.append(np.broadcast_to(moved, common + (moved.shape[-1],)))
    data_iv = []
    for s in out:
        if s.shape[-1] <= 1:
            raise ValueError("each sample in `data` must contain two or more observations along `axis`.")
        data_iv.append(np.array(s))
    if paired not in (True, False):
        raise ValueError("`paired` must be `True` or `False`.")
    if paired:
        n = data_iv[0].shape[-1]
        for s in data_iv[1:]:
            if s.shape[-1] != n:
                raise ValueError("When `paired is True`, all samples must have the same length along `axis`")
        unpaired, originals = statistic, data_iv

        def statistic(i, axis=-1):
            return unpaired(*[s[..., i] for s in originals], axis=axis)
        data_iv = [np.arange(n)]
    cl = float(confidence_level)
    alternative = alternative.lower()
    if alternative not in ("two-sided", "less", "greater"):
        # (SciPy's message prints a set, in an order that varies from run to run; here, its source's order)
        raise ValueError("`alternative` must be one of {'two-sided', 'less', 'greater'}")
    n_res = int(n_resamples)
    if n_resamples != n_res or n_res < 0:
        raise ValueError("`n_resamples` must be a non-negative integer.")
    if batch is not None:
        b = int(batch)
        if batch != b or b <= 0:
            raise ValueError("`batch` must be a positive integer or None.")
        batch = b
    method = method.lower()
    if method not in ("percentile", "basic", "bca"):
        raise ValueError("`method` must be in {'percentile', 'basic', 'bca'}")
    if bootstrap_result is not None and not hasattr(bootstrap_result, "bootstrap_distribution"):
        raise ValueError("`bootstrap_result` must have attribute `bootstrap_distribution'")
    if (bootstrap_result is None or not np.asarray(bootstrap_result.bootstrap_distribution).size) and n_res == 0:
        raise ValueError("Either `bootstrap_result.bootstrap_distribution.size` or `n_resamples` must be positive.")
    if rng is not None:
        g = rng if isinstance(rng, np.random.Generator) else np.random.default_rng(rng)
    else:
        from scipy.stats import _random_state
        g = _random_state(random_state)
    draw = g.integers if isinstance(g, np.random.Generator) else g.randint
    # the resamples, batch by batch, each sample's in turn (SciPy's order of draws)
    parts = [] if bootstrap_result is None else [np.asarray(bootstrap_result.bootstrap_distribution, dtype=float)]
    step = batch or n_res or 1
    for k in range(0, n_res, step):
        m = min(step, n_res - k)
        res = []
        for s in data_iv:
            n = s.shape[-1]
            i = draw(0, n, (m, n))
            res.append(s[..., i])
        parts.append(np.asarray(statistic(*res, axis=-1), dtype=float))
    theta_b = np.concatenate(parts, axis=-1)
    alpha = (1 - cl) / 2 if alternative == "two-sided" else (1 - cl)
    lead = theta_b.shape[:-1]
    if method == "bca":
        theta_hat = np.asarray(statistic(*data_iv, axis=-1), dtype=float)
        B = theta_b.shape[-1]
        th = theta_hat[..., None]
        pct = (np.count_nonzero(theta_b < th, axis=-1) + np.count_nonzero(theta_b <= th, axis=-1)) / (2 * B)
        z0 = _sc.ndtri(pct)
        nums, dens = 0.0, 0.0
        for j, s in enumerate(data_iv):
            n = s.shape[-1]
            jack = np.stack([np.delete(s, i, axis=-1) for i in range(n)], axis=-2)
            others = [x[..., None, :] for x in data_iv]
            others[j] = jack
            shapes = [x.shape[:-1] for x in others]
            full = np.broadcast_shapes(*shapes)
            args = [np.broadcast_to(x, full + (x.shape[-1],)) for x in others]
            theta_i = np.asarray(statistic(*args, axis=-1), dtype=float)
            nj = float(theta_i.shape[-1])
            dot = np.mean(theta_i, axis=-1, keepdims=True)
            U = (nj - 1) * (dot - theta_i)
            nums = nums + np.sum(U ** 3, axis=-1) / nj ** 3
            dens = dens + np.sum(U ** 2, axis=-1) / nj ** 2
        a_hat = 1 / 6 * nums / dens ** (3 / 2)
        z_alpha = float(_sc.ndtri(alpha))
        num1 = z0 + z_alpha
        lo_p = _sc.ndtr(z0 + num1 / (1 - a_hat * num1))
        num2 = z0 - z_alpha
        hi_p = _sc.ndtr(z0 + num2 / (1 - a_hat * num2))
    else:
        lo_p = np.full(lead, alpha)
        hi_p = np.full(lead, 1 - alpha)
    lo_p, hi_p = np.broadcast_to(np.asarray(lo_p, dtype=float), lead), np.broadcast_to(np.asarray(hi_p, dtype=float), lead)
    srt = np.sort(theta_b, axis=-1)
    flat, fl, fh = srt.reshape(-1, srt.shape[-1]), lo_p.reshape(-1).tolist(), hi_p.reshape(-1).tolist()
    nan = float("nan")

    def q(row, p):
        if p != p or not 0 <= p <= 1 or np.isnan(row).any():
            return nan
        return float(_quantile7(row, p))
    ci_l = np.array([q(r, p) for r, p in zip(flat, fl)], dtype=float).reshape(lead)
    ci_u = np.array([q(r, p) for r, p in zip(flat, fh)], dtype=float).reshape(lead)
    if np.isnan(ci_l).any() or np.isnan(ci_u).any():
        warnings.warn(DegenerateDataWarning("The BCa confidence interval cannot be calculated. This problem is known "
                                            "to occur when the distribution is degenerate or the statistic is np.min."),
                      stacklevel=2)
    if method == "basic":
        theta_hat = np.asarray(statistic(*data_iv, axis=-1), dtype=float)
        ci_l, ci_u = 2 * theta_hat - ci_u, 2 * theta_hat - ci_l
    if alternative == "less":
        ci_l = np.full_like(ci_l, -np.inf)
    elif alternative == "greater":
        ci_u = np.full_like(ci_u, np.inf)
    se = np.std(theta_b, ddof=1, axis=-1)

    def one(v):
        # (a 0-d result as a NumPy scalar, as SciPy's)
        return np.float64(float(np.asarray(v))) if np.ndim(v) == 0 else v
    return BootstrapResult(ConfidenceInterval(one(ci_l), one(ci_u)), theta_b, one(se))
