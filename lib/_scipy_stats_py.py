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
        if n < 4:
            return ConfidenceInterval(np.float64(_NAN), np.float64(_NAN))
        z = _math.atanh(r) if abs(r) < 1 else _math.copysign(_math.inf, r)
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
        import scipy.stats as st
        est, se, df = self._estimate, self._se, self._df
        if self._alternative == "two-sided":
            h = st.t.ppf(0.5 + confidence_level / 2, df)
            lo, hi = est - h * se, est + h * se
        elif self._alternative == "less":
            lo, hi = np.float64(-_math.inf), est + st.t.ppf(confidence_level, df) * se
        else:
            lo, hi = est - st.t.ppf(confidence_level, df) * se, np.float64(_math.inf)
        return ConfidenceInterval(np.float64(lo), np.float64(hi))


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
    ax = axis % a.ndim
    a = np.moveaxis(a, ax, -1)
    return a, a.shape[:-1]


def _check_nan_policy(nan_policy):
    if nan_policy not in ("propagate", "omit", "raise"):
        raise ValueError("nan_policy must be one of {'omit', 'raise', 'propagate'}.")


def _rows(a, shape, nan_policy):
    """each 1-d slice along the (last) axis, its nans dropped for nan_policy='omit' (a ValueError for 'raise')"""
    _check_nan_policy(nan_policy)
    flat = a.reshape(-1, a.shape[-1]) if a.ndim > 1 else a.reshape(1, -1)
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
    moved = np.moveaxis(np.asarray(arr, dtype=float), axis % max(arr.ndim, 1), -1)
    flat = moved.reshape(-1, moved.shape[-1])
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
    nx, ny = float(np.sqrt(np.sum(xm * xm))), float(np.sqrt(np.sum(ym * ym)))
    with np.errstate(invalid="ignore", divide="ignore"):
        if nx == 0 or ny == 0 or not (nx == nx and ny == ny):
            r = _NAN
        else:
            r = float(np.dot(xm / nx, ym / ny))
            r = max(min(r, 1.0), -1.0)
    if r != r:
        return PearsonRResult(np.float64(_NAN), np.float64(_NAN), n, alternative)
    ab = n / 2.0 - 1
    if n == 2:
        p = 1.0 if alternative == "two-sided" else 0.5
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
    if b is None:
        raise NotImplementedError("scipy.stats.spearmanr: a 2-d array of variables is not supported in Sagebrush (give two samples)")
    _check_nan_policy(nan_policy)
    x = np.asarray(a, dtype=float).reshape(-1)
    y = np.asarray(b, dtype=float).reshape(-1)
    if x.size != y.size:
        raise ValueError("all the input array dimensions except for the concatenation axis must match exactly")
    bad = (x != x) | (y != y)
    if np.any(bad):
        if nan_policy == "raise":
            raise ValueError("The input contains nan values")
        if nan_policy == "propagate":
            # (SciPy's: two Python floats here)
            return SignificanceResult(_NAN, _NAN)
        x, y = x[~bad], y[~bad]
    n = x.size
    rx, ry = rankdata(x), rankdata(y)
    rho = float(pearsonr(rx, ry)[0]) if n > 1 else _NAN
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
    """the t-test of two independent samples' means: pooled variance (equal_var) or Welch's, as SciPy's for 1-d
    samples; the p-value from t on its degrees of freedom"""
    import scipy.stats as st
    if permutations is not None or trim or method is not None or keepdims:
        raise NotImplementedError("scipy.stats.ttest_ind: permutations, trim, method and keepdims are not supported in Sagebrush")
    if axis not in (0, -1, None):
        raise NotImplementedError("scipy.stats.ttest_ind: axis=%r is not supported in Sagebrush" % (axis,))
    _check_nan_policy(nan_policy)
    x = np.asarray(a, dtype=float).reshape(-1)
    y = np.asarray(b, dtype=float).reshape(-1)
    for v in (x, y):
        if np.any(v != v) and nan_policy == "raise":
            raise ValueError("The input contains nan values")
    if nan_policy == "omit":
        x, y = x[x == x], y[y == y]
    n1, n2 = x.size, y.size
    m1, m2 = float(np.mean(x)), float(np.mean(y))
    v1 = float(np.var(x, ddof=1)) if n1 > 1 else _NAN
    v2 = float(np.var(y, ddof=1)) if n2 > 1 else _NAN
    if equal_var:
        df = n1 + n2 - 2.0
        svar = ((n1 - 1) * v1 + (n2 - 1) * v2) / df
        se = _math.sqrt(svar * (1.0 / n1 + 1.0 / n2))
    else:
        vn1, vn2 = v1 / n1, v2 / n2
        with np.errstate(divide="ignore", invalid="ignore"):
            df = (vn1 + vn2) ** 2 / (vn1 * vn1 / (n1 - 1) + vn2 * vn2 / (n2 - 1))
        se = _math.sqrt(vn1 + vn2)
    d = m1 - m2
    with np.errstate(divide="ignore", invalid="ignore"):
        t = d / se if se > 0 else (_NAN if d == 0 else _math.copysign(_math.inf, d))
    p = float(_alt_p(st.t, t, alternative, df)) if t == t else _NAN
    return TtestResult(np.float64(t), np.float64(p), np.float64(df), np.float64(d), np.float64(se), alternative)


def levene(*samples, center="median", proportiontocut=0.05, axis=0, nan_policy="propagate", keepdims=False):
    """Levene's test for equal variances (center 'median': Brown and Forsythe's, 'mean': Levene's, 'trimmed'), as
    SciPy's: W = (N - k)/(k - 1) sum n_i (Z_i. - Z..)^2 / sum sum (Z_ij - Z_i.)^2, Z_ij = |Y_ij - center_i|; the
    p-value F's upper tail on (k - 1, N - k)"""
    import scipy.stats as st
    if center not in ("mean", "median", "trimmed"):
        raise ValueError("center must be 'mean', 'median' or 'trimmed'.")
    if keepdims or axis not in (0, -1):
        raise NotImplementedError("scipy.stats.levene: axis and keepdims are not supported in Sagebrush")
    k = len(samples)
    if k < 2:
        raise ValueError("Must provide at least two samples.")
    xs = [np.asarray(s, dtype=float).reshape(-1) for s in samples]
    _check_nan_policy(nan_policy)
    if any(np.any(x != x) for x in xs):
        if nan_policy == "raise":
            raise ValueError("The input contains nan values")
        if nan_policy == "propagate":
            return LeveneResult(np.float64(_NAN), np.float64(_NAN))
        xs = [x[x == x] for x in xs]
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
    arr, shape = _array(a, axis)
    rows = _rows(arr, shape, nan_policy)
    if any(r.size == 0 for r in rows):
        raise ValueError("The input must not be empty.")
    n = rows[0].size
    mins = _out([float(np.min(r)) for r in rows], shape)
    maxs = _out([float(np.max(r)) for r in rows], shape)
    means = _out([float(np.mean(r)) for r in rows], shape)
    vars_ = _out([float(np.var(r, ddof=ddof)) for r in rows], shape)
    sk = skew(arr.reshape(-1) if axis is None else np.moveaxis(arr, -1, 0), axis=0 if axis is not None else 0, bias=bias, nan_policy=nan_policy)
    ku = kurtosis(arr.reshape(-1) if axis is None else np.moveaxis(arr, -1, 0), axis=0, bias=bias, nan_policy=nan_policy)
    return DescribeResult(np.int64(n), (mins, maxs), means, vars_, sk, ku)


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
