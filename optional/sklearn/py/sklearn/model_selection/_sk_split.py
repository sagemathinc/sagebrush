"""Splitters, from scikit-learn 1.9.1's sklearn/model_selection/_split.py: KFold, StratifiedKFold, ShuffleSplit,
StratifiedShuffleSplit, LeaveOneOut, check_cv and train_test_split, with the same random draws. Metadata routing (the
splitters' set_split_request) is not in Sagebrush's sklearn 0.x subset."""

import numbers
import warnings
from collections.abc import Iterable
from inspect import signature
from itertools import chain
from math import ceil, floor

import numpy as np

from ..utils._sk_extmath import _approximate_mode
from ..utils._sk_indexing import _safe_indexing
from ..utils._sk_param import ARRAY_LIKE, BOOLEAN, NONE, validate
from ..utils.multiclass import _sk_label_values, type_of_target
from ..utils.validation import _num_samples, check_array, check_random_state, column_or_1d, indexable


class _UnsupportedGroupCVMixin:
    """Mixin for splitters that do not support Groups."""

    def split(self, X, y=None, groups=None):
        """Generate indices to split data into training and test set."""
        if groups is not None:
            warnings.warn(f"The groups parameter is ignored by {self.__class__.__name__}", UserWarning)
        return super().split(X, y, groups=groups)


class BaseCrossValidator:
    """Base class for all cross-validators."""

    def split(self, X, y=None, groups=None):
        """Generate indices to split data into training and test set."""
        X, y, groups = indexable(X, y, groups)
        indices = np.arange(_num_samples(X))
        for test_index in self._iter_test_masks(X, y, groups):
            train_index = indices[np.logical_not(test_index)]
            test_index = indices[test_index]
            yield train_index, test_index

    def _iter_test_masks(self, X=None, y=None, groups=None):
        for test_index in self._iter_test_indices(X, y, groups):
            test_mask = np.zeros(_num_samples(X), dtype=bool)
            test_mask[test_index] = True
            yield test_mask

    def _iter_test_indices(self, X=None, y=None, groups=None):
        raise NotImplementedError

    def get_n_splits(self, X=None, y=None, groups=None):
        """Returns the number of splitting iterations in the cross-validator."""
        raise NotImplementedError

    def __repr__(self):
        return _build_repr(self)


class LeaveOneOut(_UnsupportedGroupCVMixin, BaseCrossValidator):
    """Leave-One-Out cross-validator."""

    def _iter_test_indices(self, X, y=None, groups=None):
        n_samples = _num_samples(X)
        if n_samples <= 1:
            raise ValueError("Cannot perform LeaveOneOut with n_samples={}.".format(n_samples))
        return range(n_samples)

    def get_n_splits(self, X, y=None, groups=None):
        """Returns the number of splitting iterations in the cross-validator."""
        if X is None:
            raise ValueError("The 'X' parameter should not be None.")
        return _num_samples(X)


class _BaseKFold(BaseCrossValidator):
    """Base class for K-Fold cross-validators."""

    def __init__(self, n_splits, *, shuffle, random_state):
        if not isinstance(n_splits, numbers.Integral):
            raise ValueError(
                "The number of folds must be of Integral type. "
                "%s of type %s was passed." % (n_splits, type(n_splits))
            )
        n_splits = int(n_splits)

        if n_splits <= 1:
            raise ValueError(
                "k-fold cross-validation requires at least one"
                " train/test split by setting n_splits=2 or more,"
                " got n_splits={0}.".format(n_splits)
            )

        if not isinstance(shuffle, bool):
            raise TypeError("shuffle must be True or False; got {0}".format(shuffle))

        if not shuffle and random_state is not None:
            raise ValueError(
                (
                    "Setting a random_state has no effect since shuffle is "
                    "False. You should leave "
                    "random_state to its default (None), or set shuffle=True."
                ),
            )

        self.n_splits = n_splits
        self.shuffle = shuffle
        self.random_state = random_state

    def split(self, X, y=None, groups=None):
        """Generate indices to split data into training and test set."""
        X, y, groups = indexable(X, y, groups)
        n_samples = _num_samples(X)
        if self.n_splits > n_samples:
            raise ValueError(
                (
                    "Cannot have number of splits n_splits={0} greater"
                    " than the number of samples: n_samples={1}."
                ).format(self.n_splits, n_samples)
            )

        for train, test in super().split(X, y, groups):
            yield train, test

    def get_n_splits(self, X=None, y=None, groups=None):
        """Returns the number of splitting iterations in the cross-validator."""
        return self.n_splits


