"""Subset of CPython's random module with the same algorithms, so seeded
sequences match CPython exactly."""

import _random

__all__ = ["Random", "seed", "random", "getrandbits", "randbytes", "randrange", "randint", "choice", "shuffle", "uniform", "sample",
           "gauss", "choices"]


def _cell_entropy():
    # (in a reactive notebook's cell, a generator made or reseeded without a
    # seed draws from the cell's seed, one stream per request of the run:
    # src/notebook-session.ts; elsewhere None, true entropy)
    import builtins
    s = getattr(builtins, "__pyjs_seed__", None)
    if not s:
        return None
    s[2][0] += 1
    return (s[0] << 32) + s[2][0]


def _seed_value(a, version):
    # (CPython's Random.seed: a str, bytes or bytearray seeds by all its bits, int.from_bytes(a + sha512(a)) (version
    # 2, the default), or by the older string hash (version 1); an int, a float and None go to the generator as
    # they are; anything else is refused)
    if version == 1 and isinstance(a, (str, bytes)):
        a = a.decode("latin-1") if isinstance(a, bytes) else a
        x = ord(a[0]) << 7 if a else 0
        for c in map(ord, a):
            x = ((1000003 * x) ^ c) & 0xFFFFFFFFFFFFFFFF
        x ^= len(a)
        a = -2 if x == -1 else x
    elif version == 2 and isinstance(a, (str, bytes, bytearray)):
        from hashlib import sha512
        if isinstance(a, str):
            a = a.encode()
        a = int.from_bytes(a + sha512(a).digest())
    elif not isinstance(a, (type(None), int, float, str, bytes, bytearray)):
        raise TypeError("The only supported seed types are:\nNone, int, float, str, bytes, and bytearray.")
    return a


class Random:
    def __init__(self, x=None):
        # (seeded by self.seed, as CPython's: a subclass's own seed runs)
        self._r = _random.Random(0)
        self.seed(x)

    def seed(self, a=None, version=2):
        self._r.seed(_cell_entropy() if a is None else _seed_value(a, version))
        self.gauss_next = None

    def random(self):
        return self._r.random()

    def getrandbits(self, k):
        return self._r.getrandbits(k)

    def randbytes(self, n):
        """Generate n random bytes."""
        return self._r.getrandbits(n * 8).to_bytes(n, "little")

    def _randbelow(self, n):
        k = n.bit_length()
        r = self._r.getrandbits(k)
        while r >= n:
            r = self._r.getrandbits(k)
        return r

    def randrange(self, start, stop=None, step=1):
        istart = start.__index__()
        if stop is None:
            if step != 1:
                raise TypeError("Missing a non-None stop argument")
            if istart > 0:
                return self._randbelow(istart)
            raise ValueError("empty range for randrange()")
        istop = stop.__index__()
        width = istop - istart
        istep = step.__index__()
        if istep == 1:
            if width > 0:
                return istart + self._randbelow(width)
            raise ValueError(f"empty range in randrange({start}, {stop})")
        if istep > 0:
            n = (width + istep - 1) // istep
        elif istep < 0:
            n = (width + istep + 1) // istep
        else:
            raise ValueError("zero step for randrange()")
        if n <= 0:
            raise ValueError(f"empty range in randrange({start}, {stop}, {step})")
        return istart + istep * self._randbelow(n)

    def randint(self, a, b):
        return self.randrange(a, b + 1)

    def choice(self, seq):
        if not len(seq):
            raise IndexError("Cannot choose from an empty sequence")
        return seq[self._randbelow(len(seq))]

    def shuffle(self, x):
        randbelow = self._randbelow
        for i in reversed(range(1, len(x))):
            j = randbelow(i + 1)
            x[i], x[j] = x[j], x[i]

    def sample(self, population, k):
        population = list(population)
        n = len(population)
        if not 0 <= k <= n:
            raise ValueError("Sample larger than population or is negative")
        result = [None] * k
        pool = list(population)
        for i in range(k):
            j = self._randbelow(n - i)
            result[i] = pool[j]
            pool[j] = pool[n - i - 1]
        return result

    def choices(self, population, weights=None, *, cum_weights=None, k=1):
        n = len(population)
        if cum_weights is None:
            if weights is None:
                return [population[int(self.random() * n)] for i in range(k)]
            cum_weights = []
            total = 0
            for w in weights:
                total += w
                cum_weights.append(total)
        total = cum_weights[-1] + 0.0
        from bisect import bisect

        hi = n - 1
        return [population[bisect(cum_weights, self.random() * total, 0, hi)] for i in range(k)]

    def uniform(self, a, b):
        return a + (b - a) * self.random()

    def gauss(self, mu=0.0, sigma=1.0):
        from math import cos, sin, log, sqrt, pi

        z = self.gauss_next
        self.gauss_next = None
        if z is None:
            x2pi = self.random() * (2 * pi)
            g2rad = sqrt(-2.0 * log(1.0 - self.random()))
            z = cos(x2pi) * g2rad
            self.gauss_next = sin(x2pi) * g2rad
        return mu + z * sigma


def _cell_seed():
    # (the reactive notebook's per-cell seed, when a cell imports random:
    # src/notebook-session.ts)
    import builtins
    s = getattr(builtins, "__pyjs_seed__", None)
    return s[0] if s else None


_inst = Random(_cell_seed())
seed = _inst.seed
random = _inst.random
getrandbits = _inst.getrandbits
randbytes = _inst.randbytes
randrange = _inst.randrange
randint = _inst.randint
choice = _inst.choice
shuffle = _inst.shuffle
sample = _inst.sample
choices = _inst.choices
uniform = _inst.uniform
gauss = _inst.gauss
