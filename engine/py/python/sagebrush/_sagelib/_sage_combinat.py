"""Enumerative combinatorics, as in Sage: integer partitions, compositions,
finite sets and their subsets, combinations, permutations, and the counting
functions (number_of_partitions, Stirling and Bell numbers).  Objects list
in Sage's order and print as Sage prints them."""

import itertools as _it


def _sa():
    import sage_all
    return sage_all


def _Z(n):
    return _sa().Integer(n)


def _key(v):
    # a sort key that orders mixed elements stably, as Sage's sets print
    try:
        return (0, v + 0, "")
    except TypeError:
        return (1, 0, repr(v))


def _int(v):
    """v as an int; a value that is not an integer (2.9, "2") is refused,
    never truncated."""
    if isinstance(v, (str, bytes)):
        raise TypeError("%r is not an integer" % (v,))
    try:
        i = int(v)
    except (TypeError, ValueError):
        raise TypeError("%r is not an integer" % (v,))
    if i != v:
        raise ValueError("%r is not an integer" % (v,))
    return i


def _nonneg(v, name="n"):
    i = _int(v)
    if i < 0:
        raise ValueError("%s must be a non-negative integer, not %d" % (name, i))
    return i


def _is_int(v):
    # an integer argument (Permutations(3)) rather than a collection
    if isinstance(v, (str, bytes, list, tuple, set, frozenset, dict, range)):
        return False
    try:
        return int(v) == v
    except (TypeError, ValueError):
        return False


def _same(a, b):
    try:
        return bool(a == b)
    except Exception:
        return a is b


def _groups(elts):
    """The distinct elements by equality, in order of first occurrence, and
    their multiplicities (hashable or not)."""
    reps, counts = [], []
    for v in elts:
        for i, r in enumerate(reps):
            if _same(r, v):
                counts[i] += 1
                break
        else:
            reps.append(v)
            counts.append(1)
    return reps, counts


def _choices(counts, k):
    """The multiplicity vectors x (sum k, 0 <= x_i <= counts[i]), as many of
    the first element as possible first: Sage's order, itertools' for
    distinct elements.  Work is proportional to the output."""
    n = len(counts)
    room = [0] * (n + 1)
    for i in range(n - 1, -1, -1):
        room[i] = room[i + 1] + counts[i]
    x = [0] * n

    def rec(i, k):
        if i == n:
            yield list(x)
            return
        for v in range(min(counts[i], k), max(0, k - room[i + 1]) - 1, -1):
            x[i] = v
            yield from rec(i + 1, k - v)
        x[i] = 0
    if 0 <= k <= room[0]:
        yield from rec(0, k)


def _arrangements(counts, k):
    """The sequences of k group indices using index g at most counts[g]
    times, in lexicographic order (each distinct arrangement once)."""
    if not 0 <= k <= sum(counts):
        return
    left = list(counts)
    seq = []

    def rec(d):
        if d == k:
            yield list(seq)
            return
        for g in range(len(left)):
            if left[g]:
                left[g] -= 1
                seq.append(g)
                yield from rec(d + 1)
                seq.pop()
                left[g] += 1
    yield from rec(0)


def _count_choices(counts, k):
    # the coefficient of x^k in prod (1 + x + ... + x^c)
    if k is None:
        r = 1
        for c in counts:
            r *= c + 1
        return r
    if k < 0:
        return 0
    poly = [1] + [0] * k
    for c in counts:
        new = [0] * (k + 1)
        for d in range(k + 1):
            if poly[d]:
                for j in range(min(c, k - d) + 1):
                    new[d + j] += poly[d]
        poly = new
    return poly[k]


def _count_arrangements(counts, k):
    # k! times the coefficient of x^k in prod (sum_{j <= c} x^j/j!)
    from fractions import Fraction
    from math import factorial
    if not 0 <= k <= sum(counts):
        return 0
    poly = [Fraction(1)] + [Fraction(0)] * k
    for c in counts:
        new = [Fraction(0)] * (k + 1)
        for d in range(k + 1):
            if poly[d]:
                for j in range(min(c, k - d) + 1):
                    new[d + j] += poly[d] / factorial(j)
        poly = new
    return int(poly[k] * factorial(k))


# --------------------------------------------------------------- counting

def number_of_partitions(n):
    """The number of partitions of n.

    EXAMPLES::

        sage: number_of_partitions(10), number_of_partitions(100)
        (42, 190569292)
    """
    n = _int(n)
    if n < 0:
        return _Z(0)
    p = [1] + [0] * n
    for k in range(1, n + 1):
        for m in range(k, n + 1):
            p[m] += p[m - k]
    return _Z(p[n])


