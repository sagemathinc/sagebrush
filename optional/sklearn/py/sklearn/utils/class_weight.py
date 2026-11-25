"""Class weights, from scikit-learn 1.9.1's sklearn/utils/class_weight.py: compute_class_weight and
compute_sample_weight, for dense targets (sparse input is not in Sagebrush's sklearn 0.x subset)."""

import numpy as np

from .._sk_config import get_config
from .._sk_missing import missing as _sk_missing
from ._sk_param import StrOptions, validate_parameter_constraints
from .multiclass import _sk_label_values
from .validation import _check_sample_weight

__all__ = ["compute_class_weight", "compute_sample_weight"]


def _sk_validate(constraints, params, caller_name):
    # (as validate_params: skipped inside a fit, whose own parameters were validated)
    if not get_config()["skip_parameter_validation"]:
        validate_parameter_constraints(constraints, params, caller_name=caller_name)


def compute_class_weight(class_weight, *, classes, y, sample_weight=None):
    """Estimate class weights for unbalanced datasets."""
    _sk_validate(
        {
            "class_weight": [dict, StrOptions({"balanced"}), None],
            "classes": [np.ndarray],
            "y": ["array-like"],
            "sample_weight": ["array-like", None],
        },
        {"class_weight": class_weight, "classes": classes, "y": y, "sample_weight": sample_weight},
        "compute_class_weight",
    )
    y = np.asarray(_sk_label_values(y))
    unique_y = np.unique(y)
    if set(unique_y.tolist()) - set(classes.tolist()):
        raise ValueError("classes should include all valid labels that can be in y")
    if class_weight is None or len(class_weight) == 0:
        # uniform class weights
        weight = np.ones(classes.shape[0])
    elif class_weight == "balanced":
        # Find the weight of each class as present in y (LabelEncoder's fit_transform: np.unique's inverse).
        le_classes, y_ind = np.unique(y, return_inverse=True)
        if not all(np.isin(classes, le_classes.astype(classes.dtype))):
            raise ValueError("classes should have valid labels that are in y")

        sample_weight = _check_sample_weight(sample_weight, y)
        weighted_class_counts = np.bincount(y_ind, weights=sample_weight)
        recip_freq = np.sum(weighted_class_counts) / (le_classes.size * weighted_class_counts)
        weight = recip_freq[np.searchsorted(le_classes, classes)]
    else:
        # user-defined dictionary
        weight = np.ones(classes.size)
        unweighted_classes = []
        for i, c in enumerate(classes):
            try:
                c = int(c)
            except ValueError:  # `classes` contains strings
                c = str(c)
            if c in class_weight:
                weight[i] = class_weight[c]
            else:
                unweighted_classes.append(c)

        n_weighted_classes = classes.size - len(unweighted_classes)
        if unweighted_classes and n_weighted_classes != len(class_weight):
            unweighted_classes_user_friendly_str = np.array(unweighted_classes).tolist()
            raise ValueError(f"The classes, {unweighted_classes_user_friendly_str}, are not in class_weight")

    return weight


def compute_sample_weight(class_weight, y, *, indices=None):
    """Estimate sample weights by class for unbalanced datasets."""
    _sk_validate(
        {
            "class_weight": [dict, list, StrOptions({"balanced"}), None],
            "y": ["array-like", "sparse matrix"],
            "indices": ["array-like", None],
        },
        {"class_weight": class_weight, "y": y, "indices": indices},
        "compute_sample_weight",
    )
    # Ensure y is 2D.
    y = np.atleast_1d(_sk_label_values(y))
    if y.ndim == 1:
        y = np.reshape(y, (-1, 1))
    n_outputs = y.shape[1]

    if indices is not None and class_weight != "balanced":
        raise ValueError(f"The only valid class_weight for subsampling is 'balanced'. Given {class_weight}.")
    elif n_outputs > 1:
        if class_weight is None or isinstance(class_weight, dict):
            raise ValueError("For multi-output, class_weight should be a list of dicts, or the string 'balanced'.")
        elif isinstance(class_weight, list) and len(class_weight) != n_outputs:
            raise ValueError(
                "For multi-output, number of elements in class_weight should match "
                f"number of outputs. Got {len(class_weight)} element(s) while having "
                f"{n_outputs} outputs."
            )

    expanded_class_weight = []
    for k in range(n_outputs):
        y_full = y[:, k]
        classes_full = np.unique(y_full)
        classes_missing = None

        if class_weight == "balanced" or n_outputs == 1:
            class_weight_k = class_weight
        else:
            class_weight_k = class_weight[k]

        if indices is not None:
            # Get class weights for the subsample, covering all classes in case some labels that were present in
            # the original data are missing from the sample.
            y_subsample = y_full[indices]
            classes_subsample = np.unique(y_subsample)

            # (np.take(..., mode="clip"), the indices clipped first)
            sub = compute_class_weight(class_weight_k, classes=classes_subsample, y=y_subsample)
            weight_k = sub[np.clip(np.searchsorted(classes_subsample, classes_full), 0, sub.size - 1)]

            classes_missing = set(classes_full.tolist()) - set(classes_subsample.tolist())
        else:
            weight_k = compute_class_weight(class_weight_k, classes=classes_full, y=y_full)

        weight_k = weight_k[np.searchsorted(classes_full, y_full)]

        if classes_missing:
            # Make missing classes' weight zero
            weight_k[np.isin(y_full, list(classes_missing))] = 0.0

        expanded_class_weight.append(weight_k)

    expanded_class_weight = np.prod(expanded_class_weight, axis=0, dtype=np.float64)

    return expanded_class_weight


def __getattr__(name):
    return _sk_missing("sklearn.utils.class_weight", name)
