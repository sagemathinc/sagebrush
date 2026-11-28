# The regression and classification metrics: values to the bit (float.hex),
# arrays, reports, warnings' absence or presence, and the parameter errors.
import warnings

import numpy as np
import pandas as pd
from sklearn.metrics import (accuracy_score, classification_report, confusion_matrix, f1_score, fbeta_score,
                             mean_absolute_error, mean_squared_error, multilabel_confusion_matrix,
                             precision_recall_fscore_support, precision_score, r2_score, recall_score,
                             root_mean_squared_error)
from _cases import case, sorted_sets


def hx(v):
    """A float, or each float of an array or tuple, as float.hex: the exact bits."""
    if isinstance(v, (tuple, list)):
        return [hx(x) for x in v]
    if isinstance(v, np.ndarray):
        if v.dtype.kind == "f":
            return (v.shape, [float(x).hex() for x in v.ravel().tolist()])
        return (str(v.dtype), v.tolist())
    if v is None:
        return None
    return float(v).hex()


def caught(fn):
    """fn's value with the warnings it gives, as (category, message)."""
    def run():
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            value = fn()
        return value, [(x.category.__name__, str(x.message)) for x in w]
    return run


rs = np.random.RandomState(0)
yt = rs.randn(300) * 10 + 3
yp = yt + rs.randn(300)
w = rs.rand(300)
Y2 = rs.randn(40, 3)
P2 = Y2 + rs.randn(40, 3) * 0.5
small_t = [3, -0.5, 2, 7]
small_p = [2.5, 0.0, 2, 8]

# regression
for name, fn in [("r2", r2_score), ("mse", mean_squared_error), ("rmse", root_mean_squared_error),
                 ("mae", mean_absolute_error)]:
    case(name + ".small", lambda: hx(fn(small_t, small_p)))
    case(name + ".n300", lambda: hx(fn(yt, yp)))
    case(name + ".weighted", lambda: hx(fn(yt, yp, sample_weight=w)))
    case(name + ".multi-raw", lambda: hx(fn(Y2, P2, multioutput="raw_values")))
    case(name + ".multi-uniform", lambda: hx(fn(Y2, P2)))
    case(name + ".multi-custom", lambda: hx(fn(Y2, P2, multioutput=[0.2, 0.3, 0.5])))
    case(name + ".ints", lambda: hx(fn([1, 2, 3], [1, 2, 4])))
    case(name + ".series", lambda: hx(fn(pd.Series(small_t), pd.Series(small_p))))
    case(name + ".shape", lambda: fn([[1, 2]], [[1, 2, 3]]))
    case(name + ".length", lambda: fn([1, 2], [1, 2, 3]))
    case(name + ".custom-single", lambda: fn([1, 2], [1, 2], multioutput=[1.0]))
    case(name + ".custom-count", lambda: fn(Y2, P2, multioutput=[1.0, 2.0]))
    case(name + ".nan", lambda: fn([1.0, np.nan], [1.0, 2.0]))
case("r2.variance-weighted", lambda: hx(r2_score(Y2, P2, multioutput="variance_weighted")))
case("r2.variance-weighted-constant", lambda: hx(r2_score([[1, 2], [1, 2]], [[1, 2], [1, 3]], multioutput="variance_weighted")))
case("r2.constant-true", lambda: hx(r2_score([2, 2, 2], [2, 2, 3])))
case("r2.constant-exact", lambda: hx(r2_score([2, 2, 2], [2, 2, 2])))
case("r2.constant-not-finite", lambda: hx(r2_score([2, 2, 2], [2, 2, 3], force_finite=False)))
case("r2.one-sample", caught(lambda: hx(r2_score([1.0], [2.0]))))
case("r2.multioutput-none", lambda: hx(r2_score(Y2, P2, multioutput=None)))
case("r2.perfect", lambda: hx(r2_score(yt, yt)))

