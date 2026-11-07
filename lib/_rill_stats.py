"""Rill: statistics (summaries, distributions, the RNG, tests, lm/glm) and their print methods."""

import math
import sys

import _rill as C
from _rill import (Vec, RList, NULL, Closure, Builtin, Sym, Call, Const, MISSING, RError,
                   mk_chr, mk_int, mk_dbl, mk_lgl, getattr_, setattr_, names_of, classes, is_factor, is_df,
                   builtin, method, as_type, as_double, num1, int1, str1, match_spec, warn, shallow)
import _rill_fmt as F
import _rill_base as B

out = F.out
EPS = 2.220446049250313e-16


def dbl_values(x, narm=False, what="mean"):
    if is_factor(x) or (isinstance(x, Vec) and x.type == "character"):
        raise RError("'x' must be numeric")
    v = as_double(x).v
    if narm:
        v = [e for e in v if e is not None and not math.isnan(e)]
    return v


def has_na(v):
    return any(e is None for e in v)


def fsum(v):
    return math.fsum(v)


def r_mean(v):
    n = len(v)
    if n == 0:
        return math.nan
    s = math.fsum(v) / n
    # R refines the mean with a second pass (documented as long-double accumulation)
    if not math.isinf(s):
        s += math.fsum(e - s for e in v) / n
    return s


def mean_default(args, env):
    m = match_spec(args, "x, trim, na.rm, ...")
    x = m["x"]
    narm = "na.rm" in m and C.as_logical1(m["na.rm"])
    if not isinstance(x, Vec) or x.type == "character" or is_factor(x):
        warn("argument is not numeric or logical: returning NA", "mean.default(%s)" % "x")
        return mk_dbl([None])
    v = as_double(x).v
    if narm:
        v = [e for e in v if e is not None and not math.isnan(e)]
    elif has_na(v):
        return mk_dbl([None])
    return mk_dbl([r_mean(v)])


@builtin("mean")
def _mean(args, env):
    return C.dispatch("mean", args[0][1], args, env, mean_default)


