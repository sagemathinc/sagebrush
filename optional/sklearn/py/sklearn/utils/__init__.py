"""Various utilities to help with development (scikit-learn 1.9.1's sklearn.utils): Bunch, the input checks,
the class weights, resample and shuffle, the batch generators and the estimator tags. Other names of sklearn.utils raise
NotImplementedError: they are not in Sagebrush's sklearn 0.x subset."""

from .._sk_missing import missing as _sk_missing
from .._sk_tags import ClassifierTags, InputTags, RegressorTags, Tags, TargetTags, TransformerTags, get_tags
from ..exceptions import DataConversionWarning
from ._sk_param import check_int_at_least
from ._sk_indexing import _safe_indexing, resample, shuffle
from .class_weight import compute_class_weight, compute_sample_weight
from .validation import (
    as_float_array,
    assert_all_finite,
    check_array,
    check_consistent_length,
    check_random_state,
    check_scalar,
    check_X_y,
    column_or_1d,
    indexable,
)

__all__ = [
    "Bunch",
    "ClassifierTags",
    "DataConversionWarning",
    "InputTags",
    "RegressorTags",
    "Tags",
    "TargetTags",
    "TransformerTags",
    "as_float_array",
    "assert_all_finite",
    "check_X_y",
    "check_array",
    "check_consistent_length",
    "check_random_state",
    "check_scalar",
    "column_or_1d",
    "compute_class_weight",
    "compute_sample_weight",
    "gen_batches",
    "gen_even_slices",
    "get_tags",
    "indexable",
    "resample",
    "shuffle",
]


class Bunch(dict):
    """Container object exposing keys as attributes."""

    def __init__(self, **kwargs):
        super().__init__(kwargs)

    def __setattr__(self, key, value):
        self[key] = value

    def __dir__(self):
        return self.keys()

    def __getattr__(self, key):
        try:
            return self[key]
        except KeyError:
            raise AttributeError(key)

    def __setstate__(self, state):
        pass


def gen_batches(n, batch_size, *, min_batch_size=0):
    """Generator to create slices containing batch_size elements from 0 to n."""
    check_int_at_least("gen_batches", "n", n, 1)
    check_int_at_least("gen_batches", "batch_size", batch_size, 1)
    check_int_at_least("gen_batches", "min_batch_size", min_batch_size, 0)
    return _sk_gen_batches(n, batch_size, min_batch_size)


def _sk_gen_batches(n, batch_size, min_batch_size):
    start = 0
    for _ in range(int(n // batch_size)):
        end = start + batch_size
        if end + min_batch_size > n:
            continue
        yield slice(start, end)
        start = end
    if start < n:
        yield slice(start, n)


def gen_even_slices(n, n_packs, *, n_samples=None):
    """Generator to create n_packs evenly spaced slices going up to n."""
    check_int_at_least("gen_even_slices", "n", n, 1)
    check_int_at_least("gen_even_slices", "n_packs", n_packs, 1)
    check_int_at_least("gen_even_slices", "n_samples", n_samples, 1, none_ok=True)
    return _sk_gen_even_slices(n, n_packs, n_samples)


def _sk_gen_even_slices(n, n_packs, n_samples):
    start = 0
    for pack_num in range(n_packs):
        this_n = n // n_packs
        if pack_num < n % n_packs:
            this_n += 1
        if this_n > 0:
            end = start + this_n
            if n_samples is not None:
                end = min(n_samples, end)
            yield slice(start, end, None)
            start = end


def __getattr__(name):
    return _sk_missing("sklearn.utils", name)