# classification
a = [0, 1, 2, 2, 1, 0, 2, 1, 1, 0]
b = [0, 2, 2, 2, 1, 0, 1, 1, 0, 0]
s_a = ["cat", "dog", "bird", "bird", "dog", "cat", "bird", "dog", "dog", "cat"]
s_b = ["cat", "bird", "bird", "bird", "dog", "cat", "dog", "dog", "cat", "cat"]
bin_t = [0, 1, 1, 0, 1, 1, 0, 0]
bin_p = [0, 1, 0, 0, 1, 1, 1, 0]
wc = [0.5, 1.0, 2.0, 1.0, 0.25, 1.0, 3.0, 1.0, 0.5, 2.0]
case("acc", lambda: hx(accuracy_score(a, b)))
case("acc.count", lambda: hx(accuracy_score(a, b, normalize=False)))
case("acc.weighted", lambda: hx(accuracy_score(a, b, sample_weight=wc)))
case("acc.weighted-count", lambda: hx(accuracy_score(a, b, normalize=False, sample_weight=wc)))
case("acc.strings", lambda: hx(accuracy_score(s_a, s_b)))
case("acc.str-series", lambda: hx(accuracy_score(pd.Series(s_a), np.array(s_b))))
case("acc.float-labels", lambda: hx(accuracy_score([1.0, 2.0, 3.0], [1.0, 2.0, 2.0])))
case("acc.bool", lambda: hx(accuracy_score([True, False, True], [True, True, True])))
case("acc.mixed-types", lambda: accuracy_score([1, 2, 3], ["1", "2", "3"]))
case("acc.continuous", lambda: accuracy_score([0.5, 1.0], [0.5, 1.0]))
case("acc.mix-binary-continuous", lambda: accuracy_score([0, 1], [0.5, 1.0]))
case("acc.empty", lambda: accuracy_score([], []))
case("acc.length", lambda: accuracy_score([1, 2], [1]))
case("acc.multioutput", lambda: accuracy_score([[1, 2], [3, 4]], [[1, 2], [3, 4]]))

case("cm", lambda: hx(confusion_matrix(a, b)))
case("cm.strings", lambda: hx(confusion_matrix(s_a, s_b)))
case("cm.labels", lambda: hx(confusion_matrix(s_a, s_b, labels=["dog", "cat"])))
case("cm.labels-extra", lambda: hx(confusion_matrix(a, b, labels=[2, 0, 1, 5])))
case("cm.labels-none-in-true", lambda: confusion_matrix(a, b, labels=[7]))
case("cm.labels-empty", lambda: confusion_matrix(a, b, labels=[]))
case("cm.weighted", lambda: hx(confusion_matrix(a, b, sample_weight=wc)))
case("cm.int-weights", lambda: hx(confusion_matrix(a, b, sample_weight=[1, 2, 3, 1, 1, 1, 1, 1, 1, 2])))
for norm in ("true", "pred", "all"):
    case("cm.normalize-" + norm, lambda: hx(confusion_matrix(a, b, normalize=norm)))
case("cm.normalize-zero-row", lambda: hx(confusion_matrix([0, 0, 1], [0, 0, 0], labels=[0, 1, 2], normalize="true")))
case("cm.single", caught(lambda: hx(confusion_matrix([1, 1], [1, 1]))))
case("cm.negative-labels", lambda: hx(confusion_matrix([-1, 1, 1], [1, 1, -1])))
case("cm.series", lambda: hx(confusion_matrix(pd.Series(a), pd.Series(b))))
case("mcm", lambda: hx(multilabel_confusion_matrix(a, b)))
case("mcm.labels", lambda: hx(multilabel_confusion_matrix(a, b, labels=[2, 0])))
case("mcm.weighted", lambda: hx(multilabel_confusion_matrix(s_a, s_b, sample_weight=wc)))
case("mcm.samplewise", lambda: multilabel_confusion_matrix(a, b, samplewise=True))

for avg in (None, "micro", "macro", "weighted"):
    case("prfs.%s" % avg, lambda: hx(precision_recall_fscore_support(a, b, average=avg)))
    case("prfs.strings.%s" % avg, lambda: hx(precision_recall_fscore_support(s_a, s_b, average=avg)))
    case("prfs.weighted-samples.%s" % avg, lambda: hx(precision_recall_fscore_support(a, b, average=avg, sample_weight=wc)))
