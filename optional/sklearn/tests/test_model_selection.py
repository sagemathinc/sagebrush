# The splitters and train_test_split: every index of every split, for
# several seeds, stratified draws with tied class counts, the reprs and errors.
import warnings

import numpy as np
import pandas as pd
from sklearn.datasets import load_iris, load_wine
from sklearn.model_selection import (KFold, LeaveOneOut, ShuffleSplit, StratifiedKFold, StratifiedShuffleSplit,
                                     check_cv, train_test_split)
from sklearn.utils import resample
from _cases import case, digest, sorted_sets


def splits(cv, X, y=None, groups=None):
    return [(tr.tolist(), te.tolist()) for tr, te in cv.split(X, y, groups)]


def split_digests(cv, X, y=None):
    return [(digest(tr), digest(te)) for tr, te in cv.split(X, y)]


def caught(fn):
    def run():
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            value = fn()
        return value, [(x.category.__name__, str(x.message)) for x in w]
    return run


X10 = np.arange(20).reshape(10, 2)
y10 = np.array([0, 0, 0, 1, 1, 1, 1, 2, 2, 2])
X, y = load_wine(return_X_y=True)
Xi, yi = load_iris(return_X_y=True)

case("kfold", lambda: splits(KFold(3), X10))
case("kfold.uneven", lambda: splits(KFold(4), np.arange(11)))
for seed in (0, 1, 42):
    case("kfold.shuffle-%d" % seed, lambda: splits(KFold(3, shuffle=True, random_state=seed), X10))
    case("kfold.wine-%d" % seed, lambda: split_digests(KFold(5, shuffle=True, random_state=seed), X))
case("kfold.rng-object", lambda: splits(KFold(2, shuffle=True, random_state=np.random.RandomState(3)), X10))
case("kfold.get_n_splits", lambda: KFold(7).get_n_splits())
case("kfold.too-many", lambda: splits(KFold(11), X10))
case("kfold.one", lambda: KFold(1))
case("kfold.float", lambda: KFold(2.5))
case("kfold.shuffle-not-bool", lambda: KFold(3, shuffle=1))
case("kfold.seed-without-shuffle", lambda: KFold(3, random_state=0))
case("kfold.groups", caught(lambda: splits(KFold(2), X10, groups=np.arange(10))))
case("kfold.list", lambda: splits(KFold(2), [[1], [2], [3], [4]]))
case("kfold.frame", lambda: splits(KFold(2), pd.DataFrame({"a": [1.0, 2.0, 3.0]})))

case("skfold", lambda: splits(StratifiedKFold(3), X10, y10))
for seed in (0, 1, 42):
    case("skfold.shuffle-%d" % seed, lambda: splits(StratifiedKFold(3, shuffle=True, random_state=seed), X10, y10))
    case("skfold.wine-%d" % seed, lambda: split_digests(StratifiedKFold(5, shuffle=True, random_state=seed), X, y))
case("skfold.wine", lambda: split_digests(StratifiedKFold(5), X, y))
case("skfold.iris-tied", lambda: split_digests(StratifiedKFold(4, shuffle=True, random_state=0), Xi, yi))
case("skfold.strings", lambda: splits(StratifiedKFold(2), np.zeros(6), ["b", "a", "b", "a", "c", "c"]))
case("skfold.str-series", lambda: splits(StratifiedKFold(2), np.zeros(6), pd.Series(["b", "a", "b", "a", "c", "c"])))
case("skfold.appearance-order", lambda: splits(StratifiedKFold(2), np.zeros(6), [2, 2, 1, 1, 0, 0]))
# (unbalanced classes in order of first appearance, not sorted: each fold's share follows that order)
y_appear = [2] * 4 + [1] * 5 + [0] * 6
case("skfold.appearance-unbalanced", lambda: splits(StratifiedKFold(3), np.zeros(15), y_appear))
case("skfold.appearance-unbalanced-shuffle", lambda: splits(StratifiedKFold(3, shuffle=True, random_state=0), np.zeros(15), y_appear))
case("skfold.few-members", caught(lambda: splits(StratifiedKFold(3), np.zeros(7), [0, 0, 0, 1, 1, 1, 2])))
case("skfold.too-few", lambda: splits(StratifiedKFold(3), np.zeros(4), [0, 0, 1, 1]))
case("skfold.continuous", lambda: splits(StratifiedKFold(2), np.zeros(4), [0.5, 1.5, 2.5, 3.5]))
case("skfold.groups", caught(lambda: splits(StratifiedKFold(2), X10, y10, groups=np.arange(10))))

case("loo", lambda: splits(LeaveOneOut(), np.arange(4)))
case("loo.n", lambda: LeaveOneOut().get_n_splits(np.arange(4)))
case("loo.one", lambda: splits(LeaveOneOut(), np.arange(1)))
case("loo.none", lambda: LeaveOneOut().get_n_splits(None))

for seed in (0, 1, 42):
    case("ss-%d" % seed, lambda: splits(ShuffleSplit(3, test_size=0.3, random_state=seed), X10))
    case("sss-%d" % seed, lambda: splits(StratifiedShuffleSplit(3, test_size=0.4, random_state=seed), X10, y10))
