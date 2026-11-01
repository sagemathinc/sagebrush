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


# --------------------------------------------------------------- counting

def number_of_partitions(n):
    """The number of partitions of n.

    EXAMPLES::

        sage: number_of_partitions(10), number_of_partitions(100)
        (42, 190569292)
    """
    n = int(n)
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
    n, k = int(n), int(k)
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
    n, k = int(n), int(k)
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
    n = int(n)
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
        parts = [int(v) for v in parts]
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
            return self._p == [int(v) for v in other]
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
        self._n = int(n)
        self._length = None if length is None else int(length)
        self._max = self._n if max_part is None else int(max_part)
        self._min = 1 if min_part is None else max(1, int(min_part))
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
        self._n = int(n)

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

    def cartesian_product(self, other):
        return Set_object_enumerated(tuple(p) for p in _it.product(self._sorted(), _set(other)._sorted()))


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
        try:
            n = int(s)
            if n == s:
                s = range(1, n + 1)
        except (TypeError, ValueError):
            pass
        self._set = _set(s)
        self._k = None if k is None else int(k)

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
        try:
            n = int(mset)
            if n == mset:
                mset = list(range(n))
        except (TypeError, ValueError):
            pass
        self._m = list(mset)
        self._k = None if k is None else int(k)

    def __repr__(self):
        return "Combinations of %s" % (self._m,) + ("" if self._k is None else " of length %d" % self._k)

    def __iter__(self):
        sizes = range(len(self._m) + 1) if self._k is None else [self._k]
        seen = set()
        for k in sizes:
            for idx in _it.combinations(range(len(self._m)), k):
                c = [self._m[i] for i in idx]
                key = repr(c)
                if key in seen:
                    continue
                seen.add(key)
                yield c

    def list(self):
        return list(self)

    def cardinality(self):
        if len(set(map(repr, self._m))) == len(self._m):
            n = len(self._m)
            return _Z(2 ** n if self._k is None else _binom(n, self._k))
        return _Z(sum(1 for _ in self))

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
        l = [int(v) for v in l]
        if sorted(l) != list(range(1, len(l) + 1)):
            raise ValueError("%s is not a permutation of {1, ..., %d}" % (l, len(l)))
        self._l = l

    def __repr__(self):
        return repr(self._l)

    def __eq__(self, other):
        if isinstance(other, Permutation):
            return self._l == other._l
        if isinstance(other, (list, tuple)):
            return self._l == [int(v) for v in other]
        return NotImplemented

    def __ne__(self, other):
        r = self.__eq__(other)
        return r if r is NotImplemented else not r

    def __hash__(self):
        return hash(tuple(self._l))

    def __call__(self, i):
        return _Z(self._l[int(i) - 1])

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

    def to_matrix(self):
        n = len(self._l)
        return _sa().matrix([[1 if self._l[j] == i + 1 else 0 for j in range(n)] for i in range(n)])

    def cycle_string(self):
        cs = self.cycle_tuples(singletons=False)
        return "".join("(" + ",".join(str(v) for v in c) + ")" for c in cs) or "()"


def _from_cycles(cycles):
    n = max((max(c) for c in cycles if c), default=0)
    l = list(range(1, n + 1))
    for c in cycles:
        for i, v in enumerate(c):
            l[int(v) - 1] = int(c[(i + 1) % len(c)])
    return l


def _from_cycle_string(s):
    cycles = []
    for part in s.replace(" ", "").split(")"):
        part = part.lstrip("(")
        if part:
            cycles.append(tuple(int(v) for v in part.split(",")))
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
        try:
            m = int(n)
            if m == n:
                self._standard = k is None
                n = list(range(1, m + 1))
        except (TypeError, ValueError):
            pass
        self._m = list(n)
        self._k = None if k is None else int(k)

    def __repr__(self):
        if self._standard:
            return "Standard permutations of %d" % len(self._m)
        if self._k is None:
            return "Permutations of the set %s" % (self._m,) if len(set(map(repr, self._m))) == len(self._m) else "Permutations of the multi-set %s" % (self._m,)
        return "Permutations of the set %s of length %d" % (self._m, self._k)

    def __iter__(self):
        k = len(self._m) if self._k is None else self._k
        seen = set()
        for idx in _it.permutations(range(len(self._m)), k):
            p = [self._m[i] for i in idx]
            key = repr(p)
            if key in seen:
                continue
            seen.add(key)
            yield Permutation(p) if self._standard else p

    def list(self):
        return list(self)

    def cardinality(self):
        n = len(self._m)
        if len(set(map(repr, self._m))) == n:
            k = n if self._k is None else self._k
            r = 1
            for i in range(k):
                r *= n - i
            return _Z(r if 0 <= k <= n else 0)
        return _Z(sum(1 for _ in self))

    def __len__(self):
        return int(self.cardinality())
