"""_weighted_percentile, from scikit-learn 1.9.1's sklearn/utils/stats.py (the lower weighted percentile, average=False,
which DummyRegressor uses)."""

import numpy as np


def _weighted_percentile(array, sample_weight, percentile_rank=50):
    """Compute the weighted percentile with method 'inverted_cdf'."""
    floating_dtype = np.asarray(array).dtype if np.asarray(array).dtype.kind == "f" else np.float64
    array = np.asarray(array, dtype=floating_dtype)
    sample_weight = np.asarray(sample_weight, dtype=floating_dtype)
    percentile_rank = np.asarray(percentile_rank, dtype=floating_dtype)

    if np.all(sample_weight == 0):
        return np.nan

    n_dim = array.ndim
    if n_dim == 0:
        return array
    if array.ndim == 1:
        array = np.reshape(array, (-1, 1))
    if array.shape != sample_weight.shape and array.shape[0] == sample_weight.shape[0]:
        sample_weight = np.tile(sample_weight, (array.shape[1], 1)).T

    n_dim_percentile = percentile_rank.ndim
    if n_dim_percentile == 0:
        percentile_rank = np.reshape(percentile_rank, (1,))

    sorted_idx = np.argsort(array, axis=0)
    n_features = array.shape[1]
    # (np.take_along_axis(sample_weight, sorted_idx, axis=0), column by column)
    sorted_weights = np.empty(sorted_idx.shape, dtype=floating_dtype)
    for j in range(n_features):
        sorted_weights[:, j] = sample_weight[sorted_idx[:, j], j]

    largest_value_per_column = array[sorted_idx[-1, ...], np.arange(n_features)]
    if np.any(np.isnan(largest_value_per_column)):
        isnan = np.isnan(array)
        for j in range(n_features):
            sorted_weights[isnan[sorted_idx[:, j], j], j] = 0

    weight_cdf = np.cumsum(sorted_weights.T, axis=1)

    n_percentiles = percentile_rank.shape[0]
    result = np.empty((n_features, n_percentiles), dtype=floating_dtype)

    for p_idx in range(n_percentiles):
        p_rank = percentile_rank[p_idx]
        adjusted_percentile_rank = p_rank / 100 * weight_cdf[..., -1]

        mask = adjusted_percentile_rank == 0
        adjusted_percentile_rank[mask] = np.nextafter(adjusted_percentile_rank[mask], adjusted_percentile_rank[mask] + 1)
        percentile_indices = np.stack(
            [np.searchsorted(weight_cdf[feature_idx, ...], adjusted_percentile_rank[feature_idx])
             for feature_idx in range(weight_cdf.shape[0])],
        )
        max_idx = sorted_idx.shape[0] - 1
        percentile_indices = np.clip(percentile_indices, 0, max_idx)

        col_indices = np.arange(array.shape[1])
        percentile_in_sorted = sorted_idx[percentile_indices, col_indices]

        result[..., p_idx] = array[percentile_in_sorted, col_indices]

    if n_dim_percentile == 0:
        result = result[..., 0]

    return result[0, ...] if n_dim == 1 else result