def stirling_number2(n, k):
    """The Stirling number of the second kind S(n, k): the partitions of an
    n-set into k blocks.

    EXAMPLES::

        sage: stirling_number2(5, 2), stirling_number2(10, 4)
        (15, 34105)
    """
    n, k = _nonneg(n), _int(k)
    if k < 0 or k > n:
        return _Z(0)
    row = [1] + [0] * k
    for i in range(1, n + 1):
        new = [0] * (k + 1)
        for j in range(1, min(i, k) + 1):
            new[j] = j * row[j] + row[j - 1]
        row = new
    return _Z(row[k])


def stirling_number1(n, k):
    """The unsigned Stirling number of the first kind: the permutations of n
    letters with k cycles.

    EXAMPLES::

        sage: stirling_number1(5, 2), stirling_number1(4, 4)
        (50, 1)
    """
    n, k = _nonneg(n), _int(k)
    if k < 0 or k > n:
        return _Z(0)
    row = [1] + [0] * k
    for i in range(1, n + 1):
        new = [0] * (k + 1)
        for j in range(1, min(i, k) + 1):
            new[j] = (i - 1) * row[j] + row[j - 1]
        row = new
    return _Z(row[k])


def bell_number(n):
    """The Bell number B(n): the partitions of an n-set.

    EXAMPLES::

        sage: [bell_number(n) for n in range(8)]
        [1, 1, 2, 5, 15, 52, 203, 877]
    """
    n = _nonneg(n)
    row = [1]
    for _ in range(n):
        new = [row[-1]]
        for v in row:
            new.append(new[-1] + v)
        row = new
    return _Z(row[0])


# --------------------------------------------------------------- partitions

class Partition:
    """An integer partition, weakly decreasing parts.

    EXAMPLES::

        sage: p = Partition([3, 1]); p
        [3, 1]
        sage: p.conjugate(), p.size(), p.length(), p.hook_lengths()
        ([2, 1, 1], 4, 2, [[4, 2, 1], [1]])
    """

    def __init__(self, parts):
        parts = [_int(v) for v in parts]
        while parts and parts[-1] == 0:
            parts.pop()
        if any(parts[i] < parts[i + 1] for i in range(len(parts) - 1)) or any(v < 0 for v in parts):
            raise ValueError("%s is not an element of Partitions" % (parts,))
        self._p = parts

    def __repr__(self):
        return repr(self._p)

    def __eq__(self, other):
        if isinstance(other, Partition):
            return self._p == other._p
        if isinstance(other, (list, tuple)):
            return self._p == list(other)
        return NotImplemented

    def __ne__(self, other):
        r = self.__eq__(other)
        return r if r is NotImplemented else not r

    def __hash__(self):
        return hash(tuple(self._p))

    def __iter__(self):
        return (_Z(v) for v in self._p)

    def __len__(self):
        return len(self._p)

    def __getitem__(self, i):
        r = self._p[i]
        return [_Z(v) for v in r] if isinstance(i, slice) else _Z(r)

    def size(self):
        return _Z(sum(self._p))

    def length(self):
        return _Z(len(self._p))

    def conjugate(self):
        return Partition([sum(1 for v in self._p if v > j) for j in range(self._p[0])] if self._p else [])

    def hook_lengths(self):
        c = self.conjugate()._p
        return [[_Z(self._p[i] - j + c[j] - i - 1) for j in range(self._p[i])] for i in range(len(self._p))]

    def to_list(self):
        return [_Z(v) for v in self._p]


def _partitions(n, maxp, length=None, minp=1):
    if n == 0:
        if length is None or length == 0:
            yield []
        return
    if length is not None and length <= 0:
        return
    for k in range(min(n, maxp), minp - 1, -1):
        if length is not None and k * length < n:
            break
        for rest in _partitions(n - k, k, None if length is None else length - 1, minp):
            yield [k] + rest