case("prfs.beta2", lambda: hx(precision_recall_fscore_support(a, b, beta=2.0)))
case("prfs.beta0", lambda: hx(precision_recall_fscore_support(a, b, beta=0)))
case("prfs.beta-inf", lambda: hx(precision_recall_fscore_support(a, b, beta=float("inf"))))
case("prfs.labels", lambda: hx(precision_recall_fscore_support(a, b, labels=[2, 1])))
case("prfs.labels-absent", caught(lambda: hx(precision_recall_fscore_support(a, b, labels=[2, 7], average="macro"))))
case("prfs.samples", lambda: precision_recall_fscore_support(a, b, average="samples"))
case("prfs.binary-on-multiclass", lambda: precision_recall_fscore_support(a, b, average="binary"))
case("binary.precision", lambda: hx(precision_score(bin_t, bin_p)))
case("binary.recall", lambda: hx(recall_score(bin_t, bin_p)))
case("binary.f1", lambda: hx(f1_score(bin_t, bin_p)))
case("binary.fbeta", lambda: hx(fbeta_score(bin_t, bin_p, beta=0.5)))
case("binary.pos0", lambda: hx(precision_score(bin_t, bin_p, pos_label=0)))
case("binary.pos-bad", lambda: precision_score(bin_t, bin_p, pos_label=2))
case("binary.pos-str", lambda: hx(f1_score(["y", "n", "y", "y"], ["y", "y", "n", "y"], pos_label="y")))
case("binary.pos-str-missing", lambda: f1_score(["y", "n", "y"], ["y", "y", "n"]))
case("binary.pos-ignored", caught(lambda: hx(f1_score(a, b, average="macro", pos_label=2))))
case("binary.only-one-class", caught(lambda: hx(precision_score([0, 0], [0, 0]))))
case("zero-division.warn", caught(lambda: hx(precision_score([0, 1, 1], [0, 0, 0]))))
case("zero-division.1", caught(lambda: hx(precision_score([0, 1, 1], [0, 0, 0], zero_division=1))))
case("zero-division.nan", caught(lambda: hx(precision_score([0, 1, 1], [0, 0, 0], zero_division=np.nan))))
case("zero-division.macro", caught(lambda: hx(precision_recall_fscore_support([0, 1, 2], [0, 0, 0], average="macro"))))
case("zero-division.none", caught(lambda: hx(precision_recall_fscore_support([0, 1, 2], [0, 0, 0]))))
case("zero-division.f-only", caught(lambda: hx(f1_score([0, 0], [0, 0], average="macro", labels=[1]))))

case("report", lambda: "\n" + classification_report(a, b))
case("report.strings", lambda: "\n" + classification_report(s_a, s_b, digits=4))
case("report.names", lambda: "\n" + classification_report(a, b, target_names=["setosa", "versicolor", "virginica"]))
case("report.labels", lambda: "\n" + classification_report(a, b, labels=[0, 1]))
case("report.labels-superset", lambda: "\n" + classification_report(a, b, labels=[0, 1, 2, 3]))
case("report.weighted", lambda: "\n" + classification_report(a, b, sample_weight=wc))
case("report.digits0", lambda: "\n" + classification_report(a, b, digits=0))
case("report.dict", lambda: classification_report(a, b, output_dict=True))
case("report.dict-labels", lambda: classification_report(a, b, labels=[0, 1], output_dict=True))
case("report.names-count", lambda: classification_report(a, b, target_names=["x"]))
case("report.names-count-labels", caught(lambda: classification_report(a, b, labels=[0, 1], target_names=["x"]).splitlines()[2]))
case("report.zero-division", caught(lambda: "\n" + classification_report([0, 1, 2], [0, 0, 0])))
case("report.str-series", lambda: "\n" + classification_report(pd.Series(s_a), pd.Series(s_b)))