def median_of(v):
    s = sorted(v)
    n = len(s)
    if n == 0:
        return None
    if n % 2:
        return s[n // 2]
    return (s[n // 2 - 1] + s[n // 2]) / 2


@builtin("median")
def _median(args, env):
    m = match_spec(args, "x, na.rm, ...")
    x = m["x"]
    narm = "na.rm" in m and C.as_logical1(m["na.rm"])
    v = x.v
    if narm:
        v = [e for e in v if e is not None]
    elif has_na(v):
        return Vec("double" if x.type != "integer" else "integer", [None])
    if x.type in ("integer", "logical") and len(v) % 2 == 1:
        return mk_int([int(median_of(v))])
    if not v:
        return Vec(x.type if x.type == "double" else "integer", [None])
    return mk_dbl([float(median_of([float(e) for e in v]))])


def var_of(v, w=None):
    n = len(v)
    if n < 2:
        return None
    mu = r_mean(v)
    if w is None:
        return math.fsum((e - mu) ** 2 for e in v) / (n - 1)
    mw = r_mean(w)
    return math.fsum((a - mu) * (b - mw) for a, b in zip(v, w)) / (n - 1)


@builtin("var")
def _var(args, env):
    m = match_spec(args, "x, y, na.rm, use")
    narm = "na.rm" in m and C.as_logical1(m["na.rm"])
    x = dbl_values(m["x"], narm)
    if "y" in m and m["y"] is not NULL:
        y = dbl_values(m["y"], narm)
        return mk_dbl([var_of(x, y)])
    if has_na(x):
        return mk_dbl([None])
    return mk_dbl([var_of(x)])


@builtin("sd")
def _sd(args, env):
    m = match_spec(args, "x, na.rm")
    narm = "na.rm" in m and C.as_logical1(m["na.rm"])
    x = dbl_values(m["x"], narm)
    if has_na(x):
        return mk_dbl([None])
    v = var_of(x)
    return mk_dbl([None if v is None else math.sqrt(v)])


@builtin("cov")
def _cov(args, env):
    m = match_spec(args, "x, y, use, method")
    return mk_dbl([var_of(dbl_values(m["x"]), dbl_values(m["y"]))])


def pearson(x, y):
    mx, my = r_mean(x), r_mean(y)
    sxy = math.fsum((a - mx) * (b - my) for a, b in zip(x, y))
    sxx = math.fsum((a - mx) ** 2 for a in x)
    syy = math.fsum((b - my) ** 2 for b in y)
    return sxy / math.sqrt(sxx * syy)


def ranks(v):
    return B._rank([(None, mk_dbl(v))], None).v


@builtin("cor")
def _cor(args, env):
    m = match_spec(args, "x, y, use, method")
    meth = str1(m["method"]) if "method" in m else "pearson"
    x = m["x"]
    if is_df(x) and "y" not in m:
        cols = [as_double(c).v for c in x.v]
        k = len(cols)
        vals = [pearson(cols[i], cols[j]) if i != j else 1.0 for j in range(k) for i in range(k)]
        nm = getattr_(x, "names")
        return mk_dbl(vals, {"dim": mk_int([k, k]), "dimnames": RList([nm, nm])})
    xv, yv = dbl_values(x), dbl_values(m["y"])
    if len(xv) != len(yv):
        raise RError("incompatible dimensions")
    if has_na(xv) or has_na(yv):
        return mk_dbl([None])
    if meth == "spearman":
        xv, yv = ranks(xv), ranks(yv)
    return mk_dbl([pearson(xv, yv)])


def quantile7(s, p):
    n = len(s)
    h = (n - 1) * p
    lo = int(math.floor(h + 4 * EPS))
    hi = min(lo + 1, n - 1)
    f = h - lo
    if f < 4 * EPS:
        return s[lo]
    return s[lo] + f * (s[hi] - s[lo])


def pct_names(probs):
    out_ = []
    for p in probs:
        s = F.format_real([100 * p], 7)[0]
        out_.append(s + "%")
    return out_


@builtin("quantile")
def _quantile(args, env):
    m = match_spec(args, "x, probs, na.rm, names, type, ...")
    narm = "na.rm" in m and C.as_logical1(m["na.rm"])
    v = dbl_values(m["x"], narm)
    if has_na(v):
        raise RError("missing values and NaN's not allowed if 'na.rm' is FALSE")
    probs = as_double(m["probs"]).v if "probs" in m else [0.0, 0.25, 0.5, 0.75, 1.0]
    s = sorted(v)
    res = [quantile7(s, p) for p in probs]
    r = mk_dbl(res)
    if "names" not in m or C.as_logical1(m["names"]):
        r.attrs = {"names": mk_chr(pct_names(probs))}
    return r


@builtin("IQR")
def _iqr(args, env):
    s = sorted(dbl_values(args[0][1], B.narm_of(args)))
    return mk_dbl([quantile7(s, 0.75) - quantile7(s, 0.25)])


@builtin("mad")
def _mad(args, env):
    v = dbl_values(args[0][1])
    med = median_of(v)
    return mk_dbl([1.4826 * median_of([abs(e - med) for e in v])])


@builtin("fivenum")
def _fivenum(args, env):
    s = sorted(e for e in dbl_values(args[0][1]) if e is not None)
    n = len(s)
    n4 = math.floor((n + 3) / 2) / 2
    d = [1, n4, (n + 1) / 2, n + 1 - n4, n]
    return mk_dbl([0.5 * (s[int(math.floor(e)) - 1] + s[int(math.ceil(e)) - 1]) for e in d])


@builtin("weighted.mean")
def _wmean(args, env):
    m = match_spec(args, "x, w, ..., na.rm")
    x, w = dbl_values(m["x"]), dbl_values(m["w"])
    return mk_dbl([math.fsum(a * b for a, b in zip(x, w)) / math.fsum(w)])


@builtin("scale")
def _scale(args, env):
    m = match_spec(args, "x, center, scale")
    x = m["x"]
    if getattr_(x, "dim") is NULL:
        v = dbl_values(x)
        cols = [v]
    else:
        nr, nc = getattr_(x, "dim").v
        v = as_double(x).v
        cols = [v[j * nr:(j + 1) * nr] for j in range(nc)]
    ctr = [r_mean(c) for c in cols]
    sc = [math.sqrt(var_of(c)) for c in cols]
    vals = [(e - ctr[j]) / sc[j] for j, c in enumerate(cols) for e in c]
    return mk_dbl(vals, {"dim": mk_int([len(cols[0]), len(cols)]), "scaled:center": mk_dbl(ctr), "scaled:scale": mk_dbl(sc)})


# ---------------------------------------------------------------- summary()

def summary_num(x):
    v = as_double(x).v
    nas = sum(1 for e in v if e is None)
    v = [e for e in v if e is not None]
    s = sorted(v)
    q = [quantile7(s, p) for p in (0, 0.25, 0.5)] + [r_mean(v)] + [quantile7(s, p) for p in (0.75, 1)]
    names = ["Min.", "1st Qu.", "Median", "Mean", "3rd Qu.", "Max."]
    if nas:
        q.append(float(nas))
        names.append("NA's")
    return mk_dbl(q, {"names": mk_chr(names), "class": mk_chr(["summaryDefault", "table"])})


@builtin("summary")
def _summary(args, env):
    x = args[0][1]

    def default(a, e):
        if is_factor(x):
            lv = getattr_(x, "levels").v
            counts = [0] * len(lv)
            for c in x.v:
                if c is not None:
                    counts[c - 1] += 1
            return mk_int(counts, {"names": mk_chr(lv)})
        if is_df(x):
            return summary_df(x)
        if isinstance(x, Vec) and x.type == "logical":
            f = sum(1 for e in x.v if e is False)
            t = sum(1 for e in x.v if e is True)
            vals, nm = ["logical"], ["Mode"]
            if f:
                vals.append(str(f))
                nm.append("FALSE")
            if t:
                vals.append(str(t))
                nm.append("TRUE")
            return mk_chr(vals, {"names": mk_chr(nm), "class": mk_chr(["summaryDefault", "table"])})
        if isinstance(x, Vec) and x.type == "character":
            return mk_chr([str(len(x.v)), "character", "character"], {"names": mk_chr(["Length", "Class", "Mode"]), "class": mk_chr(["summaryDefault", "table"])})
        return summary_num(x)
    return C.dispatch("summary", x, args, env, default)


@method("print.summaryDefault")
def _print_summ(args, env):
    x = args[0][1]
    if x.type == "character":
        strs = list(x.v)
    else:
        # documented: zapsmall(x, digits + zdigits) then format(digits = 4)
        k = len(x.v) - (1 if names_of(x)[-1] == "NA's" else 0)
        strs = F.format_real(zapsmall(x.v[:k], 8), 4) + [str(int(e)) for e in x.v[k:]]
    F.print_named(strs, names_of(x))
    C.STATE["visible"] = False
    return x


def summary_df(df):
    names = names_of(df)
    cells = []
    for col in df.v:
        if is_factor(col):
            lv = getattr_(col, "levels").v
            counts = [0] * len(lv)
            for c in col.v:
                if c is not None:
                    counts[c - 1] += 1
            w = max(len(l) for l in lv)
            cw = max(len(str(c)) for c in counts)
            cells.append([l.ljust(w) + ":" + str(c).rjust(cw) + "  " for l, c in zip(lv, counts)])
        elif isinstance(col, Vec) and col.type == "character":
            cells.append(["Length:%d  " % len(col.v), "Class :character  ", "Mode  :character  "])
        else:
            s = summary_num(col)
            strs = F.format_real(zapsmall(s.v[:6], 8), 4)
            w = max(len(e) for e in strs)
            lab = ["Min.   :", "1st Qu.:", "Median :", "Mean   :", "3rd Qu.:", "Max.   :"]
            cells.append([l + e.rjust(w) + "  " for l, e in zip(lab, strs)])
            if len(s.v) > 6:
                cells[-1].append("NA's   :" + str(int(s.v[6])).rjust(w) + "  ")
    nr = max(len(c) for c in cells)
    vals = []
    hdr = []
    for nm, c in zip(names, cells):
        w = max(len(e) for e in c)
        pad = (w + 1) // 2 - (len(nm) - 1) // 2
        hdr.append(" " * max(pad, 0) + nm)
        vals.extend(c + [None] * (nr - len(c)))
    return mk_chr(vals, {"dim": mk_int([nr, len(cells)]), "dimnames": RList([mk_chr([""] * nr), mk_chr(hdr)]),
                         "class": mk_chr(["table"])})


@method("print.table")
def _print_table(args, env):
    x = args[0][1]
    d = getattr_(x, "dim")
    if x.type == "character" and d is not NULL and len(d.v) == 2:
        nr, nc = d.v
        dn = getattr_(x, "dimnames")
        cn = list(dn.v[1].v)
        cols = []
        for j in range(nc):
            s = ["" if e is None else e for e in x.v[j * nr:(j + 1) * nr]]
            w = max([len(e) for e in s] + [len(cn[j])])
            cols.append((s, w))
        out("".join(" " + cn[j].ljust(cols[j][1]) for j in range(nc)) + "\n")
        for i in range(nr):
            out("".join(" " + cols[j][0][i].ljust(cols[j][1]) for j in range(nc)) + "\n")
    elif d is not NULL and len(d.v) == 2:
        F.print_table2(x)
    else:
        F.print_table1(x)
    C.STATE["visible"] = False
    return x


# ---------------------------------------------------------------- distributions

def _sp():
    import scipy.special as sp
    return sp


def _st():
    import scipy.stats as st
    return st


def norm_cdf(x):
    return 0.5 * math.erfc(-x / math.sqrt(2.0))


def norm_ppf(p):
    from statistics import NormalDist
    if p <= 0:
        return -math.inf if p == 0 else math.nan
    if p >= 1:
        return math.inf if p == 1 else math.nan
    return NormalDist().inv_cdf(p)


def dist(name, params, fn, kind):
    """Register d/p/q functions: fn(x, *params) for density, cdf (lower) or quantile."""
    spec = "x, " + ", ".join(p for p, _ in params) + (", log" if kind == "d" else ", lower.tail, log.p")

    def f(args, env):
        m = match_spec(args, spec)
        xs = as_double(m["x"])
        pv = []
        for p, d in params:
            if p in m:
                pv.append(as_double(m[p]).v)
            elif d is None:
                raise RError('argument "%s" is missing, with no default' % p)
            else:
                pv.append([d])
        lower = C.as_logical1(m["lower.tail"]) if "lower.tail" in m else True
        logp = (C.as_logical1(m["log.p"]) if "log.p" in m else False) if kind != "d" else (C.as_logical1(m["log"]) if "log" in m else False)
        n = max([len(xs.v)] + [len(v) for v in pv]) if xs.v else 0
        res = []
        nan = False
        for i in range(n):
            x = xs.v[i % len(xs.v)]
            ps = [v[i % len(v)] for v in pv]
            if x is None or any(p is None for p in ps):
                res.append(None)
                continue
            if kind == "q":
                if logp:
                    x = math.exp(x)
                if not lower:
                    x = 1 - x
                if x < 0 or x > 1:
                    res.append(math.nan)
                    nan = True
                    continue
            r = fn(x, *ps)
            if r is None or (isinstance(r, float) and math.isnan(r)):
                nan = True
                res.append(math.nan)
                continue
            if kind == "p":
                if not lower:
                    r = r[1] if isinstance(r, tuple) else 1 - r
                elif isinstance(r, tuple):
                    r = r[0]
                if logp:
                    r = math.log(r) if r > 0 else -math.inf
            elif kind == "d" and logp:
                r = math.log(r) if r > 0 else -math.inf
            res.append(float(r))
        if nan:
            warn("NaNs produced")
        r = mk_dbl(res)
        if xs.attrs and "names" in xs.attrs and len(res) == len(xs.v):
            r.attrs = {"names": xs.attrs["names"]}
        return r
    return f


def both(lo, up):
    return (lo, up)


# normal
def dnorm(x, mu, sd):
    if sd < 0:
        return math.nan
    z = (x - mu) / sd
    return math.exp(-0.5 * z * z) / (sd * math.sqrt(2 * math.pi))


def pnorm(x, mu, sd):
    z = (x - mu) / sd
    return both(norm_cdf(z), norm_cdf(-z))


def qnorm(p, mu, sd):
    return mu + sd * norm_ppf(p)


# binomial
def dbinom(x, n, p):
    if x != math.floor(x) or x < 0 or x > n:
        return 0.0
    k, n = int(x), int(n)
    if n <= 1000:
        return math.comb(n, k) * p ** k * (1 - p) ** (n - k)
    return math.exp(math.lgamma(n + 1) - math.lgamma(k + 1) - math.lgamma(n - k + 1) + k * math.log(p) + (n - k) * math.log1p(-p))


def pbinom(x, n, p):
    k = math.floor(x + 1e-7)
    if k < 0:
        return both(0.0, 1.0)
    if k >= n:
        return both(1.0, 0.0)
    sp = _sp()
    lo = float(sp.betainc(n - k, k + 1, 1 - p))
    up = float(sp.betainc(k + 1, n - k, p))
    return both(lo, up)


def disc_quantile(p, cdf, start=0, upper=None):
    if p == 0:
        return float(start)
    k = start
    fuzz = 1 - 64 * EPS
    while True:
        if upper is not None and k >= upper:
            return float(upper)
        c = cdf(k)
        if c >= p * fuzz:
            return float(k)
        k += 1


def qbinom(p, n, pr):
    if p == 1:
        return float(n)
    return disc_quantile(p, lambda k: pbinom(k, n, pr)[0], 0, n)


# Poisson
def dpois(x, lam):
    if x != math.floor(x) or x < 0:
        return 0.0
    return math.exp(x * math.log(lam) - lam - math.lgamma(x + 1)) if lam > 0 else (1.0 if x == 0 else 0.0)


def ppois(x, lam):
    k = math.floor(x + 1e-7)
    if k < 0:
        return both(0.0, 1.0)
    sp = _sp()
    return both(float(sp.gammaincc(k + 1, lam)), float(sp.gammainc(k + 1, lam)))


def qpois(p, lam):
    if p == 1:
        return math.inf
    return disc_quantile(p, lambda k: ppois(k, lam)[0], 0)


# t, chi-squared, F
def pt(x, df):
    sp = _sp()
    tail = 0.5 * float(sp.betainc(df / 2.0, 0.5, df / (df + x * x)))
    return both(1 - tail, tail) if x > 0 else both(tail, 1 - tail)


def qt(p, df):
    st = _st()
    return float(st.t.ppf(p, df))


def dt(x, df):
    st = _st()
    return float(st.t.pdf(x, df))


def pchisq(x, df):
    if x <= 0:
        return both(0.0, 1.0)
    sp = _sp()
    return both(float(sp.gammainc(df / 2.0, x / 2.0)), float(sp.gammaincc(df / 2.0, x / 2.0)))


def qchisq(p, df):
    sp = _sp()
    return 2.0 * float(sp.gammaincinv(df / 2.0, p))


def dchisq(x, df):
    return float(_st().chi2.pdf(x, df))


def pf(x, d1, d2):
    if x <= 0:
        return both(0.0, 1.0)
    sp = _sp()
    z = d1 * x / (d1 * x + d2)
    return both(float(sp.betainc(d1 / 2.0, d2 / 2.0, z)), float(sp.betainc(d2 / 2.0, d1 / 2.0, 1 - z)))


def qf(p, d1, d2):
    sp = _sp()
    z = float(sp.betaincinv(d1 / 2.0, d2 / 2.0, p))
    return d2 * z / (d1 * (1 - z))


def df_(x, d1, d2):
    return float(_st().f.pdf(x, d1, d2))


# uniform, exponential, gamma, beta
def punif(x, a, b):
    v = 0.0 if x <= a else (1.0 if x >= b else (x - a) / (b - a))
    return both(v, 1 - v)


def dunif(x, a, b):
    return 1.0 / (b - a) if a <= x <= b else 0.0


def qunif(p, a, b):
    return a + p * (b - a)


def pexp(x, rate):
    if x <= 0:
        return both(0.0, 1.0)
    return both(-math.expm1(-rate * x), math.exp(-rate * x))


def dexp(x, rate):
    return rate * math.exp(-rate * x) if x >= 0 else 0.0


def qexp(p, rate):
    return -math.log1p(-p) / rate


def pgamma(x, shape, rate):
    if x <= 0:
        return both(0.0, 1.0)
    sp = _sp()
    return both(float(sp.gammainc(shape, x * rate)), float(sp.gammaincc(shape, x * rate)))


def qgamma(p, shape, rate):
    return float(_sp().gammaincinv(shape, p)) / rate


def dgamma(x, shape, rate):
    if x < 0:
        return 0.0
    return math.exp(shape * math.log(rate) + (shape - 1) * math.log(x) - rate * x - math.lgamma(shape)) if x > 0 else (rate if shape == 1 else (0.0 if shape > 1 else math.inf))


def pbeta(x, a, b):
    if x <= 0:
        return both(0.0, 1.0)
    if x >= 1:
        return both(1.0, 0.0)
    sp = _sp()
    return both(float(sp.betainc(a, b, x)), float(sp.betainc(b, a, 1 - x)))


def qbeta(p, a, b):
    return float(_sp().betaincinv(a, b, p))


def dbeta(x, a, b):
    if x < 0 or x > 1:
        return 0.0
    return math.exp((a - 1) * math.log(x) + (b - 1) * math.log1p(-x) - (math.lgamma(a) + math.lgamma(b) - math.lgamma(a + b)))


def reg(base, params, d=None, p=None, q=None):
    if d:
        builtin("d" + base)(dist(base, params, d, "d"))
    if p:
        builtin("p" + base)(dist(base, params, p, "p"))
    if q:
        builtin("q" + base)(dist(base, params, q, "q"))


reg("norm", [("mean", 0.0), ("sd", 1.0)], dnorm, pnorm, qnorm)
reg("binom", [("size", None), ("prob", None)], dbinom, pbinom, qbinom)
reg("pois", [("lambda", None)], dpois, ppois, qpois)
reg("t", [("df", None)], dt, pt, qt)
reg("chisq", [("df", None)], dchisq, pchisq, qchisq)
reg("f", [("df1", None), ("df2", None)], df_, pf, qf)
reg("unif", [("min", 0.0), ("max", 1.0)], dunif, punif, qunif)
reg("exp", [("rate", 1.0)], dexp, pexp, qexp)
reg("gamma", [("shape", None), ("rate", 1.0)], dgamma, pgamma, qgamma)
reg("beta", [("shape1", None), ("shape2", None)], dbeta, pbeta, qbeta)


# ---------------------------------------------------------------- the RNG
# Derived by black-box observation of real R (outputs of set.seed/.Random.seed/runif/rnorm only):
# - set.seed(s): the 624 Mersenne-Twister words are successive values of x -> 69069 x + 1 (mod 2^32),
#   starting 52 steps after s (fitted from .Random.seed for several seeds);
# - runif: the tempered MT19937 output (Matsumoto & Nishimura 1998) times 2^-32;
# - rnorm (Inversion): qnorm((floor(2^27 u1) + u2) / 2^27), two uniforms per normal (fitted on 200 draws).

class MT:
    def __init__(self):
        self.mt = None
        self.i = 624

    def seed(self, s):
        x = s % 4294967296
        for _ in range(52):
            x = (69069 * x + 1) % 4294967296
        st = [x]
        for _ in range(623):
            x = (69069 * x + 1) % 4294967296
            st.append(x)
        self.mt = st
        self.i = 624

    def gen(self):
        mt = self.mt
        for k in range(624):
            y = (mt[k] & 0x80000000) | (mt[(k + 1) % 624] & 0x7fffffff)
            mt[k] = mt[(k + 397) % 624] ^ (y >> 1) ^ (0x9908b0df if y & 1 else 0)
        self.i = 0

    def unif(self):
        if self.mt is None:
            import time
            self.seed(int(time.time() * 1000) & 0xffffffff)
        if self.i >= 624:
            self.gen()
        y = self.mt[self.i]
        self.i += 1
        y ^= y >> 11
        y ^= (y << 7) & 0x9d2c5680
        y ^= (y << 15) & 0xefc60000
        y ^= y >> 18
        u = y * 2.3283064365386963e-10
        if u <= 0.0:
            return 0.5 * 2.328306437080797e-10
        if 1.0 - u <= 0.0:
            return 1.0 - 0.5 * 2.328306437080797e-10
        return u


RNG = MT()


@builtin("set.seed")
def _setseed(args, env):
    RNG.seed(int1(args[0][1]))
    C.STATE["visible"] = False
    return NULL


def nval(m):
    n = m["n"]
    return len(n.v) if len(n.v) > 1 else int1(n)


@builtin("runif")
def _runif(args, env):
    m = match_spec(args, "n, min, max")
    a = num1(m["min"]) if "min" in m else 0.0
    b = num1(m["max"]) if "max" in m else 1.0
    return mk_dbl([a + (b - a) * RNG.unif() for _ in range(nval(m))])


def norm_rand():
    big = 134217728.0
    u = RNG.unif()
    u = int(big * u) + RNG.unif()
    return norm_ppf(u / big)


@builtin("rnorm")
def _rnorm(args, env):
    m = match_spec(args, "n, mean, sd")
    mu = as_double(m["mean"]).v if "mean" in m else [0.0]
    sd = as_double(m["sd"]).v if "sd" in m else [1.0]
    return mk_dbl([mu[i % len(mu)] + sd[i % len(sd)] * norm_rand() for i in range(nval(m))])


@builtin("rexp")
def _rexp(args, env):
    m = match_spec(args, "n, rate")
    r = num1(m["rate"]) if "rate" in m else 1.0
    return mk_dbl([-math.log(RNG.unif()) / r for _ in range(nval(m))])


@builtin("sample")
def _sample(args, env):
    # NOTE: R's default sample.kind "Rejection" is not documented in enough detail to reproduce;
    # this uses floor(n * u), which reproduces only the old "Rounding" kind (see the spike report).
    m = match_spec(args, "x, size, replace, prob")
    x = m["x"]
    if isinstance(x, Vec) and len(x.v) == 1 and x.type in ("integer", "double") and x.v[0] >= 1:
        pool = mk_int(list(range(1, int(x.v[0]) + 1)))
    else:
        pool = x
    n = len(pool.v)
    size = int1(m["size"]) if "size" in m else n
    rep = "replace" in m and C.as_logical1(m["replace"])
    if not rep and size > n:
        raise RError("cannot take a sample larger than the population when 'replace = FALSE'")
    idx = []
    avail = list(range(n))
    for _ in range(size):
        if rep:
            idx.append(int(n * RNG.unif()))
        else:
            j = int(len(avail) * RNG.unif())
            idx.append(avail[j])
            avail[j] = avail[-1]
            avail.pop()
    return B.subset_vec(pool, mk_int([i + 1 for i in idx]))


@builtin("rbinom")
def _rbinom(args, env):
    # NOTE: inversion; R's binomial generator is not reproduced (see the spike report)
    m = match_spec(args, "n, size, prob")
    size, p = int1(m["size"]), num1(m["prob"])
    res = []
    for _ in range(nval(m)):
        u = RNG.unif()
        k = 0
        c = dbinom(0, size, p)
        while u > c and k < size:
            k += 1
            c += dbinom(k, size, p)
        res.append(k)
    return mk_int(res)


@builtin("rpois")
def _rpois(args, env):
    m = match_spec(args, "n, lambda")
    lam = num1(m["lambda"])
    res = []
    for _ in range(nval(m)):
        u = RNG.unif()
        k = 0
        c = dpois(0, lam)
        while u > c:
            k += 1
            c += dpois(k, lam)
        res.append(k)
    return mk_int(res)


# ---------------------------------------------------------------- htest

def htest(**kw):
    names = list(kw)
    return RList([kw[k] for k in names], {"names": mk_chr(names), "class": mk_chr(["htest"])})


def named(v, nm):
    return mk_dbl([v] if not isinstance(v, list) else v, {"names": mk_chr([nm] if isinstance(nm, str) else nm)})


def fmt_digits(x, d):
    return F.format_real([x], d)[0]


def format_pval(p, digits):
    if p < EPS:
        return "< " + F.format_real([EPS], max(1, digits - 2))[0]
    return F.format_real([p], digits)[0]


def format_pvals(pv, digits):
    """A p-value column: values >= 1e-3 share one fixed format; smaller ones are formatted alone."""
    fixed = [p for p in pv if p >= 1e-3]
    fs = F.format_real(fixed, digits) if fixed else []
    out_, k = [], 0
    for p in pv:
        if p >= 1e-3:
            out_.append(fs[k])
            k += 1
        else:
            out_.append(format_pval(p, digits))
    return out_


@method("print.htest")
def _print_htest(args, env):
    x = args[0][1]
    get = lambda k: B.dollar(x, k)
    out("\n")
    out("\t" + str1(get("method")).strip() + "\n")
    out("\n")
    out("data:  " + str1(get("data.name")) + "\n")
    parts = []
    st = get("statistic")
    if st is not NULL:
        parts.append("%s = %s" % (names_of(st)[0], fmt_digits(st.v[0], 5)))
    par = get("parameter")
    if par is not NULL:
        for nm, v in zip(names_of(par), par.v):
            parts.append("%s = %s" % (nm, fmt_digits(v, 5)))
    pv = get("p.value")
    if pv is not NULL:
        fp = format_pval(pv.v[0], 4)
        parts.append("p-value " + (fp if fp.startswith("<") else "= " + fp))
    out(", ".join(parts) + "\n")
    alt = get("alternative")
    if alt is not NULL:
        nv = get("null.value")
        if nv is not NULL:
            a = str1(alt)
            word = {"two.sided": "not equal to", "less": "less than", "greater": "greater than"}[a]
            out("alternative hypothesis: true %s is %s %s\n" % (names_of(nv)[0], word, fmt_digits(nv.v[0], 7)))
        else:
            out("alternative hypothesis: %s\n" % str1(alt))
    ci = get("conf.int")
    if ci is not NULL:
        lev = getattr_(ci, "conf.level").v[0]
        out("%s percent confidence interval:\n" % fmt_digits(100 * lev, 7))
        cs = F.format_real(ci.v, 7)
        w = max(len(e) for e in cs)
        out(" " + " ".join(e.rjust(w) for e in cs) + "\n")
    est = get("estimate")
    if est is not NULL:
        out("sample estimates:\n")
        F.print_generic(est, env)
    out("\n")
    C.STATE["visible"] = False
    return x


def alt_of(m):
    a = str1(m["alternative"]) if "alternative" in m else "two.sided"
    for full in ("two.sided", "less", "greater"):
        if full.startswith(a):
            return full
    raise RError("'arg' should be one of “two.sided”, “less”, “greater”")


def t_pvalue(t, df, alt):
    lo, up = pt(t, df)
    if alt == "less":
        return lo
    if alt == "greater":
        return up
    return 2 * min(lo, up)


def t_ci(est, se, df, alt, level):
    if alt == "less":
        return [-math.inf, est + se * qt(level, df)]
    if alt == "greater":
        return [est - se * qt(level, df), math.inf]
    q = qt(1 - (1 - level) / 2, df)
    return [est - q * se, est + q * se]


@builtin("t.test", special=True)
def _ttest(call, env):
    args = C.eval_args(call.args, env)
    labels = [F.deparse(a) for n, a in call.args if n in (None, "x", "y")]
    m = match_spec(args, "x, y, alternative, mu, paired, var.equal, conf.level, ...")
    C.STATE["visible"] = True
    if isinstance(m["x"], Call) and C.inherits(m["x"], "formula"):
        f = m["x"]
        data = m.get("y") if "y" in m and is_df(m.get("y")) else m.get("data")
        for n_, v_ in args:
            if n_ == "data":
                data = v_
        e = model_data(f, data, env)
        yv = C.force(C.ev(f.args[0][1], e))
        g = C.force(C.ev(f.args[1][1], e))
        fac = g if is_factor(g) else B.make_factor(g)
        lv = getattr_(fac, "levels").v
        if len(lv) != 2:
            raise RError("grouping factor must have exactly 2 levels")
        ys = [[e2 for e2, c in zip(as_double(yv).v, fac.v) if c == k + 1] for k in range(2)]
        rest = [(n_, v_) for n_, v_ in args if n_ not in (None, "formula", "data", "x", "y")]
        r = _ttest(Call(Sym("t.test"), [(None, Const(mk_dbl(ys[0]))), (None, Const(mk_dbl(ys[1])))] + [(n_, Const(v_)) for n_, v_ in rest]), env)
        names = names_of(r)
        r.v[names.index("estimate")] = named(B.dollar(r, "estimate").v, ["mean in group " + lv[0], "mean in group " + lv[1]])
        r.v[names.index("null.value")] = named(B.dollar(r, "null.value").v, ["difference in means between group %s and group %s" % (lv[0], lv[1])])
        r.v[names.index("data.name")] = mk_chr(["%s by %s" % (F.deparse(f.args[0][1]), F.deparse(f.args[1][1]))])
        return r
    x = [e for e in dbl_values(m["x"]) if e is not None]
    y = [e for e in dbl_values(m["y"]) if e is not None] if "y" in m and m["y"] is not NULL else None
    alt = alt_of(m)
    mu = num1(m["mu"]) if "mu" in m else 0.0
    paired = "paired" in m and C.as_logical1(m["paired"])
    vareq = "var.equal" in m and C.as_logical1(m["var.equal"])
    level = num1(m["conf.level"]) if "conf.level" in m else 0.95
    if paired:
        x = [a - b for a, b in zip(x, y)]
        y = None
    if y is None:
        n = len(x)
        est = r_mean(x)
        se = math.sqrt(var_of(x) / n)
        df = n - 1
        t = (est - mu) / se
        method_ = "Paired t-test" if paired else "One Sample t-test"
        estimate = named(est, "mean difference" if paired else "mean of x")
        nv = named(mu, "mean difference" if paired else "mean")
        dname = labels[0] if not paired else "%s and %s" % (labels[0], labels[1])
    else:
        nx, ny = len(x), len(y)
        mx, my = r_mean(x), r_mean(y)
        vx, vy = var_of(x), var_of(y)
        if vareq:
            df = nx + ny - 2
            v = ((nx - 1) * vx + (ny - 1) * vy) / df
            se = math.sqrt(v * (1 / nx + 1 / ny))
            method_ = " Two Sample t-test"
        else:
            sx, sy = vx / nx, vy / ny
            se = math.sqrt(sx + sy)
            df = (sx + sy) ** 2 / (sx ** 2 / (nx - 1) + sy ** 2 / (ny - 1))
            method_ = "Welch Two Sample t-test"
        est = mx - my
        t = (est - mu) / se
        estimate = named([mx, my], ["mean of x", "mean of y"])
        nv = named(mu, "difference in means")
        dname = "%s and %s" % (labels[0], labels[1])
    p = t_pvalue(t, df, alt)
    ci = t_ci(est, se, df, alt, level)
    cint = mk_dbl([c + (mu if y is None else mu) - (mu if y is None else mu) for c in ci], {"conf.level": mk_dbl([level])})
    return htest(statistic=named(t, "t"), parameter=named(float(df), "df"), **{"p.value": mk_dbl([p]), "conf.int": cint},
                 estimate=estimate, **{"null.value": nv, "stderr": mk_dbl([se]), "alternative": mk_chr([alt]),
                                       "method": mk_chr([method_]), "data.name": mk_chr([dname])})


@builtin("chisq.test", special=True)
def _chisq(call, env):
    args = C.eval_args(call.args, env)
    m = match_spec(args, "x, y, correct, p, rescale.p, simulate.p.value, B")
    C.STATE["visible"] = True
    x = m["x"]
    dname = F.deparse(call.args[0][1])
    correct = C.as_logical1(m["correct"]) if "correct" in m else True
    d = getattr_(x, "dim")
    if d is not NULL and len(d.v) == 2 and min(d.v) > 1:
        nr, nc = d.v
        v = as_double(x).v
        tot = math.fsum(v)
        rs = [math.fsum(v[j * nr + i] for j in range(nc)) for i in range(nr)]
        cs = [math.fsum(v[j * nr:(j + 1) * nr]) for j in range(nc)]
        E = [rs[i] * cs[j] / tot for j in range(nc) for i in range(nr)]
        yates = 0.0
        method_ = "Pearson's Chi-squared test"
        if correct and nr == 2 and nc == 2:
            yates = min(0.5, min(abs(o - e) for o, e in zip(v, E)))
            method_ = "Pearson's Chi-squared test with Yates' continuity correction"
        stat = math.fsum((abs(o - e) - yates) ** 2 / e for o, e in zip(v, E))
        df = (nr - 1) * (nc - 1)
    else:
        v = as_double(x).v
        n = math.fsum(v)
        k = len(v)
        p = as_double(m["p"]).v if "p" in m else [1.0 / k] * k
        E = [n * pi for pi in p]
        stat = math.fsum((o - e) ** 2 / e for o, e in zip(v, E))
        df = k - 1
        method_ = "Chi-squared test for given probabilities"
    if min(E) < 5:
        warn("Chi-squared approximation may be incorrect", F.deparse(Call(Sym("chisq.test"), call.args)))
    pv = pchisq(stat, df)[1]
    return htest(statistic=named(stat, "X-squared"), parameter=named(float(df), "df"), **{"p.value": mk_dbl([pv]),
                 "method": mk_chr([method_]), "data.name": mk_chr([dname]), "observed": x, "expected": mk_dbl(E)})


@builtin("prop.test", special=True)
def _proptest(call, env):
    args = C.eval_args(call.args, env)
    m = match_spec(args, "x, n, p, alternative, conf.level, correct")
    C.STATE["visible"] = True
    x, n = num1(m["x"]), num1(m["n"])
    p0 = num1(m["p"]) if "p" in m and m["p"] is not NULL else 0.5
    level = num1(m["conf.level"]) if "conf.level" in m else 0.95
    correct = C.as_logical1(m["correct"]) if "correct" in m else True
    alt = alt_of(m)
    ph = x / n
    yates = min(0.5, abs(x - n * p0)) if correct else 0.0
    stat = (abs(x - n * p0) - yates) ** 2 / (n * p0 * (1 - p0))
    pv = pchisq(stat, 1)[1]
    z = norm_ppf(1 - (1 - level) / 2)
    yc = yates / n if correct else 0.0
    # Wilson score interval, continuity corrected (inverting the score test)
    def wilson(pc, sign):
        z2 = z * z
        return (pc + z2 / (2 * n) + sign * z * math.sqrt(pc * (1 - pc) / n + z2 / (4 * n * n))) / (1 + z2 / n)
    lo = 0.0 if ph - yc <= 0 else wilson(ph - yc, -1)
    hi = 1.0 if ph + yc >= 1 else wilson(ph + yc, 1)
    dname = "%s out of %s, null probability %s" % (F.deparse(call.args[0][1]), F.deparse(call.args[1][1]), C.num_to_str(p0))
    meth = "1-sample proportions test %s continuity correction" % ("with" if correct and yates else "without")
    return htest(statistic=named(stat, "X-squared"), parameter=named(1.0, "df"), **{"p.value": mk_dbl([pv]),
                 "estimate": named(ph, "p"), "null.value": named(p0, "p"),
                 "conf.int": mk_dbl([max(lo, 0.0), min(hi, 1.0)], {"conf.level": mk_dbl([level])}),
                 "alternative": mk_chr([alt]), "method": mk_chr([meth]), "data.name": mk_chr([dname])})


@builtin("binom.test", special=True)
def _binomtest(call, env):
    args = C.eval_args(call.args, env)
    m = match_spec(args, "x, n, p, alternative, conf.level")
    C.STATE["visible"] = True
    x, n = int1(m["x"]), int1(m["n"])
    p0 = num1(m["p"]) if "p" in m else 0.5
    level = num1(m["conf.level"]) if "conf.level" in m else 0.95
    alt = alt_of(m)
    d = dbinom(x, n, p0)
    relerr = 1 + 1e-7
    if alt == "less":
        pv = pbinom(x, n, p0)[0]
    elif alt == "greater":
        pv = pbinom(x - 1, n, p0)[1]
    else:
        pv = min(1.0, math.fsum(dbinom(k, n, p0) for k in range(n + 1) if dbinom(k, n, p0) <= d * relerr))
    a = (1 - level) / 2
    lo = 0.0 if x == 0 else qbeta(a, x, n - x + 1)
    hi = 1.0 if x == n else qbeta(1 - a, x + 1, n - x)
    dname = "%s and %s" % (F.deparse(call.args[0][1]), F.deparse(call.args[1][1]))
    return htest(statistic=named(float(x), "number of successes"), parameter=named(float(n), "number of trials"),
                 **{"p.value": mk_dbl([pv]), "conf.int": mk_dbl([lo, hi], {"conf.level": mk_dbl([level])}),
                    "estimate": named(x / n, "probability of success"), "null.value": named(p0, "probability of success"),
                    "alternative": mk_chr([alt]), "method": mk_chr(["Exact binomial test"]), "data.name": mk_chr([dname])})


@builtin("cor.test", special=True)
def _cortest(call, env):
    args = C.eval_args(call.args, env)
    m = match_spec(args, "x, y, alternative, method, conf.level, ...")
    C.STATE["visible"] = True
    x, y = dbl_values(m["x"]), dbl_values(m["y"])
    alt = alt_of(m)
    level = num1(m["conf.level"]) if "conf.level" in m else 0.95
    n = len(x)
    r = pearson(x, y)
    df = n - 2
    t = r * math.sqrt(df) / math.sqrt(1 - r * r)
    pv = t_pvalue(t, df, alt)
    z = math.atanh(r)
    s = 1 / math.sqrt(n - 3)
    q = norm_ppf(1 - (1 - level) / 2)
    ci = [math.tanh(z - q * s), math.tanh(z + q * s)]
    dname = "%s and %s" % (F.deparse(call.args[0][1]), F.deparse(call.args[1][1]))
    return htest(statistic=named(t, "t"), parameter=named(float(df), "df"), **{"p.value": mk_dbl([pv]),
                 "estimate": named(r, "cor"), "null.value": named(0.0, "correlation"), "alternative": mk_chr([alt]),
                 "method": mk_chr(["Pearson's product-moment correlation"]), "data.name": mk_chr([dname]),
                 "conf.int": mk_dbl(ci, {"conf.level": mk_dbl([level])})})


# ---------------------------------------------------------------- models

def formula_parts(f):
    """(response node or None, list of term nodes, intercept?) for y ~ a + b - 1."""
    if len(f.args) == 2:
        lhs, rhs = f.args[0][1], f.args[1][1]
    else:
        lhs, rhs = None, f.args[0][1]
    terms = []
    intercept = [True]

    def walk(node, sign):
        if isinstance(node, Call) and isinstance(node.fn, Sym) and node.fn.name in ("+", "-") and len(node.args) == 2:
            walk(node.args[0][1], sign)
            walk(node.args[1][1], sign if node.fn.name == "+" else -sign)
            return
        if isinstance(node, Call) and isinstance(node.fn, Sym) and node.fn.name == "(":
            walk(node.args[0][1], sign)
            return
        if isinstance(node, Const) and isinstance(node.value, Vec) and node.value.type in ("double", "integer"):
            v = node.value.v[0]
            if v == 0 or (v == 1 and sign < 0):
                intercept[0] = False
            return
        if isinstance(node, Sym) and node.name == "." :
            terms.append(("dot", sign))
            return
        if sign > 0:
            terms.append(node)
    walk(rhs, 1)
    return lhs, terms, intercept[0]


def model_data(f, data, env):
    fenv = getattr_(f, ".Environment")
    parent = fenv if isinstance(fenv, C.Env) else env
    return B.data_env(data, parent) if data is not None and data is not NULL else parent


def design(f, data, env):
    lhs, terms, icpt = formula_parts(f)
    e = model_data(f, data, env)
    y = as_double(C.force(C.ev(lhs, e))) if lhs is not None else None
    cols, names = [], []
    n = len(y.v) if y is not None else None
    xlevels = {}
    expanded = []
    for t in terms:
        if isinstance(t, tuple) and t[0] == "dot":
            for nm in names_of(data):
                if lhs is None or F.deparse(lhs) != nm:
                    expanded.append(Sym(nm))
        else:
            expanded.append(t)
    for t in expanded:
        v = C.force(C.ev(t, e))
        lab = F.deparse(t)
        if is_factor(v) or (isinstance(v, Vec) and v.type == "character"):
            f_ = v if is_factor(v) else B.make_factor(v)
            lv = getattr_(f_, "levels").v
            xlevels[lab] = lv
            for k in range(1, len(lv)):
                cols.append([1.0 if c == k + 1 else 0.0 for c in f_.v])
                names.append(lab + lv[k])
        elif isinstance(v, Vec) and v.type == "logical":
            cols.append([1.0 if c else 0.0 for c in v.v])
            names.append(lab + "TRUE")
        else:
            cols.append(as_double(v).v)
            names.append(lab)
        if n is None:
            n = len(cols[-1])
    if icpt:
        cols.insert(0, [1.0] * n)
        names.insert(0, "(Intercept)")
    return y, cols, names, xlevels, expanded, icpt


def qr_solve(cols, y, w=None):
    """Least squares by Householder QR; returns (coef, resid, fitted, XtX^{-1}) for the columns."""
    n, p = len(y), len(cols)
    if w is not None:
        sw = [math.sqrt(e) for e in w]
        A = [[cols[j][i] * sw[i] for j in range(p)] for i in range(n)]
        b = [y[i] * sw[i] for i in range(n)]
    else:
        A = [[cols[j][i] for j in range(p)] for i in range(n)]
        b = list(y)
    R = [row[:] for row in A]
    qtb = b[:]
    for k in range(p):
        norm = math.sqrt(math.fsum(R[i][k] ** 2 for i in range(k, n)))
        if norm == 0:
            raise RError("singular fit: the Rill spike does not drop aliased coefficients")
        alpha = -norm if R[k][k] >= 0 else norm
        v = [0.0] * n
        v[k] = R[k][k] - alpha
        for i in range(k + 1, n):
            v[i] = R[i][k]
        vv = math.fsum(e * e for e in v[k:])
        if vv == 0:
            continue
        for j in range(k, p):
            s = math.fsum(v[i] * R[i][j] for i in range(k, n)) * 2 / vv
            for i in range(k, n):
                R[i][j] -= s * v[i]
        s = math.fsum(v[i] * qtb[i] for i in range(k, n)) * 2 / vv
        for i in range(k, n):
            qtb[i] -= s * v[i]
    coef = [0.0] * p
    for k in range(p - 1, -1, -1):
        coef[k] = (qtb[k] - math.fsum(R[k][j] * coef[j] for j in range(k + 1, p))) / R[k][k]
    # (R'R)^{-1} = R^{-1} R^{-T}
    Rinv = [[0.0] * p for _ in range(p)]
    for j in range(p):
        for i in range(j, -1, -1):
            s = (1.0 if i == j else 0.0) - math.fsum(R[i][k] * Rinv[k][j] for k in range(i + 1, j + 1))
            Rinv[i][j] = s / R[i][i]
    XtXi = [[math.fsum(Rinv[i][k] * Rinv[j][k] for k in range(p)) for j in range(p)] for i in range(p)]
    fitted = [math.fsum(cols[j][i] * coef[j] for j in range(p)) for i in range(n)]
    resid = [y[i] - fitted[i] for i in range(n)]
    return coef, resid, fitted, XtXi


def row_names_of(data, n):
    if data is not None and is_df(data):
        return F.df_rownames(data)
    return [str(i + 1) for i in range(n)]


def lst(**kw):
    names = list(kw)
    return RList([kw[k] for k in names], {"names": mk_chr(names)})


@builtin("lm", special=True)
def _lm(call, env):
    args = C.eval_args(call.args, env)
    m = match_spec(args, "formula, data, subset, weights, na.action, ...")
    C.STATE["visible"] = True
    f = m["formula"]
    data = m.get("data")
    y, cols, names, xlevels, terms, icpt = design(f, data, env)
    coef, resid, fitted, XtXi = qr_solve(cols, y.v)
    rn = row_names_of(data, len(y.v))
    fit = lst(coefficients=named(coef, names), residuals=named(resid, rn), **{"fitted.values": named(fitted, rn)},
              rank=mk_int([len(coef)]), **{"df.residual": mk_int([len(y.v) - len(coef)])},
              call=matched(call, "formula, data, subset, weights, na.action, ..."), terms=f)
    fit.attrs["class"] = mk_chr(["lm"])
    fit.attrs[".rill"] = {"XtXi": XtXi, "y": y.v, "icpt": icpt, "terms": terms, "data": data, "xlevels": xlevels, "env": env}
    return fit


def matched(call, spec):
    names = [s.strip() for s in spec.split(",")]
    m = C.match_formals(names, [(n, a) for n, a in call.args])
    args = []
    for n in names:
        if n == "...":
            args.extend(m.get("...", []))
        elif n in m:
            args.append((n, m[n]))
    return Call(call.fn, args)


def fit_info(fit):
    return fit.attrs[".rill"]


@builtin("coef|coefficients")
def _coef(args, env):
    x = args[0][1]
    if C.inherits(x, "summary.lm") or C.inherits(x, "summary.glm"):
        return B.dollar(x, "coefficients")
    return B.dollar(x, "coefficients")


@builtin("residuals|resid")
def _resid(args, env):
    return B.dollar(args[0][1], "residuals")


@builtin("fitted|fitted.values")
def _fitted(args, env):
    return B.dollar(args[0][1], "fitted.values")


@builtin("formula")
def _formula(args, env):
    x = args[0][1]
    if isinstance(x, RList):
        return B.dollar(x, "terms")
    return x


@builtin("confint")
def _confint(args, env):
    m = match_spec(args, "object, parm, level, ...")
    fit = m["object"]
    level = num1(m["level"]) if "level" in m else 0.95
    s = lm_summary(fit)
    cm = B.dollar(s, "coefficients")
    p = getattr_(cm, "dim").v[0]
    rdf = B.dollar(s, "df").v[1]
    q = qt(1 - (1 - level) / 2, rdf)
    lo = [cm.v[i] - q * cm.v[p + i] for i in range(p)]
    hi = [cm.v[i] + q * cm.v[p + i] for i in range(p)]
    a = (1 - level) / 2
    cn = [F.format_real([100 * a], 3)[0] + " %", F.format_real([100 * (1 - a)], 3)[0] + " %"]
    return mk_dbl(lo + hi, {"dim": mk_int([p, 2]), "dimnames": RList([getattr_(cm, "dimnames").v[0], mk_chr(cn)])})


@builtin("boxplot.stats")
def _bpstats(args, env):
    m = match_spec(args, "x, coef, do.conf, do.out")
    v = [e for e in dbl_values(m["x"]) if e is not None]
    coef = num1(m["coef"]) if "coef" in m else 1.5
    st = _fivenum([(None, mk_dbl(v))], env).v
    iqr = st[3] - st[1]
    outl = [e for e in v if coef > 0 and (e < st[1] - coef * iqr or e > st[3] + coef * iqr)]
    inside = [e for e in v if e not in outl]
    st = [min(inside), st[1], st[2], st[3], max(inside)]
    n = len(v)
    conf = [st[2] - 1.58 * iqr / math.sqrt(n), st[2] + 1.58 * iqr / math.sqrt(n)]
    return lst(stats=mk_dbl(st), n=mk_dbl([float(n)]), conf=mk_dbl(conf), out=mk_dbl(outl))


@builtin("I")
def _I(args, env):
    x = shallow(args[0][1])
    cl = getattr_(x, "class")
    setattr_(x, "class", mk_chr(["AsIs"] + (list(cl.v) if cl is not NULL else [])))
    return x


@method("print.AsIs")
def _print_asis(args, env):
    x = shallow(args[0][1])
    cl = [c for c in getattr_(x, "class").v if c != "AsIs"]
    setattr_(x, "class", mk_chr(cl) if cl else NULL)
    F.print_generic(x, env)
    C.STATE["visible"] = False
    return args[0][1]


@builtin("predict")
def _predict(args, env):
    m = match_spec(args, "object, newdata, ...")
    fit = m["object"]
    if "newdata" not in m:
        return B.dollar(fit, "fitted.values")
    info = fit_info(fit)
    nd = m["newdata"]
    e = B.data_env(nd, info["env"])
    coef = B.dollar(fit, "coefficients").v
    cols = [] if not info["icpt"] else None
    n = F.df_nrow(nd)
    X = [[1.0] * n] if info["icpt"] else []
    for t in info["terms"]:
        v = C.force(C.ev(t, e))
        lab = F.deparse(t)
        if lab in info["xlevels"]:
            lv = info["xlevels"][lab]
            s = as_type(v, "character").v
            for k in range(1, len(lv)):
                X.append([1.0 if c == lv[k] else 0.0 for c in s])
        else:
            X.append(as_double(v).v)
    pred = [math.fsum(X[j][i] * coef[j] for j in range(len(coef))) for i in range(n)]
    return named(pred, F.df_rownames(nd))


@method("print.lm")
def _print_lm(args, env):
    x = args[0][1]
    out("\nCall:\n" + F.deparse_lines(B.dollar(x, "call")) + "\n\n")
    coef = B.dollar(x, "coefficients")
    out("Coefficients:\n")
    F.print_named(F.format_real(coef.v, 4), names_of(coef), gap=2)
    out("\n")
    C.STATE["visible"] = False
    return x


def stars(p):
    if p is None:
        return ""
    if p < 0.001:
        return "***"
    if p < 0.01:
        return "**"
    if p < 0.05:
        return "*"
    if p < 0.1:
        return "."
    return ""


def coefmat(rows, names, coln, has_p=True):
    """printCoefmat-style table: rows of (est, se, stat, p)."""
    est = [r[0] for r in rows]
    se = [r[1] for r in rows]
    tv = [r[2] for r in rows]
    pv = [r[3] for r in rows]
    es = F.format_real(est + se, 4)
    ce, cs = es[:len(rows)], es[len(rows):]
    ct = F.format_real([round(t, 3) for t in tv], 4)
    cp = format_pvals(pv, 3)
    st = [stars(p) for p in pv]
    sw = max(len(s) for s in st)
    table = [ce, cs, ct, cp]
    widths = [max([len(coln[j])] + [len(s) for s in table[j]]) for j in range(4)]
    rw = max(len(n) for n in names)
    hdr = " " * rw + "".join(" " + coln[j].rjust(widths[j]) for j in range(4))
    if sw:
        hdr += " " + "".ljust(sw)
    out(hdr + "\n")
    for i, nm in enumerate(names):
        line = nm.ljust(rw) + "".join(" " + table[j][i].rjust(widths[j]) for j in range(4))
        if sw:
            line += " " + st[i].ljust(sw)
        out(line + "\n")
    if sw:
        out("---\nSignif. codes:  0 ‘***’ 0.001 ‘**’ 0.01 ‘*’ 0.05 ‘.’ 0.1 ‘ ’ 1\n")


def lm_summary(fit):
    info = fit_info(fit)
    coef = B.dollar(fit, "coefficients")
    res = B.dollar(fit, "residuals")
    n, p = len(res.v), len(coef.v)
    rdf = n - p
    rss = math.fsum(e * e for e in res.v)
    sigma = math.sqrt(rss / rdf)
    se = [sigma * math.sqrt(info["XtXi"][i][i]) for i in range(p)]
    tv = [c / s for c, s in zip(coef.v, se)]
    pv = [2 * pt(-abs(t), rdf)[0] for t in tv]
    y = info["y"]
    fitted = B.dollar(fit, "fitted.values").v
    if info["icpt"]:
        my = r_mean(y)
        mss = math.fsum((f - my) ** 2 for f in fitted)
        dfi = 1
    else:
        mss = math.fsum(f * f for f in fitted)
        dfi = 0
    r2 = mss / (mss + rss)
    adj = 1 - (1 - r2) * ((n - dfi) / rdf)
    numdf = p - dfi
    fstat = (mss / numdf) / (rss / rdf)
    cm = mk_dbl(coef.v + se + tv + pv, {"dim": mk_int([p, 4]), "dimnames": RList([getattr_(coef, "names"),
                                                                                  mk_chr(["Estimate", "Std. Error", "t value", "Pr(>|t|)"])])})
    s = lst(call=B.dollar(fit, "call"), residuals=res, coefficients=cm, sigma=mk_dbl([sigma]),
            df=mk_int([p, rdf, p]), **{"r.squared": mk_dbl([r2]), "adj.r.squared": mk_dbl([adj]),
                                      "fstatistic": named([fstat, float(numdf), float(rdf)], ["value", "numdf", "dendf"])})
    s.attrs["class"] = mk_chr(["summary.lm"])
    return s


@method("summary.lm")
def _summary_lm(args, env):
    return lm_summary(args[0][1])


@method("print.summary.lm")
def _print_summary_lm(args, env):
    s = args[0][1]
    g = lambda k: B.dollar(s, k)
    out("\nCall:\n" + F.deparse_lines(g("call")) + "\n\n")
    res = g("residuals")
    rdf = g("df").v[1]
    out("Residuals:\n")
    if rdf > 5:
        q = sorted(res.v)
        qs = [quantile7(q, p) for p in (0, 0.25, 0.5, 0.75, 1)]
        qs = zapsmall(qs, 5)
        strs = F.format_real(qs, 4)
        F.print_named(strs, ["Min", "1Q", "Median", "3Q", "Max"])
    else:
        F.print_named(F.format_real(res.v, 4), names_of(res))
    out("\n")
    cm = g("coefficients")
    p = getattr_(cm, "dim").v[0]
    rows = [(cm.v[i], cm.v[p + i], cm.v[2 * p + i], cm.v[3 * p + i]) for i in range(p)]
    out("Coefficients:\n")
    coefmat(rows, getattr_(cm, "dimnames").v[0].v, ["Estimate", "Std. Error", "t value", "Pr(>|t|)"])
    sigma = g("sigma").v[0]
    out("\nResidual standard error: %s on %d degrees of freedom\n" % (F.format_real([sigma], 4)[0], rdf))
    fs = g("fstatistic").v
    out("Multiple R-squared:  %s,\tAdjusted R-squared:  %s \n" % ("%.4g" % g("r.squared").v[0], "%.4g" % g("adj.r.squared").v[0]))
    fp = pf(fs[0], fs[1], fs[2])[1]
    fps = format_pval(fp, 4)
    out("F-statistic: %s on %d and %d DF,  p-value: %s\n" % (("%.4g" % fs[0]).rjust(5), fs[1], fs[2], fps))
    out("\n")
    C.STATE["visible"] = False
    return s


def zapsmall(v, digits):
    mx = max(abs(e) for e in v)
    if mx == 0:
        return v
    d = max(0, digits - int(math.ceil(math.log10(mx))))
    return [round(e, d) for e in v]


@builtin("anova")
def _anova(args, env):
    fit = args[0][1]
    info = fit_info(fit)
    res = B.dollar(fit, "residuals").v
    y = info["y"]
    n = len(y)
    rss = math.fsum(e * e for e in res)
    my = r_mean(y)
    tss = math.fsum((e - my) ** 2 for e in y)
    p = len(B.dollar(fit, "coefficients").v)
    rdf = n - p
    ss = tss - rss
    df1 = p - 1
    ms = ss / df1
    mse = rss / rdf
    fv = ms / mse
    pv = pf(fv, df1, rdf)[1]
    term = F.deparse(info["terms"][0]) if info["terms"] else "x"
    resp = F.deparse(B.dollar(fit, "terms").args[0][1])
    out("Analysis of Variance Table\n\nResponse: %s\n" % resp)
    cols = [[str(df1), str(rdf)], F.format_real(zapsmall([ss, rss], 5), 5), F.format_real(zapsmall([ms, mse], 5), 5),
            [F.format_real([fv], 5)[0], ""], [format_pval(pv, 4), ""]]
    hdr = ["Df", "Sum Sq", "Mean Sq", "F value", "Pr(>F)"]
    rn = [term, "Residuals"]
    rw = max(len(r) for r in rn)
    widths = [max(len(hdr[j]), max(len(s) for s in cols[j])) for j in range(5)]
    st = [stars(pv), ""]
    sw = max(len(s) for s in st)
    out(" " * rw + "".join(" " + hdr[j].rjust(widths[j]) for j in range(5)) + (" " + " " * sw if sw else "") + "\n")
    for i in range(2):
        out(rn[i].ljust(rw) + "".join(" " + cols[j][i].rjust(widths[j]) for j in range(5)) + (" " + st[i].ljust(sw) if sw else "") + "\n")
    if sw:
        out("---\nSignif. codes:  0 ‘***’ 0.001 ‘**’ 0.01 ‘*’ 0.05 ‘.’ 0.1 ‘ ’ 1\n")
    C.STATE["visible"] = False
    return NULL


# glm -----------------------------------------------------------------------------------

FAMILIES = {
    "binomial": dict(link=lambda mu: math.log(mu / (1 - mu)), inv=lambda eta: 1 / (1 + math.exp(-eta)),
                     dmu=lambda eta: math.exp(-eta) / (1 + math.exp(-eta)) ** 2, var=lambda mu: mu * (1 - mu),
                     start=lambda y: (y + 0.5) / 2,
                     dev=lambda y, mu: 2 * ((y * math.log(y / mu) if y > 0 else 0) + ((1 - y) * math.log((1 - y) / (1 - mu)) if y < 1 else 0)),
                     aic=lambda y, mu, dev: -2 * math.fsum(math.log(m if v == 1 else 1 - m) for v, m in zip(y, mu)), disp=False),
    "poisson": dict(link=math.log, inv=math.exp, dmu=math.exp, var=lambda mu: mu, start=lambda y: y + 0.1,
                    dev=lambda y, mu: 2 * ((y * math.log(y / mu) if y > 0 else 0) - (y - mu)),
                    aic=lambda y, mu, dev: -2 * math.fsum(v * math.log(m) - m - math.lgamma(v + 1) for v, m in zip(y, mu)), disp=False),
    "gaussian": dict(link=lambda mu: mu, inv=lambda eta: eta, dmu=lambda eta: 1.0, var=lambda mu: 1.0, start=lambda y: y,
                     dev=lambda y, mu: (y - mu) ** 2, aic=None, disp=True),
}


@builtin("binomial|poisson|gaussian", special=True)
def _family(call, env):
    return mk_chr([call.fn.name], {"class": mk_chr(["family"])})


@builtin("glm", special=True)
def _glm(call, env):
    args = C.eval_args(call.args, env)
    m = match_spec(args, "formula, family, data, weights, subset, ...")
    C.STATE["visible"] = True
    fam = m.get("family", mk_chr(["gaussian"]))
    if isinstance(fam, Builtin):
        fam = mk_chr([fam.name])
    fname = str1(fam)
    F_ = FAMILIES[fname]
    data = m.get("data")
    y, cols, names, xlevels, terms, icpt = design(m["formula"], data, env)
    yv = y.v
    n = len(yv)
    mu = [F_["start"](e) for e in yv]
    eta = [F_["link"](e) for e in mu]
    devold = math.fsum(F_["dev"](a, b) for a, b in zip(yv, mu))
    it = 0
    coef = None
    for it in range(1, 26):
        dm = [F_["dmu"](e) for e in eta]
        z = [e + (a - b) / d for e, a, b, d in zip(eta, yv, mu, dm)]
        w = [d * d / F_["var"](b) for d, b in zip(dm, mu)]
        coef, _, _, XtXi = qr_solve(cols, z, w)
        eta = [math.fsum(cols[j][i] * coef[j] for j in range(len(coef))) for i in range(n)]
        mu = [F_["inv"](e) for e in eta]
        dev = math.fsum(F_["dev"](a, b) for a, b in zip(yv, mu))
        if abs(dev - devold) / (abs(dev) + 0.1) < 1e-8:
            break
        devold = dev
    dm = [F_["dmu"](e) for e in eta]
    my = r_mean(yv)
    if icpt:
        nulldev = math.fsum(F_["dev"](a, my) for a in yv)
    else:
        nulldev = math.fsum(F_["dev"](a, F_["inv"](0.0)) for a in yv)
    p = len(coef)
    aic = (F_["aic"](yv, mu, dev) + 2 * p) if F_["aic"] else None
    rn = row_names_of(data, n)
    fit = lst(coefficients=named(coef, names), residuals=named([(a - b) / d for a, b, d in zip(yv, mu, dm)], rn),
              **{"fitted.values": named(mu, rn)}, rank=mk_int([p]), deviance=mk_dbl([dev]), aic=mk_dbl([aic if aic is not None else math.nan]),
              **{"null.deviance": mk_dbl([nulldev]), "iter": mk_int([it]), "df.residual": mk_int([n - p]),
                 "df.null": mk_int([n - (1 if icpt else 0)])}, call=matched(call, "formula, family, data, weights, subset, ..."),
              terms=m["formula"])
    fit.attrs["class"] = mk_chr(["glm", "lm"])
    fit.attrs[".rill"] = {"XtXi": XtXi, "y": yv, "icpt": icpt, "terms": terms, "data": data, "xlevels": xlevels, "env": env, "family": fname}
    return fit


@method("print.glm")
def _print_glm(args, env):
    x = args[0][1]
    g = lambda k: B.dollar(x, k)
    out("\nCall:  " + F.deparse_lines(g("call")) + "\n\n")
    coef = g("coefficients")
    out("Coefficients:\n")
    F.print_named(F.format_real(coef.v, 4), names_of(coef), gap=2)
    out("\nDegrees of Freedom: %d Total (i.e. Null);  %d Residual\n" % (g("df.null").v[0], g("df.residual").v[0]))
    nd, rd, aic = g("null.deviance").v[0], g("deviance").v[0], g("aic").v[0]
    s4 = lambda v: F.format_real([float("%.4g" % v)], 7)[0]
    out("Null Deviance:\t    %s \nResidual Deviance: %s \tAIC: %s\n" % (s4(nd), s4(rd), s4(aic)))
    C.STATE["visible"] = False
    return x


@method("summary.glm")
def _summary_glm(args, env):
    x = args[0][1]
    s = shallow(x)
    s.attrs["class"] = mk_chr(["summary.glm"])
    return s


@method("print.summary.glm")
def _print_summary_glm(args, env):
    x = args[0][1]
    g = lambda k: B.dollar(x, k)
    info = x.attrs[".rill"]
    out("\nCall:\n" + F.deparse_lines(g("call")) + "\n\n")
    coef = g("coefficients")
    se = [math.sqrt(info["XtXi"][i][i]) for i in range(len(coef.v))]
    zv = [c / s for c, s in zip(coef.v, se)]
    pv = [2 * norm_cdf(-abs(z)) for z in zv]
    out("Coefficients:\n")
    coefmat(list(zip(coef.v, se, zv, pv)), names_of(coef), ["Estimate", "Std. Error", "z value", "Pr(>|z|)"])
    out("\n(Dispersion parameter for %s family taken to be 1)\n\n" % info["family"])
    devs = F.format_real([g("null.deviance").v[0], g("deviance").v[0]], 5)
    dfs = [str(g("df.null").v[0]), str(g("df.residual").v[0])]
    dw = max(len(d) for d in dfs)
    out("    Null deviance: %s  on %s  degrees of freedom\n" % (devs[0], dfs[0].rjust(dw)))
    out("Residual deviance: %s  on %s  degrees of freedom\n" % (devs[1], dfs[1].rjust(dw)))
    out("AIC: %s\n\n" % F.format_real([g("aic").v[0]], 5)[0])
    out("Number of Fisher Scoring iterations: %d\n\n" % g("iter").v[0])
    C.STATE["visible"] = False
    return x


@builtin("aggregate", special=True)
def _aggregate(call, env):
    args = C.eval_args(call.args, env)
    m = match_spec(args, "x, data, FUN, ...")
    C.STATE["visible"] = True
    f = m["x"]
    data = m["data"]
    e = B.data_env(data, env)
    lhs, terms, _ = formula_parts(f)
    y = C.force(C.ev(lhs, e))
    g = C.force(C.ev(terms[0], e))
    fac = g if is_factor(g) else B.make_factor(g)
    lv = getattr_(fac, "levels").v
    fun = B.match_fun(m["FUN"], env)
    vals = []
    for k in range(len(lv)):
        sel = [i + 1 for i, c in enumerate(fac.v) if c == k + 1]
        vals.append(C.call_fun(fun, [(None, B.subset_vec(y, mk_int(sel)))] + m["..."], env))
    gcol = mk_chr(lv) if not is_factor(g) else B.make_factor(mk_chr(lv), mk_chr(lv))
    if isinstance(g, Vec) and g.type in ("double", "integer") and not is_factor(g):
        gcol = as_type(mk_chr(lv), g.type)
    return B.df_new([gcol, B.combine([(None, v) for v in vals])], [F.deparse(terms[0]), F.deparse(lhs)])


# ---------------------------------------------------------------- datasets

def _datasets():
    import _rill_data as D
    cols = [mk_dbl([r[j] for r in D.MTCARS]) for j in range(len(D.MTCARS_COLS))]
    mt = B.df_new(cols, D.MTCARS_COLS, D.MTCARS_ROWS)
    icols = [mk_dbl([r[j] for r in D.IRIS]) for j in range(4)]
    icols.append(B.make_factor(mk_chr([r[4] for r in D.IRIS])))
    ir = B.df_new(icols, D.IRIS_COLS)
    return mt, ir


def _install_data():
    p1 = C.Promise(Call(Sym(".rill_data"), [(None, Const(mk_int([0])))]), C.BASE)
    p2 = C.Promise(Call(Sym(".rill_data"), [(None, Const(mk_int([1])))]), C.BASE)
    C.BASE.vars["mtcars"] = p1
    C.BASE.vars["iris"] = p2


_DATA = []


@builtin(".rill_data")
def _rill_data(args, env):
    if not _DATA:
        _DATA.extend(_datasets())
    return _DATA[int1(args[0][1])]


_install_data()
