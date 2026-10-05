"""numpy.random: NumPy's random streams.

RandomState (and the np.random.seed / rand / randn / randint ... functions)
is MT19937 with NumPy's legacy algorithms, so a seeded program gives the same
numbers as NumPy.  default_rng() is PCG64 seeded by NumPy's SeedSequence:
random(), integers(), uniform(), choice(), permutation() and shuffle() give
NumPy's numbers; normal() and the other Generator distributions are correctly
distributed but not NumPy's stream (NumPy uses ziggurat tables for them).
"""

import math as _math
import numpy as _np
import _nprandom as _r

__all__ = ["seed", "rand", "randn", "random", "random_sample", "ranf", "sample", "randint", "random_integers",
           "uniform", "normal", "standard_normal", "exponential", "standard_exponential", "poisson",
           "choice", "shuffle", "permutation", "RandomState", "Generator", "default_rng", "get_state", "set_state"]


def _size(size):
    if size is None:
        return None
    return list(size) if isinstance(size, (tuple, list)) else [size]


def _sz(*args):
    return list(args) if args else None


def _scalar_or(x):
    return x


class RandomState:
    def __init__(self, seed=None):
        self.seed(seed)

    def seed(self, seed=None):
        if seed is None:
            import time
            seed = int(time.time() * 1e6) & 0xFFFFFFFF
        if isinstance(seed, (list, tuple, _np.ndarray)):
            self._g = _r.mt19937([int(s) for s in _np.asarray(seed).ravel().tolist()])
        else:
            s = int(seed)
            if s < 0 or s > 0xFFFFFFFF:
                raise ValueError("Seed must be between 0 and 2**32 - 1")
            self._g = _r.mt19937(s)

    def get_state(self, legacy=True):
        key, pos, has_gauss, gauss = _r.get_state(self._g)
        return ("MT19937", _np.array(key, dtype=_np.uint32), pos, has_gauss, gauss)

    def set_state(self, state):
        _, key, pos, has_gauss, gauss = state[:5]
        _r.set_state(self._g, list(_np.asarray(key).tolist()), pos, has_gauss, gauss)

    def random_sample(self, size=None):
        return _r.doubles(self._g, _size(size))

    random = ranf = sample = random_sample

    def rand(self, *args):
        return _r.doubles(self._g, _sz(*args))

    def randn(self, *args):
        return _r.legacy_gauss(self._g, _sz(*args))

    def standard_normal(self, size=None):
        return _r.legacy_gauss(self._g, _size(size))

    def normal(self, loc=0.0, scale=1.0, size=None):
        if size is None and (isinstance(loc, _np.ndarray) or isinstance(scale, _np.ndarray)):
            size = _np.broadcast_shapes(_np.shape(loc), _np.shape(scale))
        z = _r.legacy_gauss(self._g, _size(size))
        return loc + scale * z if _size(size) is not None or not isinstance(z, float) else float(loc + scale * z)

    def uniform(self, low=0.0, high=1.0, size=None):
        if size is None and (isinstance(low, _np.ndarray) or isinstance(high, _np.ndarray)):
            size = _np.broadcast_shapes(_np.shape(low), _np.shape(high))
        u = _r.doubles(self._g, _size(size))
        return low + (high - low) * u

    def standard_exponential(self, size=None):
        return _r.legacy_exponential(self._g, _size(size))

    def exponential(self, scale=1.0, size=None):
        return scale * _r.legacy_exponential(self._g, _size(size))

    def poisson(self, lam=1.0, size=None):
        return _r.poisson(self._g, lam, _size(size))

    def randint(self, low, high=None, size=None, dtype=int):
        if high is None:
            low, high = 0, low
        if high <= low:
            raise ValueError("low >= high")
        r = _r.bounded(self._g, int(low), int(high) - 1, _size(size), False)
        if isinstance(r, _np.ndarray):
            return r if _np.dtype(dtype) == _np.int64 else r.astype(dtype)
        return int(r)

    def random_integers(self, low, high=None, size=None):
        if high is None:
            low, high = 1, low
        return self.randint(low, high + 1, size)

    def shuffle(self, x):
        n = len(x)
        js = _r.shuffle_order(self._g, n, False)
        for i, j in zip(range(n - 1, 0, -1), js):
            if isinstance(x, _np.ndarray) and x.ndim > 1:
                tmp = x[i].copy()
                x[i] = x[j]
                x[j] = tmp
            else:
                x[i], x[j] = x[j], x[i]

    def permutation(self, x):
        if isinstance(x, int):
            arr = _np.arange(x)
        else:
            arr = _np.array(x)
        self.shuffle(arr)
        return arr

    def choice(self, a, size=None, replace=True, p=None):
        pop = _np.arange(a) if isinstance(a, int) else _np.asarray(a)
        n = len(pop)
        shape = size
        if replace:
            if p is not None:
                cdf = _np.cumsum(_np.asarray(p, float))
                cdf /= cdf[-1]
                u = self.random_sample(shape)
                idx = _np.searchsorted(cdf, u, side="right")
            else:
                idx = self.randint(0, n, size=shape)
        else:
            k = 1 if shape is None else int(_np.prod(_np.asarray(shape)))
            if k > n:
                raise ValueError("Cannot take a larger sample than population when 'replace=False'")
            if p is not None:
                raise NotImplementedError("choice(replace=False, p=...)")
            idx = self.permutation(n)[:k]
            if shape is not None:
                idx = idx.reshape(shape)
            else:
                idx = idx[0]
        return pop[idx] if not isinstance(a, int) or isinstance(idx, _np.ndarray) else idx

    def bytes(self, length):
        return bytes(self.randint(0, 256, length).tolist())


