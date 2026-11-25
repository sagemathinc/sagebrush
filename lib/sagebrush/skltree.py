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
"""

import _skltree as _k

__all__ = ["Dataset", "dataset"]


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
