"""_approximate_mode, from scikit-learn 1.9.1's sklearn/utils/extmath.py: how many samples of each class a stratified
draw takes, ties broken by the random state."""

import numpy as np

from .validation import check_random_state


def _approximate_mode(class_counts, n_draws, rng):
    """Computes approximate mode of multivariate hypergeometric."""
    rng = check_random_state(rng)
    continuous = class_counts / class_counts.sum() * n_draws
    floored = np.floor(continuous)
    need_to_add = int(n_draws - floored.sum())
    if need_to_add > 0:
        remainder = continuous - floored
        values = np.sort(np.unique(remainder))[::-1]
        for value in values:
            (inds,) = np.where(remainder == value)
            add_now = min(len(inds), need_to_add)
            inds = rng.choice(inds, size=add_now, replace=False)
            floored[inds] += 1
            need_to_add -= add_now
            if need_to_add == 0:
                break
    return floored.astype(int)


def _safe_accumulator_op(op, x, *args, **kwargs):
    """Call op with float64 accumulation for float32 input (op takes dtype=), as scikit-learn does."""
    if x.dtype.kind == "f" and x.dtype.itemsize < 8:
        return op(x, *args, **kwargs, dtype=np.float64)
    return op(x, *args, **kwargs)


def _safe_matmul(w, x):
    # (_safe_accumulator_op(np.matmul, w, x): matmul takes no dtype, so float32 operands are converted first)
    if x.dtype.kind == "f" and x.dtype.itemsize < 8:
        x = x.astype(np.float64)
        w = w.astype(np.float64)
    return np.matmul(w, x)


def _incremental_mean_and_var(X, last_mean, last_variance, last_sample_count, sample_weight=None):
    """Calculate mean update and a Youngs and Cramer variance update."""
    last_sample_count = np.asarray(last_sample_count, dtype=np.float64)
    last_sum = last_mean * last_sample_count
    X_nan_mask = np.isnan(X)
    if np.any(X_nan_mask):
        sum_op = np.nansum
    else:
        sum_op = np.sum
    if sample_weight is not None:
        new_sum = _safe_matmul(sample_weight, np.where(X_nan_mask, 0, X))
        new_sample_count = _safe_accumulator_op(
            np.sum, sample_weight[:, None] * (~X_nan_mask).astype(sample_weight.dtype), axis=0)
    else:
        new_sum = _safe_accumulator_op(sum_op, X, axis=0)
        n_samples = X.shape[0]
        new_sample_count = n_samples - _safe_accumulator_op(sum_op, X_nan_mask.astype(X.dtype), axis=0)

    updated_sample_count = last_sample_count + new_sample_count

    updated_mean = (last_sum + new_sum) / updated_sample_count

    if last_variance is None:
        updated_variance = None
    else:
        T = new_sum / new_sample_count
        temp = X - T
        if sample_weight is not None:
            correction = _safe_matmul(sample_weight, np.where(X_nan_mask, 0, temp))
            temp **= 2
            new_unnormalized_variance = _safe_matmul(sample_weight, np.where(X_nan_mask, 0, temp))
        else:
            correction = _safe_accumulator_op(sum_op, temp, axis=0)
            temp **= 2
            new_unnormalized_variance = _safe_accumulator_op(sum_op, temp, axis=0)

        new_unnormalized_variance -= correction**2 / new_sample_count

        last_unnormalized_variance = last_variance * last_sample_count

        with np.errstate(divide="ignore", invalid="ignore"):
            last_over_new_count = last_sample_count / new_sample_count
            updated_unnormalized_variance = (
                last_unnormalized_variance
                + new_unnormalized_variance
                + last_over_new_count / updated_sample_count * (last_sum / last_over_new_count - new_sum) ** 2
            )

        zeros = last_sample_count == 0
        updated_unnormalized_variance[zeros] = new_unnormalized_variance[zeros]
        updated_variance = updated_unnormalized_variance / updated_sample_count

    return updated_mean, updated_variance, updated_sample_count