class Partitions:
    """The partitions of n (keywords length, max_part, min_part).

    EXAMPLES::

        sage: Partitions(5)
        Partitions of the integer 5
        sage: Partitions(5).list()
        [[5], [4, 1], [3, 2], [3, 1, 1], [2, 2, 1], [2, 1, 1, 1], [1, 1, 1, 1, 1]]
        sage: Partitions(6, length=2).list(), Partitions(100).cardinality()
        ([[5, 1], [4, 2], [3, 3]], 190569292)
    """

    def __init__(self, n, length=None, max_part=None, min_part=None):
        self._n = _nonneg(n)
        self._length = None if length is None else _nonneg(length, "length")
        self._max = self._n if max_part is None else _nonneg(max_part, "max_part")
        self._min = 1 if min_part is None else max(1, _int(min_part))
        self._plain = length is None and max_part is None and min_part is None

    def __repr__(self):
        r = "Partitions of the integer %d" % self._n
        conds = []
        if self._length is not None:
            conds.append("of length %d" % self._length)
        if self._max != self._n:
            conds.append("whose parts are at most %d" % self._max)
        if self._min != 1:
            conds.append("whose parts are at least %d" % self._min)
        return r + (" satisfying constraints " + ", ".join(conds) if conds else "")

    def __iter__(self):
        for p in _partitions(self._n, self._max, self._length, self._min):
            yield Partition(p)

    def list(self):
        return list(self)

    def cardinality(self):
        if self._plain:
            return number_of_partitions(self._n)
        return _Z(sum(1 for _ in _partitions(self._n, self._max, self._length, self._min)))

    def __len__(self):
        return int(self.cardinality())

    def __contains__(self, p):
        try:
            p = Partition(p)
        except (ValueError, TypeError):
            return False
        return (sum(p._p) == self._n and (self._length is None or len(p._p) == self._length)
                and all(self._min <= v <= self._max for v in p._p))

    def first(self):
        return next(iter(self))

    def random_element(self):
        import random
        return random.choice(self.list())


class Compositions:
    """The compositions (ordered partitions) of n.

    EXAMPLES::

        sage: Compositions(4).cardinality()
        8
        sage: Compositions(3).list()
        [[1, 1, 1], [1, 2], [2, 1], [3]]
    """

    def __init__(self, n):
        self._n = _nonneg(n)

    def __repr__(self):
        return "Compositions of %d" % self._n

    def __iter__(self):
        def rec(n):
            if n == 0:
                yield []
                return
            for k in range(1, n + 1):
                for r in rec(n - k):
                    yield [k] + r
        for c in rec(self._n):
            yield [_Z(v) for v in c]

    def list(self):
        return list(self)

    def cardinality(self):
        return _Z(2 ** (self._n - 1) if self._n > 0 else 1)


# --------------------------------------------------------------- sets

class Set_object_enumerated:
    """A finite set, as Sage's Set([...]).

    EXAMPLES::

        sage: A = Set([1, 2, 3]); B = Set([3, 4])
        sage: A.union(B), A.intersection(B), A.difference(B)
        ({1, 2, 3, 4}, {3}, {1, 2})
        sage: A.cardinality(), 2 in A, A.subsets().cardinality()
        (3, True, 8)
    """

    def __init__(self, elts=()):
        self._s = frozenset(elts)

    def _sorted(self):
        return sorted(self._s, key=_key)

    def __repr__(self):
        return "{" + ", ".join(repr(v) for v in self._sorted()) + "}"

    def __iter__(self):
        return iter(self._sorted())

    def __len__(self):
        return len(self._s)

    def __contains__(self, v):
        return v in self._s

    def __eq__(self, other):
        if isinstance(other, Set_object_enumerated):
            return self._s == other._s
        if isinstance(other, (set, frozenset)):
            return self._s == other
        return NotImplemented

    def __ne__(self, other):
        r = self.__eq__(other)
        return r if r is NotImplemented else not r

    def __hash__(self):
        return hash(self._s)

    def __le__(self, other):
        return self._s <= _set(other)._s

    def __lt__(self, other):
        return self._s < _set(other)._s

    def cardinality(self):
        return _Z(len(self._s))

    def union(self, other):
        return Set_object_enumerated(self._s | _set(other)._s)

    def intersection(self, other):
        return Set_object_enumerated(self._s & _set(other)._s)

    def difference(self, other):
        return Set_object_enumerated(self._s - _set(other)._s)

    def symmetric_difference(self, other):
        return Set_object_enumerated(self._s ^ _set(other)._s)

    __or__ = union
    __and__ = intersection
    __sub__ = difference
    __xor__ = symmetric_difference

    def is_empty(self):
        return not self._s

    def issubset(self, other):
        return self._s <= _set(other)._s

    def issuperset(self, other):
        return self._s >= _set(other)._s

    def subsets(self, size=None):
        return Subsets(self, size)

    def list(self):
        return self._sorted()

    def set(self):
        return set(self._s)

    def frozenset(self):
        return self._s

    def an_element(self):
        return self._sorted()[0]



def _set(v):
    return v if isinstance(v, Set_object_enumerated) else Set_object_enumerated(v)


