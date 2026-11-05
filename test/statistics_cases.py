# The statistics module (CPython 3.14's Lib/statistics.py) on Sagebrush, compared with what CPython 3.14 prints
# for the same program: every public function, with ints, floats, Fractions and bools, and the errors.  (Decimal
# inputs aren't here: Sagebrush has no decimal module yet.)
import math
import random
import statistics as S
from fractions import Fraction as F


def show(name, f):
    try:
        r = f()
        print(name, type(r).__name__, repr(r))
    except Exception as e:
        print(name, type(e).__name__, e)


data_int = [2, 7, 1, 8, 2, 8, 1, 8, 2, 8]
data_flt = [2.75, 1.75, 1.25, 0.25, 0.5, 1.25, 3.5]
data_frac = [F(1, 2), F(1, 4), F(3, 4), F(5, 4)]
rng = random.Random(7)
data_big = [rng.gauss(100, 15) for _ in range(500)]

for label, d in [("int", data_int), ("flt", data_flt), ("frac", data_frac), ("big", data_big)]:
    for fname in ["mean", "fmean", "geometric_mean", "harmonic_mean", "median", "median_low", "median_high",
                  "median_grouped", "mode", "multimode", "pstdev", "pvariance", "stdev", "variance", "quantiles"]:
        show(label + " " + fname, lambda: getattr(S, fname)(d))

show("median even", lambda: S.median([1, 3, 5, 7]))
show("median_grouped interval", lambda: S.median_grouped([52, 52, 53, 54], interval=2))
show("mode str", lambda: S.mode("aabbbc"))
show("multimode", lambda: S.multimode("aabbbbccddddeeffffgg"))
show("multimode empty", lambda: S.multimode([]))
show("fmean weights", lambda: S.fmean([85, 92, 83, 91], weights=[0.20, 0.20, 0.30, 0.30]))
show("harmonic_mean weights", lambda: S.harmonic_mean([40, 60], weights=[5, 30]))
show("variance xbar", lambda: S.variance([1.5, 2.5, 2.5, 2.75, 3.25, 4.75], xbar=2.875))
show("pvariance mu", lambda: S.pvariance([0.0, 0.25, 0.25, 1.25, 1.5, 1.75, 2.75, 3.25], mu=1.25))
show("quantiles n=10", lambda: S.quantiles(data_big, n=10))
show("quantiles inclusive", lambda: S.quantiles([1, 2, 3, 4, 5], n=4, method="inclusive"))
show("quantiles n=1", lambda: S.quantiles([1, 2], n=1))
show("bool mean", lambda: S.mean([True, False, True]))

x = [1, 2, 3, 4, 5, 6, 7, 8, 9]
y = [1, 2, 3, 1, 2, 3, 1, 2, 3]
show("covariance", lambda: S.covariance(x, y))
show("correlation", lambda: S.correlation(x, y))
show("correlation ranked", lambda: S.correlation(x, [9, 8, 7, 6, 5, 4, 3, 2, 1], method="ranked"))
show("linear_regression", lambda: S.linear_regression(x, [2 * v + 1 for v in x]))
show("linear_regression proportional", lambda: S.linear_regression([1, 2, 3], [2, 4, 6.5], proportional=True))
show("correlation constant", lambda: S.correlation([1, 1, 1], [1, 2, 3]))

nd = S.NormalDist(100, 15)
show("nd", lambda: nd)
show("nd cdf", lambda: nd.cdf(130))
show("nd pdf", lambda: nd.pdf(100))
show("nd inv_cdf", lambda: nd.inv_cdf(0.975))
show("nd quantiles", lambda: nd.quantiles(4))
show("nd overlap", lambda: nd.overlap(S.NormalDist(110, 10)))
show("nd zscore", lambda: nd.zscore(70))
show("nd add", lambda: nd + 10)
show("nd mul", lambda: nd * 2)
show("nd sum", lambda: nd + S.NormalDist(1, 2))
show("nd from_samples", lambda: S.NormalDist.from_samples([2.5, 3.1, 2.1, 2.4, 2.7, 3.5]))
show("nd samples", lambda: S.NormalDist(0, 1).samples(3, seed=42))
show("nd eq", lambda: S.NormalDist(1, 2) == S.NormalDist(1, 2))
show("nd median mode var", lambda: (nd.median, nd.mode, nd.variance, nd.stdev))

show("kde", lambda: [round(S.kde([1, 2, 3], h=1.5)(v), 12) for v in (0, 1.5, 3)])
show("kde cumulative", lambda: [round(S.kde([1, 2, 3], h=1.5, cumulative=True)(v), 12) for v in (0, 2, 4)])
show("kde_random", lambda: [round(v, 9) for v in (lambda r: [r() for _ in range(3)])(S.kde_random([1, 2, 3], h=1.5, seed=3))])

for name, f in [
    ("mean empty", lambda: S.mean([])),
    ("median empty", lambda: S.median([])),
    ("mode empty", lambda: S.mode([])),
    ("stdev one", lambda: S.stdev([1])),
    ("variance one", lambda: S.variance([5])),
    ("geometric_mean negative", lambda: S.geometric_mean([1, -2])),
    ("harmonic_mean negative", lambda: S.harmonic_mean([1, -2])),
    ("quantiles n=0", lambda: S.quantiles([1, 2], n=0)),
    ("quantiles method", lambda: S.quantiles([1, 2], method="other")),
    ("correlation lengths", lambda: S.correlation([1, 2], [1])),
    ("covariance short", lambda: S.covariance([1], [1])),
    ("fmean weights lengths", lambda: S.fmean([1, 2], weights=[1])),
    ("nd negative sigma", lambda: S.NormalDist(0, -1)),
    ("nd inv_cdf 0", lambda: S.NormalDist().inv_cdf(0)),
    ("mean str", lambda: S.mean(["a"])),
    ("mean mixed", lambda: S.mean([1, F(1, 2), 2.5])),
]:
    show(name, f)
print(S.__all__)
print(math.isclose(S.fmean(data_big), sum(data_big) / len(data_big)))
