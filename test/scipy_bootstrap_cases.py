# scipy.stats.bootstrap (SciPy 1.18; test/stats_oracle_gen.py records SciPy's results into test/stats-oracle.json):
# each case leaves `out` = [low, high, standard_error, the bootstrap
# distribution's first values and its length, its sha] or the error.  Made-up data.
DATA = r'''
X = np.array([2.1, 3.4, 1.9, 5.6, 4.4, 3.3, 2.8, 6.1, 3.9, 4.7, 2.2, 3.8])
Y = np.array([3.0, 4.1, 2.5, 6.0, 5.2, 4.0, 3.1, 6.8, 4.5, 5.9, 2.9, 4.6])
Z = np.array([1.0, 1.0, 2.0, 2.0, 2.0, 3.0, 5.0, 8.0])
'''
PRELUDE = r'''
import hashlib
import numpy as np
from scipy import stats
def res(r):
    d = np.asarray(r.bootstrap_distribution, dtype=float)
    lo, hi = r.confidence_interval
    return [np.asarray(lo, dtype=float).tolist(), np.asarray(hi, dtype=float).tolist(),
            np.asarray(r.standard_error, dtype=float).tolist(), d.ravel()[:5].tolist(), list(d.shape),
            hashlib.sha256(np.ascontiguousarray(d).tobytes()).hexdigest()[:16]]
'''
CASES = [
    ("bca-mean-rng", "out = res(stats.bootstrap((X,), np.mean, n_resamples=999, rng=1))"),
    ("percentile-mean-rng", "out = res(stats.bootstrap((X,), np.mean, n_resamples=999, rng=2, method='percentile'))"),
    ("basic-mean-rng", "out = res(stats.bootstrap((X,), np.mean, n_resamples=999, rng=3, method='basic'))"),
    ("bca-std-unvectorized", "out = res(stats.bootstrap((X,), lambda x: float(np.std(x, ddof=1)), n_resamples=299, rng=4))"),
    ("bca-median", "out = res(stats.bootstrap((Z,), np.median, n_resamples=499, rng=5))"),
    ("random-state-legacy", "out = res(stats.bootstrap((X,), np.mean, n_resamples=499, random_state=6))"),
    ("generator-object", "g = np.random.default_rng(7); out = res(stats.bootstrap((X,), np.mean, n_resamples=499, rng=g)) + [int(g.integers(0, 10**9))]"),
    ("two-sample-diff", "out = res(stats.bootstrap((X, Y), lambda a, b, axis=-1: np.mean(a, axis=axis) - np.mean(b, axis=axis), n_resamples=499, rng=8))"),
    ("paired-diff", "out = res(stats.bootstrap((X, Y), lambda a, b, axis=-1: np.mean(a - b, axis=axis), n_resamples=499, rng=9, paired=True))"),
    ("cl-90-less", "out = res(stats.bootstrap((X,), np.mean, n_resamples=499, rng=10, confidence_level=0.9, alternative='less'))"),
    ("greater-percentile", "out = res(stats.bootstrap((X,), np.mean, n_resamples=499, rng=11, alternative='greater', method='percentile'))"),
    ("batch", "out = res(stats.bootstrap((X,), np.mean, n_resamples=500, rng=12, batch=128))"),
    # (2-D data: the whole distribution recorded, each value compared, since its hash may differ, NumPy summing a
    #  strided resample in another order)
    ("axis-2d", "M = np.vstack([X, Y]); r = stats.bootstrap((M,), np.mean, n_resamples=199, rng=13, axis=1); out = res(r) + [np.asarray(r.bootstrap_distribution, dtype=float).ravel().tolist()]"),
    ("axis-0-columns", "M = np.column_stack([X, Y]); r = stats.bootstrap((M,), np.mean, n_resamples=199, rng=14, axis=0); out = res(r) + [np.asarray(r.bootstrap_distribution, dtype=float).ravel().tolist()]"),
    ("reuse-result", "r = stats.bootstrap((X,), np.mean, n_resamples=200, rng=15); out = res(stats.bootstrap((X,), np.mean, n_resamples=100, rng=16, bootstrap_result=r))"),
    ("reuse-zero-new", "r = stats.bootstrap((X,), np.mean, n_resamples=200, rng=17); out = res(stats.bootstrap((X,), np.mean, n_resamples=0, rng=18, bootstrap_result=r, method='percentile', confidence_level=0.8))"),
    ("list-data", "out = res(stats.bootstrap(([1, 2, 3, 4, 6, 9],), np.mean, n_resamples=199, rng=19))"),
    ("tuple-fields", "r = stats.bootstrap((X,), np.mean, n_resamples=99, rng=20); out = [type(r).__name__, type(r.confidence_interval).__name__, r.confidence_interval._fields if hasattr(r.confidence_interval, '_fields') else None, type(r.standard_error).__name__]"),
    ("err-one-obs", "stats.bootstrap(([1.0],), np.mean, rng=0); out = 0"),
    # (these two messages print a set, whose order varies from run to run in SciPy: compared as its items)
    ("err-method", "try:\n    stats.bootstrap((X,), np.mean, rng=0, method='nope')\nexcept ValueError as e:\n    m = str(e)\n    out = [m[:m.index('{')], sorted(m[m.index('{') + 1:-1].split(', '))]"),
    ("err-alternative", "try:\n    stats.bootstrap((X,), np.mean, rng=0, alternative='up')\nexcept ValueError as e:\n    m = str(e)\n    out = [m[:m.index('{')], sorted(m[m.index('{') + 1:-1].split(', '))]"),
    ("err-nresamples", "stats.bootstrap((X,), np.mean, rng=0, n_resamples=-1); out = 0"),
    ("err-paired-len", "stats.bootstrap((X, Y[:5]), lambda a, b, axis=-1: np.mean(a, axis=axis), rng=0, paired=True); out = 0"),
    ("err-array-not-tuple", "try:\n    stats.bootstrap(X, np.mean, rng=0)\nexcept ValueError as e:\n    out = [type(e).__name__, isinstance(e, IndexError), str(e)]"),
    ("err-zero", "stats.bootstrap((X,), np.mean, rng=0, n_resamples=0); out = 0"),
    # (degenerate: NumPy's own 0/0 RuntimeWarning left out, SciPy's warning kept)
    ("degenerate", "import warnings\nwith warnings.catch_warnings(record=True) as w:\n    warnings.simplefilter('always')\n    r = stats.bootstrap((np.ones(6),), np.mean, n_resamples=50, rng=21)\nw = [x for x in w if type(x.message).__name__ != 'RuntimeWarning']\nout = res(r) + [[type(x.message).__name__ for x in w], [str(x.message)[:60] for x in w]]"),
    ("binom-rvs", "out = stats.binom.rvs(20, 0.3, size=8, random_state=22).tolist()"),
]
# (rows from the numeric review: the method's case, a vector statistic, NaN, BCa paired, one resample)
CASES += [
    ("method-case-BCa", "out = res(stats.bootstrap((X,), np.mean, n_resamples=199, rng=41, method='BCa'))"),
    ("method-case-upper", "out = res(stats.bootstrap((X,), np.mean, n_resamples=199, rng=42, method='PERCENTILE'))"),
    ("vector-statistic", "f = lambda x, axis=-1: np.stack([np.mean(x, axis=axis), np.std(x, axis=axis, ddof=1)]); r = stats.bootstrap((X,), f, n_resamples=199, rng=43); out = res(r) + [list(np.shape(r.standard_error))]"),
    ("nan-in-data", "import warnings\nwith warnings.catch_warnings(record=True) as w:\n    warnings.simplefilter('always')\n    r = stats.bootstrap((np.append(X[:6], np.nan),), np.mean, n_resamples=99, rng=44)\nw = [x for x in w if type(x.message).__name__ != 'RuntimeWarning']\nout = res(r) + [[type(x.message).__name__ for x in w]]"),
    ("cl-0999", "out = res(stats.bootstrap((X,), np.mean, n_resamples=999, rng=45, confidence_level=0.999))"),
    ("bca-paired-two", "out = res(stats.bootstrap((X, Y), lambda a, b, axis=-1: np.corrcoef(a, b)[0, 1] if np.ndim(a) == 1 else np.array([np.corrcoef(p, q)[0, 1] for p, q in zip(a, b)]), n_resamples=199, rng=46, paired=True, vectorized=True))"),
    ("one-resample", "out = res(stats.bootstrap((X,), np.mean, n_resamples=1, rng=47, method='percentile'))"),
    ("err-cl", "stats.bootstrap((X,), np.mean, rng=0, confidence_level=1.5); out = 0"),
]
