"""Datasets for Sagebrush's decision-tree kernel (sagebrush.skltree).

The kernel (engine/skltree, its own WebAssembly module) grows the decision
trees of Sagebrush's scikit-learn subset, ported line by line from
scikit-learn 1.9.1 so that they have the same bits as real scikit-learn's.
A dataset hands X, y and the missing-value mask to it once; every tree of a
forest or a bagging ensemble then uses that one copy.

    import numpy as np
    from sagebrush import skltree
    X = np.array([[0.0, 1.0], [2.0, 3.0]], dtype=np.float32)
    y = np.array([[0.0], [1.0]])
    ds = skltree.dataset(X, y)
    ds.n_samples, ds.n_features, ds.n_outputs   # (2, 2, 1)
    ds.release()

Importing this module is cheap: the kernel is compiled at the first
dataset(), never before.

    tree = skltree.fit(ds, n_classes=[2], criterion="gini", max_features=2, seed=209652396)
    skltree.apply(tree, X)                     # each row's leaf
"""

import _skltree as _k

__all__ = ["Dataset", "apply", "dataset", "fit"]


class Dataset:
    """X, y and the missing-value mask, held by the kernel.

    Made by dataset().  release() frees the kernel's copy; a dataset no
    longer referenced is released when it is collected.  A dataset is stale
    once released, or once a Stop has retired the kernel's instance it lives
    in: using a stale dataset raises ValueError, and releasing it again is
    silently nothing.
    """

    __slots__ = ("_token", "n_samples", "n_features", "n_outputs")

    def __init__(self, token, n_samples, n_features, n_outputs):
        self._token = token
        self.n_samples = n_samples
        self.n_features = n_features
        self.n_outputs = n_outputs

    @property
    def usable(self):
        """Whether the dataset is live: not released, and not retired by a Stop."""
        return self._token is not None and _k.usable(self._token)

    def release(self):
        """Free the kernel's copy now.  Silently nothing if it is already
        released or stale."""
        token, self._token = self._token, None
        if token is not None:
            _k.release(token)

    def __repr__(self):
        state = "" if self.usable else ", released"
        return f"<sagebrush.skltree.Dataset {self.n_samples} x {self.n_features}, {self.n_outputs} output{'' if self.n_outputs == 1 else 's'}{state}>"


def dataset(X, y, missing_mask=None):
    """Hand X, y and the missing-value mask to the kernel, once.

    X must be a C-contiguous float32 array of shape (n_samples, n_features)
    and y a C-contiguous float64 array of shape (n_samples, n_outputs), with
    class indices for a classifier: they are copied as they are, never
    converted.  missing_mask is None (no column may hold NaN) or a bool or
    uint8 array of shape (n_features,), 1 where a column may.

    The kernel checks the copy: X may hold NaN only in a column the mask
    marks, and no infinity; y must be finite.  A failed check is a
    ValueError naming the row and column.  The copy is admitted against
    the kernel's share of the session's memory before anything is made:
    too large a dataset is a MemoryError saying so.  Stop works during
    the copy.  Returns a Dataset.
    """
    token = _k.dataset(X, y, missing_mask)
    return Dataset(token, X.shape[0], X.shape[1], y.shape[1])


def fit(dataset, sample_weight=None, *, n_classes=None, criterion, max_depth=None, min_samples_split=2,
        min_samples_leaf=1, min_weight_leaf=0.0, max_features, min_impurity_decrease=0.0, seed):
    """Grow one tree on a dataset, as scikit-learn 1.9.1's depth-first builder with its best splitter does.

    The parameters are as scikit-learn's DecisionTree*.fit resolves them in
    Python before its builder runs: criterion is "gini", "entropy",
    "log_loss" (entropy) or "squared_error"; n_classes is each output's
    class count for a classifier (y holding class indices) and None for a
    regressor; max_depth is an int or None; min_samples_split,
    min_samples_leaf and max_features are ints; min_weight_leaf is a float
    (min_weight_fraction_leaf times the total weight); seed is the
    splitter's XorShift seed, random_state.randint(0, 2**31 - 1).
    sample_weight is None or a float64 array of n_samples weights, copied
    for this tree only (the dataset isn't copied again).

    Returns a dict of the tree's arrays, as scikit-learn's tree_ holds them:
    children_left, children_right, feature, n_node_samples (int64),
    threshold, impurity, weighted_n_node_samples (float64),
    missing_go_to_left (uint8), value (float64, node_count x n_outputs x
    max_n_classes: class fractions, or means), the raw feature importances
    (each split's weighted impurity decrease over the root's weight, before
    normalization), node_count and max_depth.  The dataset must be usable;
    a released or stale one raises ValueError.
    """
    if dataset._token is None:
        raise ValueError("this dataset can't be used: it was released")
    return _k.fit(dataset._token, sample_weight, n_classes, criterion, max_depth, min_samples_split,
                  min_samples_leaf, min_weight_leaf, max_features, min_impurity_decrease, seed)


def apply(tree, X):
    """Each row's leaf in a tree fit() returned, as scikit-learn's apply: X must be a C-contiguous float32 array
    of shape (n_samples, n_features); a value is compared with the node's threshold as a float64, and NaN goes
    the way the node's missing_go_to_left says.  Returns an int64 array."""
    return _k.apply(tree["children_left"], tree["children_right"], tree["feature"], tree["threshold"],
                    tree["missing_go_to_left"], X)