_global = RandomState(0)
seed = _global.seed
get_state = _global.get_state
set_state = _global.set_state
random_sample = _global.random_sample
random = ranf = sample = random_sample
rand = _global.rand
randn = _global.randn
standard_normal = _global.standard_normal
normal = _global.normal
uniform = _global.uniform
exponential = _global.exponential
standard_exponential = _global.standard_exponential
poisson = _global.poisson
randint = _global.randint
random_integers = _global.random_integers
shuffle = _global.shuffle
permutation = _global.permutation
choice = _global.choice


class Generator:
    """numpy.random.Generator over PCG64 (see the module docstring for which
    methods reproduce NumPy's stream)."""

    def __init__(self, seed=None):
        if seed is None:
            import time
            seed = int(time.time() * 1e9)
        self._g = _r.pcg64(list(seed) if isinstance(seed, (list, tuple)) else int(seed))

    def __repr__(self):
        return "Generator(PCG64)"

    def random(self, size=None, dtype=_np.float64, out=None):
        return _r.doubles(self._g, _size(size))

    def integers(self, low, high=None, size=None, dtype=_np.int64, endpoint=False):
        if high is None:
            low, high = 0, low
        hi = int(high) if endpoint else int(high) - 1
        if hi < int(low):
            raise ValueError("low >= high" if not endpoint else "low > high")
        r = _r.bounded(self._g, int(low), hi, _size(size), True)
        if isinstance(r, _np.ndarray):
            return r if _np.dtype(dtype) == _np.int64 else r.astype(dtype)
        return _np.int64(r)

    def uniform(self, low=0.0, high=1.0, size=None):
        u = _r.doubles(self._g, _size(size))
        return low + (high - low) * u

    def standard_normal(self, size=None, dtype=_np.float64, out=None):
        return _r.zig_normal(self._g, _size(size))

    def normal(self, loc=0.0, scale=1.0, size=None):
        return loc + scale * _r.zig_normal(self._g, _size(size))

    def standard_exponential(self, size=None, dtype=_np.float64, method="zig", out=None):
        return _r.zig_exponential(self._g, _size(size))

    def exponential(self, scale=1.0, size=None):
        return scale * _r.zig_exponential(self._g, _size(size))

    def poisson(self, lam=1.0, size=None):
        return _r.poisson(self._g, lam, _size(size))

    def shuffle(self, x, axis=0):
        n = len(x)
        js = _r.shuffle_order(self._g, n, False)
        for i, j in zip(range(n - 1, 0, -1), js):
            if isinstance(x, _np.ndarray) and x.ndim > 1:
                tmp = x[i].copy()
                x[i] = x[j]
                x[j] = tmp
            else:
                x[i], x[j] = x[j], x[i]

    def permutation(self, x, axis=0):
        arr = _np.arange(x) if isinstance(x, int) else _np.array(x)
        self.shuffle(arr)
        return arr

    def permuted(self, x, axis=None, out=None):
        a = _np.array(x).ravel() if axis is None else _np.array(x)
        self.shuffle(a)
        return a.reshape(_np.shape(x)) if axis is None else a

    def choice(self, a, size=None, replace=True, p=None, axis=0, shuffle=True):
        pop = _np.arange(a) if isinstance(a, int) else _np.asarray(a)
        n = len(pop)
        if replace:
            if p is not None:
                cdf = _np.cumsum(_np.asarray(p, float))
                cdf /= cdf[-1]
                idx = _np.searchsorted(cdf, self.random(size), side="right")
            else:
                idx = self.integers(0, n, size=size)
        else:
            k = 1 if size is None else int(_np.prod(_np.asarray(size)))
            if k > n:
                raise ValueError("Cannot take a larger sample than population when replace is False")
            if p is not None:
                raise NotImplementedError("choice(replace=False, p=...)")
            idx = _np.array(_r.choice_noreplace(self._g, n, k, shuffle), dtype=_np.int64)
            idx = idx.reshape(size) if size is not None else idx[0]
        return pop[idx]

    def bytes(self, length):
        return bytes(self.integers(0, 256, length).tolist())


def default_rng(seed=None):
    if isinstance(seed, Generator):
        return seed
    return Generator(seed)


class SeedSequence:
    def __init__(self, entropy=None):
        self.entropy = entropy


def PCG64(seed=None):
    return seed


def MT19937(seed=None):
    return RandomState(seed)