def Set(X=()):
    """The finite set of the elements of X (a list, tuple, set or range).

    EXAMPLES::

        sage: Set([3, 1, 2, 1])
        {1, 2, 3}
        sage: Set([])
        {}
    """
    if isinstance(X, Set_object_enumerated):
        return X
    return Set_object_enumerated(X)


class Subsets:
    """The subsets of a finite set (or of {1, ..., n}), optionally of a
    given size.

    EXAMPLES::

        sage: Subsets([1, 2, 3]).list()
        [{}, {1}, {2}, {3}, {1, 2}, {1, 3}, {2, 3}, {1, 2, 3}]
        sage: S = Subsets(4, 2); S
        Subsets of {1, 2, 3, 4} of size 2
        sage: S.cardinality()
        6
    """

    def __init__(self, s, k=None, submultiset=False):
        if submultiset:
            raise NotImplementedError("Subsets(..., submultiset=True) is not implemented in sagebrush yet")
        if _is_int(s):
            s = range(1, _nonneg(s) + 1)
        self._set = _set(s)
        self._k = None if k is None else _nonneg(k, "k")

    def __repr__(self):
        return "Subsets of %s" % self._set + ("" if self._k is None else " of size %d" % self._k)

    def __iter__(self):
        elts = self._set._sorted()
        sizes = range(len(elts) + 1) if self._k is None else [self._k]
        for k in sizes:
            for c in _it.combinations(elts, k):
                yield Set_object_enumerated(c)

    def list(self):
        return list(self)

    def cardinality(self):
        n = len(self._set)
        if self._k is None:
            return _Z(2 ** n)
        return _Z(_binom(n, self._k))

    def __len__(self):
        return int(self.cardinality())

    def __contains__(self, v):
        try:
            v = _set(v)
        except TypeError:
            return False
        return v._s <= self._set._s and (self._k is None or len(v) == self._k)


def _binom(n, k):
    if k < 0 or k > n:
        return 0
    r = 1
    for i in range(k):
        r = r * (n - i) // (i + 1)
    return r


class Combinations:
    """The combinations of the elements of a list (or of range(n)), of a
    given length or of every length.

    EXAMPLES::

        sage: Combinations([1, 2, 3], 2).list()
        [[1, 2], [1, 3], [2, 3]]
        sage: Combinations(4, 2).cardinality()
        6
    """

    def __init__(self, mset, k=None):
        if _is_int(mset):
            mset = list(range(_nonneg(mset)))
        self._m = list(mset)
        self._k = None if k is None else _nonneg(k, "k")
        self._reps, self._counts = _groups(self._m)

    def __repr__(self):
        return "Combinations of %s" % (self._m,) + ("" if self._k is None else " of length %d" % self._k)

    def __iter__(self):
        sizes = range(len(self._m) + 1) if self._k is None else [self._k]
        for k in sizes:
            for x in _choices(self._counts, k):
                yield [r for r, m in zip(self._reps, x) for _ in range(m)]

    def list(self):
        return list(self)

    def cardinality(self):
        if len(self._reps) == len(self._m):
            n = len(self._m)
            return _Z(2 ** n if self._k is None else _binom(n, self._k))
        return _Z(_count_choices(self._counts, self._k))

    def __len__(self):
        return int(self.cardinality())


# --------------------------------------------------------------- permutations

