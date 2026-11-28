# Bunch, resample, shuffle, gen_batches, gen_even_slices and _safe_indexing.
import numpy as np
import pandas as pd
from sklearn.utils import Bunch, resample, shuffle, gen_batches, gen_even_slices, _safe_indexing
from _cases import case


def catch(fn):
    try:
        fn()
    except Exception as e:
        return e

b = Bunch(a=1, b="x")
case("bunch-attr", lambda: (b.a, b["b"]))


def bunch_set():
    b.c = 3
    return sorted(b.items())


case("bunch-set", bunch_set)
case("bunch-missing", lambda: b.zzz)
case("bunch-dir", lambda: [k for k in dir(b) if not k.startswith("_")][:3])

a = np.arange(10)
case("resample", lambda: resample(a, random_state=0))
case("resample-n", lambda: resample(a, n_samples=4, random_state=1))
case("resample-noreplace", lambda: resample(a, replace=False, random_state=2))
case("resample-noreplace-too-many", lambda: resample(a, replace=False, n_samples=11, random_state=2))
case("resample-many", lambda: resample(np.arange(20).reshape(10, 2), list("abcdefghij"), random_state=3))
case("resample-frame", lambda: resample(pd.DataFrame({"v": np.arange(6)}), random_state=4))
case("resample-series", lambda: resample(pd.Series(np.arange(6) * 1.5), n_samples=3, random_state=5))
case("resample-none", lambda: resample())
case("resample-inconsistent", lambda: resample([1, 2], [1, 2, 3]))
case("shuffle", lambda: shuffle(a, random_state=0))
case("shuffle-two", lambda: shuffle(np.arange(8).reshape(4, 2), np.arange(4), random_state=7))
case("shuffle-n", lambda: shuffle(a, n_samples=3, random_state=8))
case("shuffle-list", lambda: shuffle(["x", "y", "z", "w"], random_state=9))
case("batches", lambda: list(gen_batches(7, 3)))
case("batches-min", lambda: list(gen_batches(7, 3, min_batch_size=2)))
case("batches-bad", lambda: list(gen_batches(7, 0)))
case("batches-bad-n", lambda: gen_batches(0, 1))
case("batches-float", lambda: gen_batches(5, 2.0))
case("batches-bad-min", lambda: gen_batches(5, 2, min_batch_size=-1))
case("batches-none", lambda: gen_batches(5, None))
case("batches-bool", lambda: list(gen_batches(True, 2)))
case("batches-error-kinds", lambda: (lambda e: (isinstance(e, ValueError), isinstance(e, TypeError), type(e).__module__))(catch(lambda: gen_batches(0, 1))))
case("even-slices-bad", lambda: gen_even_slices(10, 0))
case("even-slices-bad-samples", lambda: gen_even_slices(10, 2, n_samples=0))
case("even-slices", lambda: list(gen_even_slices(10, 3)))
case("even-slices-samples", lambda: list(gen_even_slices(10, 3, n_samples=4)))
X = np.arange(12).reshape(4, 3)
df = pd.DataFrame(X, columns=["a", "b", "c"])
case("index-rows", lambda: _safe_indexing(X, [2, 0]))
case("index-cols", lambda: _safe_indexing(X, [0, 2], axis=1))
case("index-bool", lambda: _safe_indexing(X, np.array([True, False, True, False])))
case("index-list", lambda: _safe_indexing(list("abcd"), [3, 1]))
case("index-frame-rows", lambda: _safe_indexing(df, [1, 3]))
case("index-frame-cols", lambda: _safe_indexing(df, ["c", "a"], axis=1))
case("index-frame-col", lambda: _safe_indexing(df, "b", axis=1))
case("index-slice", lambda: _safe_indexing(X, slice(1, 3)))
case("index-none", lambda: _safe_indexing(X, None) is X)
case("index-names-on-array", lambda: _safe_indexing(X, ["a"], axis=1))

# weighted resampling: draws in proportion to sample_weight (replace=True only)
case("resample-weighted-one", lambda: resample(np.arange(4), sample_weight=[0.0, 0.0, 1.0, 0.0], random_state=0))
case("resample-weighted", lambda: resample(np.arange(6), sample_weight=[0.1, 0.0, 0.5, 2.0, 0.0, 1.4], n_samples=8, random_state=3))
case("resample-weighted-two-arrays", lambda: resample(np.arange(10).reshape(5, 2), list("abcde"), sample_weight=[1, 0, 0, 3, 1], random_state=7))
case("resample-weighted-noreplace", lambda: resample(np.arange(4), sample_weight=[1.0, 1.0, 1.0, 1.0], replace=False))
case("resample-weighted-length", lambda: resample(np.arange(4), sample_weight=[1.0, 1.0], random_state=0))
# n_samples checked as validate_params checks it: an int of at least 1 (a bool counts, a float or a string doesn't)
# or None, before anything is drawn; shuffle's through resample
for rep in (False, True):
    for n in (-1, 0, 1, 1.5, 2.0, None, np.int64(2), "2"):
        case(f"resample-n-check replace={rep} n={n!r}", lambda: resample([1, 2, 3], replace=rep, n_samples=n, random_state=0))
case("resample-n-check bool", lambda: resample([1, 2, 3], replace=False, n_samples=True, random_state=0))
for n in (-1, 0, 2, None):
    case(f"shuffle-n-check n={n!r}", lambda: shuffle([1, 2, 3], n_samples=n, random_state=0))