# parameter errors (the sets listed sorted)
for cid, fn in [
    ("average", lambda: precision_score(a, b, average="foo")),
    ("zero_division", lambda: precision_score(a, b, zero_division="x")),
    ("zero_division-half", lambda: f1_score(a, b, zero_division=0.5)),
    ("pos_label", lambda: recall_score(bin_t, bin_p, pos_label=[1])),
    ("beta", lambda: fbeta_score(a, b, beta=-1)),
    ("beta-str", lambda: precision_recall_fscore_support(a, b, beta="a")),
    ("normalize", lambda: accuracy_score(a, b, normalize="yes")),
    ("y_true-scalar", lambda: accuracy_score(5, a)),
    ("sample_weight-scalar", lambda: accuracy_score(a, b, sample_weight=3)),
    ("cm-normalize", lambda: confusion_matrix(a, b, normalize="rows")),
    ("r2-multioutput", lambda: r2_score(yt, yp, multioutput="foo")),
    ("r2-force_finite", lambda: r2_score(yt, yp, force_finite=1)),
    ("mse-multioutput", lambda: mean_squared_error(yt, yp, multioutput="variance_weighted")),
    ("mae-multioutput-none", lambda: mean_absolute_error(yt, yp, multioutput=None)),
    ("rmse-y_pred-str", lambda: root_mean_squared_error(yt, "abc")),
    ("digits", lambda: classification_report(a, b, digits=-1)),
    ("digits-float", lambda: classification_report(a, b, digits=2.0)),
    ("output_dict", lambda: classification_report(a, b, output_dict="x")),
    ("warn_for", lambda: precision_recall_fscore_support(a, b, warn_for="precision")),
    ("samplewise", lambda: multilabel_confusion_matrix(a, b, samplewise=2)),
]:
    case("param." + cid, sorted_sets(fn))

# float32 inputs: the regression metrics compute in float32, as scikit-learn's
# _find_matching_floating_dtype keeps the inputs' floating type
t32 = np.array([0.1, 0.2, 0.3], dtype=np.float32)
p32 = np.array([0.2, 0.0, 0.4], dtype=np.float32)
for name, fn in [("r2", r2_score), ("mse", mean_squared_error), ("rmse", root_mean_squared_error), ("mae", mean_absolute_error)]:
    case(name + ".float32", lambda: (np.asarray(fn(t32, p32, multioutput="raw_values")).dtype.name, hx(fn(t32, p32)), hx(fn(t32, p32, multioutput="raw_values"))))

# zero_division=np.nan: the averages skip the NaN entries (_nanaverage), unweighted and weighted
for avg in ("macro", "weighted"):
    case("prfs.nan-skipped.%s" % avg, caught(lambda: hx(precision_recall_fscore_support([0, 1, 1, 2], [0, 0, 0, 0], labels=[0, 1, 2, 3], average=avg, zero_division=np.nan))))

# the stated tolerance (known.json's tolerances): weighted, unnormalized accuracy is np.dot(score, w),
# whose summation order differs; it is held to relative 1e-12 of the exactly rounded sum (math.fsum)
import math

rs_tol = np.random.RandomState(11)
y_tol = rs_tol.randint(0, 3, 1000)
p_tol = np.where(rs_tol.rand(1000) < 0.8, y_tol, rs_tol.randint(0, 3, 1000))
w_tol = rs_tol.rand(1000) * 10


def within_tolerance():
    got = accuracy_score(y_tol, p_tol, normalize=False, sample_weight=w_tol)
    exact = math.fsum(w for w, a, b in zip(w_tol.tolist(), y_tol.tolist(), p_tol.tolist()) if a == b)
    return abs(got - exact) <= 1e-12 * abs(exact)


case("acc.weighted-count-tolerance", within_tolerance)

# integer sample weights summed exactly in an int64 cell (never through float64), to 2**53 - 1, with duplicates,
# bool weights, and the default ones
yt, yp = [0, 1, 0, 1, 0], [0, 1, 0, 0, 0]
for w in ([2**52 + 1, 1, 2**52 - 3, 3, 1], np.array([2**52 + 1, 1, 2**52 - 3, 3, 1], np.int64), np.array([5, 6, 7, 8, 9], np.int32), np.array([True, False, True, True, True]), None):
    case(f"cm.int-weights {type(w).__name__} {getattr(w, 'dtype', '')}", lambda: (lambda m: (m.dtype.name, m.tolist()))(confusion_matrix(yt, yp, sample_weight=w)))
# beta: NaN is in no interval, refused before anything is computed (Python's and NumPy's NaN), +inf still accepted
for beta in (float("nan"), np.nan, np.float64("nan"), float("inf"), 0.5):
    case(f"fbeta.beta {beta!r}", lambda: fbeta_score([0, 1], [0, 1], beta=beta))
    case(f"prfs.beta {beta!r}", lambda: hx(precision_recall_fscore_support([0, 1], [0, 1], beta=beta)))