class Permutation:
    """A permutation of {1, ..., n} in one-line notation (or from cycles).

    EXAMPLES::

        sage: p = Permutation([2, 1, 3]); p
        [2, 1, 3]
        sage: p.cycle_tuples(), p.inverse(), p.sign(), p(1)
        ([(1, 2), (3,)], [2, 1, 3], -1, 2)
        sage: Permutation('(1,3)(2,4)')
        [3, 4, 1, 2]
    """

    def __init__(self, l):
        if isinstance(l, str):
            l = _from_cycle_string(l)
        elif isinstance(l, (list, tuple)) and l and all(isinstance(c, tuple) for c in l):
            l = _from_cycles(l)
        l = [_int(v) for v in l]
        if sorted(l) != list(range(1, len(l) + 1)):
            raise ValueError("%s is not a permutation of {1, ..., %d}" % (l, len(l)))
        self._l = l

    def __repr__(self):
        return repr(self._l)

    def __eq__(self, other):
        if isinstance(other, Permutation):
            return self._l == other._l
        if isinstance(other, (list, tuple)):
            return self._l == list(other)
        return NotImplemented

    def __ne__(self, other):
        r = self.__eq__(other)
        return r if r is NotImplemented else not r

    def __hash__(self):
        return hash(tuple(self._l))

    def __call__(self, i):
        return _Z(self._l[_int(i) - 1])

    def __iter__(self):
        return (_Z(v) for v in self._l)

    def __len__(self):
        return len(self._l)

    def __getitem__(self, i):
        r = self._l[i]
        return [_Z(v) for v in r] if isinstance(i, slice) else _Z(r)

    def size(self):
        return _Z(len(self._l))

    def inverse(self):
        inv = [0] * len(self._l)
        for i, v in enumerate(self._l):
            inv[v - 1] = i + 1
        return Permutation(inv)

    def cycle_tuples(self, singletons=True):
        seen, out = set(), []
        for i in range(1, len(self._l) + 1):
            if i in seen:
                continue
            c = [i]; seen.add(i); j = self._l[i - 1]
            while j != i:
                c.append(j); seen.add(j); j = self._l[j - 1]
            if singletons or len(c) > 1:
                out.append(tuple(_Z(v) for v in c))
        return out

    to_cycles = cycle_tuples

    def cycle_type(self):
        return Partition(sorted((len(c) for c in self.cycle_tuples()), reverse=True))

    def number_of_inversions(self):
        l = self._l
        return _Z(sum(1 for i in range(len(l)) for j in range(i + 1, len(l)) if l[i] > l[j]))

    def inversions(self):
        l = self._l
        return [(_Z(i + 1), _Z(j + 1)) for i in range(len(l)) for j in range(i + 1, len(l)) if l[i] > l[j]]

    def sign(self):
        return _Z(-1 if sum(len(c) - 1 for c in self.cycle_tuples()) % 2 else 1)

    signature = sign

    def is_even(self):
        return self.sign() == 1

    def descents(self):
        l = self._l
        return [_Z(i + 1) for i in range(len(l) - 1) if l[i] > l[i + 1]]

    def fixed_points(self):
        return [_Z(i + 1) for i, v in enumerate(self._l) if v == i + 1]

    def order(self):
        from math import gcd
        r = 1
        for c in self.cycle_tuples():
            r = r * len(c) // gcd(r, len(c))
        return _Z(r)

    def cycle_string(self):
        cs = self.cycle_tuples(singletons=False)
        return "".join("(" + ",".join(str(v) for v in c) + ")" for c in cs) or "()"


def _from_cycles(cycles):
    n = max((max(c) for c in cycles if c), default=0)
    l = list(range(1, n + 1))
    for c in cycles:
        for i, v in enumerate(c):
            l[_int(v) - 1] = _int(c[(i + 1) % len(c)])
    return l


def _from_cycle_string(s):
    cycles = []
    for part in s.replace(" ", "").split(")"):
        part = part.lstrip("(")
        if part:
            cycles.append(tuple(_int(int(v)) for v in part.split(",")))
    return _from_cycles(cycles)


class Permutations:
    """Permutations(n): the permutations of {1, ..., n}; Permutations(list)
    or Permutations(list, k): the arrangements of a list's elements (a
    multiset gives each distinct arrangement once).

    EXAMPLES::

        sage: Permutations(3)
        Standard permutations of 3
        sage: Permutations(3).list()
        [[1, 2, 3], [1, 3, 2], [2, 1, 3], [2, 3, 1], [3, 1, 2], [3, 2, 1]]
        sage: Permutations([1, 1, 2]).list(), Permutations(4).cardinality()
        ([[1, 1, 2], [1, 2, 1], [2, 1, 1]], 24)
    """

    def __init__(self, n, k=None):
        self._standard = False
        if _is_int(n):
            self._standard = k is None
            n = list(range(1, _nonneg(n) + 1))
        self._m = list(n)
        self._k = None if k is None else _nonneg(k, "k")
        self._reps, self._counts = _groups(self._m)

    def __repr__(self):
        if self._standard:
            return "Standard permutations of %d" % len(self._m)
        if self._k is None:
            return "Permutations of the set %s" % (self._m,) if len(self._reps) == len(self._m) else "Permutations of the multi-set %s" % (self._m,)
        return "Permutations of the set %s of length %d" % (self._m, self._k)

    def __iter__(self):
        k = len(self._m) if self._k is None else self._k
        for seq in _arrangements(self._counts, k):
            p = [self._reps[g] for g in seq]
            yield Permutation(p) if self._standard else p

    def list(self):
        return list(self)

    def cardinality(self):
        n = len(self._m)
        k = n if self._k is None else self._k
        if len(self._reps) == n:
            r = 1
            for i in range(k):
                r *= n - i
            return _Z(r if 0 <= k <= n else 0)
        return _Z(_count_arrangements(self._counts, k))

    def __len__(self):
        return int(self.cardinality())
