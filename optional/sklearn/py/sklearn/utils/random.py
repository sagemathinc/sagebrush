"""Random sampling utilities, from scikit-learn 1.9.1's sklearn/utils/random.py and sklearn/utils/_random.pyx:
sample_without_replacement, with its three methods (tracking selection, reservoir sampling and the pool) drawing
from the same RandomState calls in the same order, so the same random_state gives the same indices."""

import numpy as np

from .._sk_missing import missing as _sk_missing
from .validation import check_random_state

__all__ = ["sample_without_replacement"]


def _sample_without_replacement_check_input(n_population, n_samples):
    """Check that input are consistent for sample_without_replacement"""
    if n_population < 0:
        raise ValueError("n_population should be greater than 0, got %s." % n_population)

    if n_samples > n_population:
        raise ValueError(
            "n_population should be greater or equal than "
            "n_samples, got n_samples > n_population (%s > %s)" % (n_samples, n_population)
        )


def _sample_without_replacement_with_tracking_selection(n_population, n_samples, random_state=None):
    """Sample integers without replacement: draw until an unselected one comes up (n_samples much smaller)."""
    _sample_without_replacement_check_input(n_population, n_samples)

    out = np.empty((n_samples,), dtype=int)

    rng = check_random_state(random_state)
    rng_randint = rng.randint

    # The following line of code are heavily inspired from python core,
    # more precisely of random.sample.
    selected = set()

    for i in range(n_samples):
        j = rng_randint(n_population)
        while j in selected:
            j = rng_randint(n_population)
        selected.add(j)
        out[i] = j

    return out


def _sample_without_replacement_with_pool(n_population, n_samples, random_state=None):
    """Sample integers without replacement: select from a shrinking pool of the unselected ones."""
    _sample_without_replacement_check_input(n_population, n_samples)

    out = np.empty((n_samples,), dtype=int)
    pool = np.empty((n_population,), dtype=int)

    rng = check_random_state(random_state)
    rng_randint = rng.randint

    # Initialize the pool
    for i in range(n_population):
        pool[i] = i

    # The following line of code are heavily inspired from python core,
    # more precisely of random.sample.
    for i in range(n_samples):
        j = rng_randint(n_population - i)  # invariant: non-selected at [0,n-i)
        out[i] = pool[j]
        pool[j] = pool[n_population - i - 1]  # move non-selected item into vacancy

    return out


def _sample_without_replacement_with_reservoir_sampling(n_population, n_samples, random_state=None):
    """Sample integers without replacement: reservoir sampling (the order of the selected integers is random)."""
    _sample_without_replacement_check_input(n_population, n_samples)

    out = np.empty((n_samples,), dtype=int)

    rng = check_random_state(random_state)
    rng_randint = rng.randint

    # This cython implementation is based on the one of Robert Kern:
    # http://mail.scipy.org/pipermail/numpy-discussion/2010-December/
    # 054289.html
    #
    for i in range(n_samples):
        out[i] = i

    for i in range(n_samples, n_population):
        j = rng_randint(0, i + 1)
        if j < n_samples:
            out[j] = i

    return out


def _sample_without_replacement(n_population, n_samples, method="auto", random_state=None):
    _sample_without_replacement_check_input(n_population, n_samples)

    all_methods = ("auto", "tracking_selection", "reservoir_sampling", "pool")

    # (a C double division, as Cython's <double> cast gives)
    ratio = float(n_samples) / n_population if n_population != 0.0 else 1.0

    # Check ratio and use permutation unless ratio < 0.01 or ratio > 0.99
    if method == "auto" and ratio > 0.01 and ratio < 0.99:
        rng = check_random_state(random_state)
        return rng.permutation(n_population)[:n_samples]

    if method == "auto" or method == "tracking_selection":
        # TODO the pool based method can also be used.
        #      however, it requires special benchmark to take into account
        #      the memory requirement of the array vs the set.

        # The value 0.2 has been determined through benchmarking.
        if ratio < 0.2:
            return _sample_without_replacement_with_tracking_selection(n_population, n_samples, random_state)
        else:
            return _sample_without_replacement_with_reservoir_sampling(n_population, n_samples, random_state)

    elif method == "reservoir_sampling":
        return _sample_without_replacement_with_reservoir_sampling(n_population, n_samples, random_state)

    elif method == "pool":
        return _sample_without_replacement_with_pool(n_population, n_samples, random_state)
    else:
        raise ValueError("Expected a method name in %s, got %s. " % (all_methods, method))


def sample_without_replacement(n_population, n_samples, method="auto", random_state=None):
    """Sample integers without replacement.

    Select n_samples integers from the set [0, n_population) without replacement, by "auto" (a permutation's
    first n_samples when 0.01 < n_samples / n_population < 0.99, else tracking selection below a ratio of 0.2 and
    reservoir sampling above it), "tracking_selection", "reservoir_sampling" or "pool"."""
    # (scikit-learn converts both to C integers first: int() for Python and NumPy integers)
    return _sample_without_replacement(int(n_population), int(n_samples), method, random_state)


def __getattr__(name):
    return _sk_missing("sklearn.utils.random", name)