case("ss.default", lambda: [len(te) for _, te in ShuffleSplit(random_state=0).split(X)])
case("ss.train-size", lambda: splits(ShuffleSplit(2, train_size=3, test_size=2, random_state=0), X10))
case("ss.wine", lambda: split_digests(ShuffleSplit(4, test_size=0.25, random_state=7), X))
case("sss.wine", lambda: split_digests(StratifiedShuffleSplit(4, test_size=0.25, random_state=7), X, y))
case("sss.iris-tied", lambda: split_digests(StratifiedShuffleSplit(5, test_size=0.1, random_state=0), Xi, yi))
case("sss.tied-odd", lambda: splits(StratifiedShuffleSplit(4, test_size=5, random_state=3), np.zeros(12), [0] * 4 + [1] * 4 + [2] * 4))
case("sss.single-member", lambda: splits(StratifiedShuffleSplit(2, random_state=0), np.zeros(5), [0, 0, 1, 1, 2]))
case("sss.test-too-small", lambda: splits(StratifiedShuffleSplit(2, test_size=2, random_state=0), np.zeros(9), [0, 0, 0, 1, 1, 1, 2, 2, 2]))
case("sss.train-too-small", lambda: splits(StratifiedShuffleSplit(2, train_size=2, random_state=0), np.zeros(9), [0, 0, 0, 1, 1, 1, 2, 2, 2]))
case("sss.multilabel", lambda: splits(StratifiedShuffleSplit(2, test_size=0.5, random_state=0), np.zeros(8), np.array([[0, 1], [1, 0]] * 4)))
case("sss.strings", lambda: splits(StratifiedShuffleSplit(2, test_size=0.5, random_state=0), np.zeros(6), ["x", "y", "x", "y", "x", "y"]))

case("tts.wine-42", lambda: [digest(a) for a in train_test_split(X, y, test_size=0.25, random_state=42)])
for seed in (0, 1):
    case("tts.wine-%d" % seed, lambda: [digest(a) for a in train_test_split(X, y, random_state=seed)])
    case("tts.stratified-%d" % seed, lambda: [digest(a) for a in train_test_split(X, y, test_size=0.3, stratify=y, random_state=seed)])
case("tts.small", lambda: train_test_split(X10, y10, test_size=3, random_state=0))
case("tts.lists", lambda: train_test_split(list("abcdefgh"), list(range(8)), train_size=0.5, random_state=2))
case("tts.no-shuffle", lambda: train_test_split(np.arange(10), shuffle=False))
case("tts.no-shuffle-stratify", lambda: train_test_split(np.arange(10), shuffle=False, stratify=y10))
case("tts.frame", lambda: train_test_split(pd.DataFrame({"a": np.arange(6), "b": np.arange(6) * 0.5}), test_size=2, random_state=1))
case("tts.series-target", lambda: [a.tolist() for a in train_test_split(np.arange(8), pd.Series(["p", "q"] * 4), stratify=pd.Series(["p", "q"] * 4), test_size=0.5, random_state=5)])
case("tts.none", lambda: train_test_split())
case("tts.inconsistent", lambda: train_test_split([1, 2], [1, 2, 3]))
case("tts.sum", lambda: train_test_split(np.arange(10), test_size=0.6, train_size=0.6))
case("tts.too-many", lambda: train_test_split(np.arange(10), test_size=6, train_size=6))
case("tts.test-size-big", lambda: train_test_split(np.arange(10), test_size=10))
case("tts.empty-train", lambda: train_test_split(np.arange(3), test_size=0.9))
case("tts.bool-size", lambda: train_test_split(np.arange(10), test_size=True))
for cid, fn in [
    ("test_size", lambda: train_test_split(X10, test_size=1.5)),
    ("test_size-zero", lambda: train_test_split(X10, test_size=0)),
    ("train_size-one", lambda: train_test_split(X10, train_size=1.0)),
    ("random_state", lambda: train_test_split(X10, random_state="x")),
    ("random_state-negative", lambda: train_test_split(X10, random_state=-1)),
    ("shuffle", lambda: train_test_split(X10, shuffle=1)),
    ("stratify", lambda: train_test_split(X10, stratify=3)),
]:
    case("tts.param." + cid, sorted_sets(fn))

case("repr.kfold", lambda: repr(KFold()))
case("repr.kfold-shuffle", lambda: repr(KFold(3, shuffle=True, random_state=0)))
case("repr.skfold", lambda: repr(StratifiedKFold(10, shuffle=True, random_state=12345)))
case("repr.sss", lambda: repr(StratifiedShuffleSplit(test_size=0.123456789)))
case("repr.ss", lambda: repr(ShuffleSplit(train_size=0.5, test_size=3)))
case("repr.loo", lambda: repr(LeaveOneOut()))

case("check_cv.int", lambda: repr(check_cv(3)))
case("check_cv.none", lambda: repr(check_cv(None)))
case("check_cv.classifier", lambda: repr(check_cv(4, y10, classifier=True)))
case("check_cv.classifier-continuous", lambda: repr(check_cv(4, [0.5, 1.5], classifier=True)))
case("check_cv.object", lambda: (lambda k: check_cv(k) is k)(KFold(2)))
case("check_cv.iterable", lambda: (lambda c: (type(c).__name__, c.get_n_splits(), splits(c, X10)))(check_cv([([0, 1], [2]), ([2], [0, 1])])))
case("check_cv.str", lambda: check_cv("five"))
case("check_cv.bad", lambda: check_cv(2.5))

case("resample.stratify", lambda: resample(np.arange(10), stratify=y10, n_samples=6, random_state=0))
case("resample.stratify-noreplace", lambda: resample(np.arange(10), stratify=y10, replace=False, n_samples=5, random_state=1))
case("resample.stratify-strings", lambda: resample(np.arange(6), stratify=["a", "b", "a", "b", "a", "c"], random_state=2))
case("resample.stratify-wine", lambda: digest(resample(X, stratify=y, n_samples=50, random_state=42)))