class KFold(_UnsupportedGroupCVMixin, _BaseKFold):
    """K-Fold cross-validator."""

    def __init__(self, n_splits=5, *, shuffle=False, random_state=None):
        super().__init__(n_splits=n_splits, shuffle=shuffle, random_state=random_state)

    def _iter_test_indices(self, X, y=None, groups=None):
        n_samples = _num_samples(X)
        indices = np.arange(n_samples)
        if self.shuffle:
            check_random_state(self.random_state).shuffle(indices)

        n_splits = self.n_splits
        fold_sizes = np.full(n_splits, n_samples // n_splits, dtype=int)
        fold_sizes[: n_samples % n_splits] += 1
        current = 0
        for fold_size in fold_sizes.tolist():
            start, stop = current, current + fold_size
            yield indices[start:stop]
            current = stop


class StratifiedKFold(_BaseKFold):
    """Class-wise stratified K-Fold cross-validator."""

    def __init__(self, n_splits=5, *, shuffle=False, random_state=None):
        super().__init__(n_splits=n_splits, shuffle=shuffle, random_state=random_state)

    def _make_test_folds(self, X, y=None):
        rng = check_random_state(self.random_state)
        y = np.asarray(_sk_label_values(y))
        type_of_target_y = type_of_target(y)
        allowed_target_types = ("binary", "multiclass")
        if type_of_target_y not in allowed_target_types:
            raise ValueError(
                "Supported target types are: {}. Got {!r} instead.".format(allowed_target_types, type_of_target_y)
            )

        y = column_or_1d(y)

        _, y_idx, y_inv = np.unique(y, return_index=True, return_inverse=True)
        _, class_perm = np.unique(y_idx, return_inverse=True)
        y_encoded = class_perm[y_inv]

        n_classes = len(y_idx)
        y_counts = np.bincount(y_encoded)
        min_groups = np.min(y_counts)
        if np.all(self.n_splits > y_counts):
            raise ValueError(
                "n_splits=%d cannot be greater than the number of members in each class." % (self.n_splits))
        if self.n_splits > min_groups:
            warnings.warn(
                "The least populated class in y has only %d"
                " members, which is less than n_splits=%d." % (min_groups, self.n_splits),
                UserWarning,
            )

        y_order = np.sort(y_encoded)
        allocation = np.asarray(
            [np.bincount(y_order[i:: self.n_splits], minlength=n_classes) for i in range(self.n_splits)]
        )

        test_folds = np.empty(len(y), dtype=np.int32)  # (dtype "i", C int)
        for k in range(n_classes):
            folds_for_class = np.arange(self.n_splits).repeat(allocation[:, k])
            if self.shuffle:
                rng.shuffle(folds_for_class)
            test_folds[y_encoded == k] = folds_for_class
        return test_folds

    def _iter_test_masks(self, X, y=None, groups=None):
        test_folds = self._make_test_folds(X, y)
        for i in range(self.n_splits):
            yield test_folds == i

    def split(self, X, y, groups=None):
        """Generate indices to split data into training and test set."""
        if groups is not None:
            warnings.warn(f"The groups parameter is ignored by {self.__class__.__name__}", UserWarning)
        y = check_array(_sk_label_values(y), input_name="y", ensure_2d=False, dtype=None)
        return super().split(X, y, groups)


class BaseShuffleSplit:
    """Base class for *ShuffleSplit."""

    def __init__(self, n_splits=10, *, test_size=None, train_size=None, random_state=None):
        self.n_splits = n_splits
        self.test_size = test_size
        self.train_size = train_size
        self.random_state = random_state
        self._default_test_size = 0.1

    def split(self, X, y=None, groups=None):
        """Generate indices to split data into training and test set."""
        X, y, groups = indexable(X, y, groups)
        for train, test in self._iter_indices(X, y, groups):
            yield train, test

    def _iter_indices(self, X, y=None, groups=None):
        n_samples = _num_samples(X)
        n_train, n_test = _validate_shuffle_split(
            n_samples, self.test_size, self.train_size, default_test_size=self._default_test_size)

        rng = check_random_state(self.random_state)
        for i in range(self.n_splits):
            permutation = rng.permutation(n_samples)
            ind_test = permutation[:n_test]
            ind_train = permutation[n_test: (n_test + n_train)]
            yield ind_train, ind_test

    def get_n_splits(self, X=None, y=None, groups=None):
        """Returns the number of splitting iterations in the cross-validator."""
        return self.n_splits

    def __repr__(self):
        return _build_repr(self)


class ShuffleSplit(_UnsupportedGroupCVMixin, BaseShuffleSplit):
    """Random permutation cross-validator."""

    def __init__(self, n_splits=10, *, test_size=None, train_size=None, random_state=None):
        super().__init__(n_splits=n_splits, test_size=test_size, train_size=train_size, random_state=random_state)
        self._default_test_size = 0.1


class StratifiedShuffleSplit(BaseShuffleSplit):
    """Class-wise stratified ShuffleSplit cross-validator."""

    def __init__(self, n_splits=10, *, test_size=None, train_size=None, random_state=None):
        super().__init__(n_splits=n_splits, test_size=test_size, train_size=train_size, random_state=random_state)
        self._default_test_size = 0.1

    def _iter_indices(self, X, y, groups=None):
        n_samples = _num_samples(X)
        y = check_array(_sk_label_values(y), input_name="y", ensure_2d=False, dtype=None)
        n_train, n_test = _validate_shuffle_split(
            n_samples, self.test_size, self.train_size, default_test_size=self._default_test_size)

        if y.ndim == 2:
            y = np.array([" ".join(row.astype("str").tolist()) for row in y])

        classes, y_indices, class_counts = np.unique(y, return_inverse=True, return_counts=True)
        n_classes = classes.shape[0]

        if np.min(class_counts) < 2:
            too_few_classes = classes[class_counts < 2].tolist()
            raise ValueError(
                "The least populated classes in y have only 1"
                " member, which is too few. The minimum"
                " number of groups for any class cannot"
                " be less than 2. Classes with too few"
                " members are: %s" % (too_few_classes)
            )

        if n_train < n_classes:
            raise ValueError(
                "The train_size = %d should be greater or "
                "equal to the number of classes = %d" % (n_train, n_classes)
            )
        if n_test < n_classes:
            raise ValueError(
                "The test_size = %d should be greater or "
                "equal to the number of classes = %d" % (n_test, n_classes)
            )

        class_indices = np.split(np.argsort(y_indices, kind="stable"), np.cumsum(class_counts)[:-1])

        rng = check_random_state(self.random_state)

        for _ in range(self.n_splits):
            n_i = _approximate_mode(class_counts, n_train, rng)
            class_counts_remaining = class_counts - n_i
            t_i = _approximate_mode(class_counts_remaining, n_test, rng)

            train = []
            test = []

            for i in range(n_classes):
                permutation = rng.permutation(class_counts[i])
                perm_indices_class_i = class_indices[i].take(permutation, mode="clip")

                train.extend(perm_indices_class_i[: n_i[i]].tolist())
                test.extend(perm_indices_class_i[n_i[i]: n_i[i] + t_i[i]].tolist())

            train = rng.permutation(np.asarray(train, dtype=np.int64))
            test = rng.permutation(np.asarray(test, dtype=np.int64))

            yield train, test

    def split(self, X, y, groups=None):
        """Generate indices to split data into training and test set."""
        if groups is not None:
            warnings.warn(f"The groups parameter is ignored by {self.__class__.__name__}", UserWarning)
        y = check_array(_sk_label_values(y), input_name="y", ensure_2d=False, dtype=None)
        return super().split(X, y, groups)


def _sk_kind(v):
    # (np.asarray(v).dtype.kind; None is NumPy's object kind "O", which Sagebrush's numpy has no array for)
    return "O" if v is None else np.asarray(v).dtype.kind


def _validate_shuffle_split(n_samples, test_size, train_size, default_test_size=None):
    """Validation helper to check if the train/test sizes are meaningful w.r.t. the size of the data."""
    if test_size is None and train_size is None:
        test_size = default_test_size

    test_size_type = _sk_kind(test_size)
    train_size_type = _sk_kind(train_size)

    if (test_size_type == "i" and (test_size >= n_samples or test_size <= 0)) or (
        test_size_type == "f" and (test_size <= 0 or test_size >= 1)
    ):
        raise ValueError(
            "test_size={0} should be either positive and smaller"
            " than the number of samples {1} or a float in the "
            "(0, 1) range".format(test_size, n_samples)
        )

    if (train_size_type == "i" and (train_size >= n_samples or train_size <= 0)) or (
        train_size_type == "f" and (train_size <= 0 or train_size >= 1)
    ):
        raise ValueError(
            "train_size={0} should be either positive and smaller"
            " than the number of samples {1} or a float in the "
            "(0, 1) range".format(train_size, n_samples)
        )

    if train_size is not None and train_size_type not in ("i", "f"):
        raise ValueError("Invalid value for train_size: {}".format(train_size))
    if test_size is not None and test_size_type not in ("i", "f"):
        raise ValueError("Invalid value for test_size: {}".format(test_size))

    if train_size_type == "f" and test_size_type == "f" and train_size + test_size > 1:
        raise ValueError(
            "The sum of test_size and train_size = {}, should be in the (0, 1)"
            " range. Reduce test_size and/or train_size.".format(train_size + test_size)
        )

    if test_size_type == "f":
        n_test = ceil(test_size * n_samples)
    elif test_size_type == "i":
        n_test = float(test_size)

    if train_size_type == "f":
        n_train = floor(train_size * n_samples)
    elif train_size_type == "i":
        n_train = float(train_size)

    if train_size is None:
        n_train = n_samples - n_test
    elif test_size is None:
        n_test = n_samples - n_train

    if n_train + n_test > n_samples:
        raise ValueError(
            "The sum of train_size and test_size = %d, "
            "should be smaller than the number of "
            "samples %d. Reduce test_size and/or "
            "train_size." % (n_train + n_test, n_samples)
        )

    n_train, n_test = int(n_train), int(n_test)

    if n_train == 0:
        raise ValueError(
            "With n_samples={}, test_size={} and train_size={}, the "
            "resulting train set will be empty. Adjust any of the "
            "aforementioned parameters.".format(n_samples, test_size, train_size)
        )

    return n_train, n_test


class _CVIterableWrapper(BaseCrossValidator):
    """Wrapper class for old style cv objects and iterables."""

    def __init__(self, cv):
        self.cv = list(cv)

    def get_n_splits(self, X=None, y=None, groups=None):
        """Returns the number of splitting iterations in the cross-validator."""
        return len(self.cv)

    def split(self, X=None, y=None, groups=None):
        """Generate indices to split data into training and test set."""
        for train, test in self.cv:
            yield train, test


def _sk_has_split(cv):
    try:
        cv.split
        return True
    except AttributeError:
        return False


def check_cv(cv=5, y=None, *, classifier=False, shuffle=False, random_state=None):
    """Input checker utility for building a cross-validator."""
    cv = 5 if cv is None else cv
    if isinstance(cv, numbers.Integral):
        if classifier and (y is not None) and (type_of_target(y, input_name="y") in ("binary", "multiclass")):
            return StratifiedKFold(cv, shuffle=shuffle, random_state=random_state)
        else:
            return KFold(cv, shuffle=shuffle, random_state=random_state)

    if not _sk_has_split(cv) or isinstance(cv, str):
        if not isinstance(cv, Iterable) or isinstance(cv, str):
            raise ValueError(
                "Expected `cv` as an integer, a cross-validation object "
                "(from sklearn.model_selection), or an iterable yielding (train, test) "
                f"splits as arrays of indices. Got {cv}."
            )
        return _CVIterableWrapper(cv)

    return cv


def _sk_size(v):
    # (Interval(RealNotInt, 0, 1, closed="neither"), Interval(Integral, 1, None, closed="left") or None)
    return v is None or (isinstance(v, numbers.Integral) and v >= 1) or (
        isinstance(v, numbers.Real) and not isinstance(v, numbers.Integral) and 0 < v < 1)


_SK_SIZE = [(_sk_size, "a float in the range (0.0, 1.0), an int in the range [1, inf) or None")]
_SK_RANDOM_STATE = [(lambda v: v is None or (isinstance(v, numbers.Integral) and 0 <= v <= 4294967295)
                     or isinstance(v, np.random.RandomState),
                     "an int in the range [0, 4294967295], an instance of 'numpy.random.mtrand.RandomState' or None")]


def train_test_split(*arrays, test_size=None, train_size=None, random_state=None, shuffle=True, stratify=None):
    """Split arrays or matrices into random train and test subsets."""
    validate("train_test_split", "test_size", test_size, _SK_SIZE)
    validate("train_test_split", "train_size", train_size, _SK_SIZE)
    validate("train_test_split", "random_state", random_state, _SK_RANDOM_STATE)
    validate("train_test_split", "shuffle", shuffle, [BOOLEAN])
    validate("train_test_split", "stratify", stratify, [ARRAY_LIKE, NONE])
    n_arrays = len(arrays)
    if n_arrays == 0:
        raise ValueError("At least one array required as input")

    arrays = indexable(*arrays)

    n_samples = _num_samples(arrays[0])
    n_train, n_test = _validate_shuffle_split(n_samples, test_size, train_size, default_test_size=0.25)

    if shuffle is False:
        if stratify is not None:
            raise ValueError("Stratified train/test split is not implemented for shuffle=False")

        train = np.arange(n_train)
        test = np.arange(n_train, n_train + n_test)

    else:
        if stratify is not None:
            CVClass = StratifiedShuffleSplit
        else:
            CVClass = ShuffleSplit

        cv = CVClass(test_size=n_test, train_size=n_train, random_state=random_state)

        train, test = next(cv.split(X=arrays[0], y=stratify))

    return list(chain.from_iterable((_safe_indexing(a, train), _safe_indexing(a, test)) for a in arrays))


def _pprint(params, offset=0, printer=repr):
    """Pretty print the dictionary 'params'."""
    options = np.get_printoptions()
    np.set_printoptions(precision=5, threshold=64, edgeitems=2)
    params_list = list()
    this_line_length = offset
    line_sep = ",\n" + (1 + offset // 2) * " "
    for i, (k, v) in enumerate(sorted(params.items())):
        if isinstance(v, float):
            this_repr = "%s=%s" % (k, str(v))
        else:
            this_repr = "%s=%s" % (k, printer(v))
        if len(this_repr) > 500:
            this_repr = this_repr[:300] + "..." + this_repr[-100:]
        if i > 0:
            if this_line_length + len(this_repr) >= 75 or "\n" in this_repr:
                params_list.append(line_sep)
                this_line_length = len(line_sep)
            else:
                params_list.append(", ")
                this_line_length += 2
        params_list.append(this_repr)
        this_line_length += len(this_repr)

    np.set_printoptions(**options)
    lines = "".join(params_list)
    lines = "\n".join(l.rstrip(" ") for l in lines.split("\n"))
    return lines


def _build_repr(self):
    init = self.__class__.__init__
    if init is object.__init__:
        args = []
    else:
        init_signature = signature(init)
        args = sorted(
            [p.name for p in init_signature.parameters.values() if p.name != "self" and p.kind != p.VAR_KEYWORD]
        )
    class_name = self.__class__.__name__
    params = dict()
    for key in args:
        params[key] = getattr(self, key, None)

    return "%s(%s)" % (class_name, _pprint(params, offset=len(class_name)))
