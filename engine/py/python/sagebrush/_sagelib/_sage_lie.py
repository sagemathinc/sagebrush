"""Lie theory, as in Sage: Cartan types (finite, reducible and affine, with
Dynkin diagrams and Cartan matrices), root systems and their ambient spaces
(Bourbaki's conventions), Weyl groups as matrix groups (reduced words,
lengths, Bruhat order, reflections), Weyl character rings (Freudenthal's
multiplicity formula, Brauer-Klimyk tensor products, symmetric and exterior
powers, Frobenius-Schur indicators), weight rings and branching rules.
Printed as Sage prints them."""

import itertools
from fractions import Fraction as _F


def _sa():
    import sage_all
    return sage_all


def _q(x):
    """A Fraction from an int, Integer, Rational or Fraction."""
    if isinstance(x, _F):
        return _F(x.numerator, x.denominator)
    if isinstance(x, int):
        return _F(x)
    if hasattr(x, "numerator") and hasattr(x, "denominator"):
        n, d = x.numerator, x.denominator
        n = n() if callable(n) else n
        d = d() if callable(d) else d
        return _F(int(n), int(d))
    return _F(int(x))


def _out(f):
    """A Fraction as a Sage Integer or Rational."""
    return _sa()._q(_F(f))


def _fs(f):
    return str(f.numerator) if f.denominator == 1 else "%d/%d" % (f.numerator, f.denominator)


class Family:
    """A finite family (an ordered dict), as Sage's Finite family {...}.

    EXAMPLES::

        sage: F = RootSystem("A2").ambient_space().simple_roots(); F
        Finite family {1: (1, -1, 0), 2: (0, 1, -1)}
        sage: F[2], len(F)
        ((0, 1, -1), 2)
    """

    def __init__(self, keys, values, name=None):
        self._keys = list(keys)
        self._d = dict(zip(self._keys, values))
        self._name = name

    def __getitem__(self, k):
        return self._d[k]

    def __iter__(self):
        return iter([self._d[k] for k in self._keys])

    def __len__(self):
        return len(self._keys)

    def __contains__(self, v):
        return v in self._d.values()

    def keys(self):
        """The keys.

        EXAMPLES::

            sage: RootSystem("A2").ambient_space().simple_roots().keys()
            [1, 2]
        """
        return list(self._keys)

    def values(self):
        """The values.

        EXAMPLES::

            sage: RootSystem("A2").ambient_space().simple_roots().values()
            [(1, -1, 0), (0, 1, -1)]
        """
        return [self._d[k] for k in self._keys]

    def items(self):
        """The (key, value) pairs.

        EXAMPLES::

            sage: RootSystem("A2").ambient_space().simple_roots().items()
            [(1, (1, -1, 0)), (2, (0, 1, -1))]
        """
        return [(k, self._d[k]) for k in self._keys]

    def list(self):
        """The values, as a list.

        EXAMPLES::

            sage: RootSystem("A2").ambient_space().simple_roots().list()
            [(1, -1, 0), (0, 1, -1)]
        """
        return self.values()

    def cardinality(self):
        """The number of elements.

        EXAMPLES::

            sage: RootSystem("A2").ambient_space().simple_roots().cardinality()
            2
        """
        return len(self._keys)

    def inverse_family(self):
        """The family with keys and values exchanged (sorted by key).

        EXAMPLES::

            sage: RootSystem("A2").ambient_space().simple_roots().inverse_family()
            Finite family {(1, -1, 0): 1, (0, 1, -1): 2}
        """
        ks = list(self._keys)
        try:
            ks = sorted(ks, key=lambda k: self._d[k])
        except TypeError:
            pass
        return Family([self._d[k] for k in ks], ks)

    def __repr__(self):
        return "Finite family {" + ", ".join("%r: %r" % (k, self._d[k]) for k in self._keys) + "}"


# ---------------------------------------------------------------- Cartan types

_LETTERS = "ABCDEFG"


def _finite_ok(l, n):
    return (l == "A" and n >= 1 or l in "BC" and n >= 1 or l == "D" and n >= 2
            or l == "E" and n in (6, 7, 8) or l == "F" and n == 4 or l == "G" and n == 2)


def _fmt_dict(d):
    return "{" + ", ".join("%r: %r" % (k, d[k]) for k in sorted(d)) + "}"


class CartanType_:
    """A Cartan type: finite irreducible ['A', 3], reducible A1xB2, affine
    ['A', 2, 1] (untwisted), BC and duals of affine types (^*), optionally
    relabelled.

    EXAMPLES::

        sage: CartanType("E8"), CartanType(["C", 3, 1]), CartanType("A2xB2")
        (['E', 8], ['C', 3, 1], A2xB2)
    """

    def __init__(self, letter, n, affine=False, dual=False, relabel=None, components=None):
        self._letter, self._n, self._affine, self._dual = letter, n, affine, dual
        self._relabel = relabel
        self._components = components

    # -- basic data
    def __repr__(self):
        if self._components:
            return "x".join(c._short() for c in self._components)
        if self._letter == "BC":
            s = "['BC', %d, 2]" % self._n
        elif self._affine:
            s = "['%s', %d, 1]" % (self._letter, self._n)
        else:
            s = "['%s', %d]" % (self._letter, self._n)
        if self._dual and (self._affine or self._letter == "BC"):
            s += "^*"
        if self._relabel:
            s += " relabelled by " + _fmt_dict(self._relabel)
        return s

    def _short(self):
        if self._components:
            return repr(self)
        s = "%s%d" % (self._letter, self._n)
        if self._affine or self._letter == "BC":
            s += "~"
        if self._dual and (self._affine or self._letter == "BC"):
            s += "*"
        return s

    def _key(self):
        if self._components:
            return tuple(c._key() for c in self._components)
        return (self._letter, self._n, self._affine, self._dual,
                tuple(sorted(self._relabel.items())) if self._relabel else None)

    def __eq__(self, other):
        if isinstance(other, (str, list, tuple)):
            try:
                other = CartanType(other)
            except Exception:
                return False
        return isinstance(other, CartanType_) and self._key() == other._key()

    def __ne__(self, other):
        return not self == other

    def __hash__(self):
        return hash(self._key())

    def __lt__(self, other):
        return repr(self) < repr(other)

    def __getitem__(self, i):
        if self._components:
            raise IndexError("reducible Cartan type")
        t = [self._letter, self._n] + ([1] if self._affine else [2] if self._letter == "BC" else [])
        return t[i]

    def __iter__(self):
        return iter([self[i] for i in range(3 if self._affine or self._letter == "BC" else 2)])

    def type(self):
        """The letter.

        EXAMPLES::

            sage: CartanType("A2").type()
            'A'
        """
        return self._letter

    def rank(self):
        """The rank (number of nodes of the Dynkin diagram).

        EXAMPLES::

            sage: CartanType("A2xB2").rank(), CartanType(['A', 2, 1]).rank()
            (4, 3)
        """
        return len(self.index_set())

    def index_set(self):
        """The labels of the nodes.

        EXAMPLES::

            sage: CartanType("B3").index_set(), CartanType(['A', 2, 1]).index_set()
            ((1, 2, 3), (0, 1, 2))
        """
        if self._components:
            return tuple(range(1, sum(c.rank() for c in self._components) + 1))
        if self._affine or self._letter == "BC":
            return tuple(range(0, self._n + 1))
        return tuple(range(1, self._n + 1))

    def is_finite(self):
        """Whether the type is finite.

        EXAMPLES::

            sage: CartanType("G2").is_finite(), CartanType("G2~").is_finite()
            (True, False)
        """
        return not (self._affine or self._letter == "BC")

    def is_affine(self):
        """Whether the type is affine.

        EXAMPLES::

            sage: CartanType("A2").is_affine(), CartanType("A2~").is_affine()
            (False, True)
        """
        return not self.is_finite()

    def is_irreducible(self):
        """Whether the type is irreducible.

        EXAMPLES::

            sage: CartanType("A2").is_irreducible(), CartanType("A1xA1").is_irreducible()
            (True, False)
        """
        return not self._components

    def is_reducible(self):
        """Whether the type is reducible.

        EXAMPLES::

            sage: CartanType("A1xA1").is_reducible()
            True
        """
        return bool(self._components)

    def is_crystallographic(self):
        """Whether the Weyl group is crystallographic (always, here).

        EXAMPLES::

            sage: CartanType("G2").is_crystallographic()
            True
        """
        return True

    def is_untwisted_affine(self):
        """Whether the type is untwisted affine.

        EXAMPLES::

            sage: CartanType(["A", 2, 1]).is_untwisted_affine(), CartanType(["A", 3, 2]).is_untwisted_affine()
            (True, False)
        """
        return self._affine and not self._dual and self._letter != "BC"

    def is_simply_laced(self):
        """Whether all roots have the same length.

        EXAMPLES::

            sage: CartanType("A1xA1").is_simply_laced(), CartanType("B3").is_simply_laced()
            (True, False)
        """
        if self._components:
            return all(c.is_simply_laced() for c in self._components)
        if self._letter in "ADE" or self._letter == "A":
            return not (self._letter == "A" and self._n == 1 and self._affine)
        return False

    def component_types(self):
        """The irreducible components.

        EXAMPLES::

            sage: CartanType("A2xB2").component_types()
            [['A', 2], ['B', 2]]
        """
        return list(self._components) if self._components else [self]

    def root_system(self):
        """The root system.

        EXAMPLES::

            sage: CartanType("A2").root_system()
            Root system of type ['A', 2]
        """
        return RootSystem(self)

    def cartan_matrix(self):
        """The Cartan matrix (entries <alpha_i^vee, alpha_j>).

        EXAMPLES::

            sage: CartanType("B3").cartan_matrix()
            [ 2 -1  0]
            [-1  2 -1]
            [ 0 -2  2]
            sage: CartanType(['A', 2, 1]).cartan_matrix()
            [ 2 -1 -1]
            [-1  2 -1]
            [-1 -1  2]
        """
        A = _cartan(self)
        return _sa().matrix(_sa().ZZ, [[int(A[i][j]) for j in self.index_set()] for i in self.index_set()])

    def dynkin_diagram(self):
        """The Dynkin diagram (printed as ASCII art).

        EXAMPLES::

            sage: CartanType("F4").dynkin_diagram()
            O---O=>=O---O
            1   2   3   4
            F4
        """
        return DynkinDiagram_(self)

    def dual(self):
        """The dual Cartan type (coroots and roots exchanged).

        EXAMPLES::

            sage: CartanType("B4").dual(), CartanType(['B', 3, 1]).dual()
            (['C', 4], ['B', 3, 1]^*)
            sage: CartanType("F4").dual()
            ['F', 4] relabelled by {1: 4, 2: 3, 3: 2, 4: 1}
        """
        if self._components:
            return CartanType_(None, None, components=[c.dual() for c in self._components])
        l, n = self._letter, self._n
        if self.is_finite():
            if self._relabel and l in "FG":
                return CartanType_(l, n)
            if l == "B" and n >= 2:
                return CartanType_("C", n)
            if l == "C" and n >= 2:
                return CartanType_("B", n)
            if l == "B" and n == 1:
                return CartanType_("C", 1)
            if l == "C" and n == 1:
                return CartanType_("B", 1)
            if l == "F":
                return CartanType_("F", 4, relabel={1: 4, 2: 3, 3: 2, 4: 1})
            if l == "G":
                return CartanType_("G", 2, relabel={1: 2, 2: 1})
            return self
        if l in "ADE" and l != "BC" and self._affine and not (l == "A" and n == 1 and False):
            return self
        return CartanType_(l, n, affine=self._affine, dual=not self._dual, relabel=self._relabel)

    def affine(self):
        """The untwisted affine type.

        EXAMPLES::

            sage: CartanType("E6").affine()
            ['E', 6, 1]
        """
        return CartanType_(self._letter, self._n, affine=True)

    def classical(self):
        """The classical (finite) type of an affine type.

        EXAMPLES::

            sage: CartanType(['A', 4, 1]).classical(), CartanType(['A', 3, 2]).classical()
            (['A', 4], ['C', 2])
        """
        if self.is_finite():
            return self
        if self._letter == "BC":
            return CartanType_("C", self._n)
        c = CartanType_(self._letter, self._n)
        if self._dual:
            c = c.dual()
        if self._relabel:
            r = dict(c._relabel or {})
            m = {}
            for k in c.index_set():
                v = r.get(k, k)
                m[k] = self._relabel.get(v, v)
            m = {k: v for k, v in m.items()}
            c = CartanType_(c._letter, c._n, relabel=None if all(k == v for k, v in m.items()) else m)
        return c

    def a(self):
        """The marks (coefficients of delta, the null root, in the simple roots).

        EXAMPLES::

            sage: CartanType(['B', 5, 1]).a()
            Finite family {0: 1, 1: 1, 2: 2, 3: 2, 4: 2, 5: 2}
        """
        return _null_vector(self, False)

    def acheck(self):
        """The comarks.

        EXAMPLES::

            sage: CartanType(['B', 5, 1]).acheck()
            Finite family {0: 1, 1: 1, 2: 2, 3: 2, 4: 2, 5: 1}
        """
        return _null_vector(self, True)

    def special_node(self):
        """The special node 0 of an affine type.

        EXAMPLES::

            sage: CartanType(["B", 3, 1]).special_node()
            0
        """
        return 0

    def symmetrizer(self):
        """The symmetrizer d (d_i a_ij = d_j a_ji, integral and coprime).

        EXAMPLES::

            sage: CartanType("B3").symmetrizer(), CartanType("G2").symmetrizer()
            (Finite family {1: 2, 2: 2, 3: 1}, Finite family {1: 1, 2: 3})
        """
        A = _cartan(self)
        I = self.index_set()
        # d_i a_ij = d_j a_ji
        d = {I[0]: _F(1)}
        changed = True
        while changed:
            changed = False
            for i in I:
                for j in I:
                    if i in d and j not in d and A[i][j] != 0:
                        d[j] = d[i] * A[i][j] / A[j][i]
                        changed = True
        L = 1
        for v in d.values():
            L = L * v.denominator // _gcd(L, v.denominator)
        return Family(I, [_out(d[i] * L) for i in I])


def _gcd(a, b):
    while b:
        a, b = b, a % b
    return abs(a)


def CartanType(*args):
    """A Cartan type from ['A', 3], "A3", "A1xB2", ['A', 2, 1], "A2~", ...

    EXAMPLES::

        sage: CartanType("D5"), CartanType(['A', 4, 1]), CartanType("E6~")
        (['D', 5], ['A', 4, 1], ['E', 6, 1])
        sage: CartanType(['A', 3, 2]), CartanType(['D', 4, 3])
        (['B', 2, 1]^*, ['G', 2, 1]^* relabelled by {0: 0, 1: 2, 2: 1})
        sage: CartanType("A1xA1")
        A1xA1
    """
    if len(args) == 1:
        t = args[0]
    else:
        t = list(args)
    if isinstance(t, CartanType_):
        return t
    if isinstance(t, str):
        s = t.strip()
        if "x" in s:
            return CartanType_(None, None, components=[CartanType(p) for p in s.split("x")])
        dual = s.endswith("*")
        s = s.rstrip("*")
        aff = s.endswith("~")
        s = s.rstrip("~")
        if s.startswith("BC"):
            ct = CartanType_("BC", int(s[2:]))
        else:
            l, n = s[0], int(s[1:])
            if not _finite_ok(l, n):
                raise ValueError("%s is not a valid Cartan type" % t)
            ct = CartanType_(l, n, affine=aff)
        return ct.dual() if dual else ct
    if isinstance(t, (list, tuple)):
        if t and all(isinstance(c, (list, tuple, CartanType_)) for c in t):
            return CartanType_(None, None, components=[CartanType(c) for c in t])
        l, n = str(t[0]), int(t[1])
        if len(t) == 2:
            if not _finite_ok(l, n):
                raise ValueError("%s is not a valid Cartan type" % (t,))
            return CartanType_(l, n)
        r = int(t[2])
        if r == 1:
            return CartanType_(l, n, affine=True)
        if l == "BC" and r == 2:
            return CartanType_("BC", n)
        if l == "A" and r == 2:
            if n % 2 == 0:
                return CartanType_("BC", n // 2)
            return CartanType_("B", (n + 1) // 2, affine=True, dual=True)
        if l == "D" and r == 2:
            return CartanType_("C", n - 1, affine=True, dual=True)
        if l == "E" and n == 6 and r == 2:
            return CartanType_("F", 4, affine=True, dual=True)
        if l == "D" and n == 4 and r == 3:
            return CartanType_("G", 2, affine=True, dual=True, relabel={0: 0, 1: 2, 2: 1})
    raise ValueError("%s is not a valid Cartan type" % (t,))


# ------------------------------------------------------------ Cartan matrices

def _cartan(ct):
    """The Cartan matrix as a dict of dicts of Fractions over index_set."""
    if ct._components:
        A, off = {}, 0
        allI = ct.index_set()
        for c in ct._components:
            B = _cartan(c)
            I = c.index_set()
            for a, i in enumerate(I):
                A[off + a + 1] = {j: _F(0) for j in allI}
            for a, i in enumerate(I):
                for b, j in enumerate(I):
                    A[off + a + 1][off + b + 1] = B[i][j]
            off += len(I)
        return A
    if ct.is_finite() and not ct._relabel:
        sr = _finite_space(ct._letter, ct._n).simple
        I = ct.index_set()
        return {i: {j: 2 * _dot(sr[i - 1], sr[j - 1]) / _dot(sr[i - 1], sr[i - 1]) for j in I} for i in I}
    if ct._relabel:
        base = CartanType_(ct._letter, ct._n, affine=ct._affine, dual=ct._dual)
        B = _cartan(base)
        r = ct._relabel
        A = {}
        for i in B:
            A[r.get(i, i)] = {}
            for j in B[i]:
                A[r.get(i, i)][r.get(j, j)] = B[i][j]
        return A
    l, n = ct._letter, ct._n
    I = ct.index_set()
    if l == "BC":
        A = {i: {j: _F(0) for j in I} for i in I}
        for i in I:
            A[i][i] = _F(2)
        if n == 1:
            A[0][1], A[1][0] = _F(-4), _F(-1)
            return A
        for i in range(0, n):
            A[i][i + 1] = A[i + 1][i] = _F(-1)
        A[0][1] = _F(-2)
        A[n - 1][n] = _F(-2)
        return A
    if ct._dual:
        B = _cartan(CartanType_(l, n, affine=True))
        return {i: {j: B[j][i] for j in I} for i in I}
    # untwisted affine: alpha_0 = -theta
    S = _finite_space(l, n)
    roots = S.simple + [_neg(_highest_root(S))]
    idx = list(range(1, n + 1)) + [0]
    A = {}
    for a, i in enumerate(idx):
        A[i] = {}
        for b, j in enumerate(idx):
            A[i][j] = 2 * _dot(roots[a], roots[b]) / _dot(roots[a], roots[a])
    if l == "A" and n == 1:
        A[0][1] = A[1][0] = _F(-2)
    return A


def _null_vector(ct, co):
    A = _cartan(ct)
    I = ct.index_set()
    M = [[A[j][i] if co else A[i][j] for j in I] for i in I]
    # kernel vector by Gaussian elimination
    n = len(I)
    rows = [r[:] for r in M]
    piv = []
    r = 0
    for c in range(n):
        p = next((k for k in range(r, n) if rows[k][c] != 0), None)
        if p is None:
            continue
        rows[r], rows[p] = rows[p], rows[r]
        inv = 1 / rows[r][c]
        rows[r] = [x * inv for x in rows[r]]
        for k in range(n):
            if k != r and rows[k][c] != 0:
                f = rows[k][c]
                rows[k] = [x - f * y for x, y in zip(rows[k], rows[r])]
        piv.append(c)
        r += 1
    free = [c for c in range(n) if c not in piv][0]
    v = [_F(0)] * n
    v[free] = _F(1)
    for k, c in enumerate(piv):
        v[c] = -rows[k][free]
    L = 1
    for x in v:
        L = L * x.denominator // _gcd(L, x.denominator)
    v = [x * L for x in v]
    g = 0
    for x in v:
        g = _gcd(g, int(x))
    v = [x / g for x in v]
    if v[0] < 0:
        v = [-x for x in v]
    return Family(I, [_out(x) for x in v])


# ------------------------------------------------------------ Dynkin diagrams

def _lab(labels):
    return "".join(str(x).ljust(4) for x in labels)


def _chain(bonds):
    """A row of nodes joined by bonds ('---', '=>=', '=<=', '   ')."""
    return "O" + "".join(b + "O" for b in bonds)


def _art(ct):
    """The ASCII art lines (without the name line) of an irreducible type."""
    l, n = ct._letter, ct._n
    rl = ct._relabel or {}
    L = lambda i: rl.get(i, i)
    dual = ct._dual
    if ct.is_finite():
        if l == "A" or (l in "BC" and n == 1):
            return [_chain(["---"] * (n - 1)), _lab([L(i) for i in range(1, n + 1)])]
        if l in "BC":
            arrow = "=>=" if l == "B" else "=<="
            return [_chain(["---"] * (n - 2) + [arrow]), _lab([L(i) for i in range(1, n + 1)])]
        if l == "D":
            if n == 2:
                return [_chain(["   "]), _lab([L(1), L(2)])]
            col = 4 * (n - 3)
            return [" " * col + "O %s" % L(n), " " * col + "|", " " * col + "|",
                    _chain(["---"] * (n - 2)), _lab([L(i) for i in range(1, n)])]
        if l == "E":
            return ["        O %s" % L(2), "        |", "        |",
                    _chain(["---"] * (n - 2)), _lab([L(i) for i in [1] + list(range(3, n + 1))])]
        if l == "F":
            arrow = "=<=" if dual else "=>="
            return [_chain(["---", "=>=", "---"]), _lab([L(i) for i in range(1, 5)])]
        if l == "G":
            return ["  3", _chain(["=<="]), _lab([L(1), L(2)])]
    if l == "BC":
        if n == 1:
            return ["  4", _chain(["=<="]), _lab([L(0), L(1)])]
        return [_chain(["=<="] + ["---"] * (n - 2) + ["=<="]), _lab([L(i) for i in range(0, n + 1)])]
    if l == "A":
        if n == 1:
            return [_chain(["<=>"]), _lab([L(0), L(1)])]
        w = 4 * (n - 1) - 1
        return [str(L(0)), "O" + "-" * w + "+", "|" + " " * w + "|", "|" + " " * w + "|",
                _chain(["---"] * (n - 1)), _lab([L(i) for i in range(1, n + 1)])]
    if l == "B":
        arrow = "=<=" if dual else "=>="
        if n == 2:
            return [_chain([("=<=" if dual else "=>="), ("=>=" if dual else "=<=")]), _lab([L(0), L(2), L(1)])]
        return ["    O %s" % L(0), "    |", "    |", _chain(["---"] * (n - 2) + [arrow]),
                _lab([L(i) for i in range(1, n + 1)])]
    if l == "C":
        a, b = ("=<=", "=>=") if dual else ("=>=", "=<=")
        return [_chain([a] + ["---"] * (n - 2) + [b]), _lab([L(i) for i in range(0, n + 1)])]
    if l == "D":
        if n == 4:
            return ["    O %s" % L(4), "    |", "    |", _chain(["---", "---"]),
                    "%s   |%s  %s   " % (L(1), L(2), L(3)), "    |", "    O %s" % L(0)]
        col = 4 * (n - 3)
        return ["  %s O" % L(0) + " " * (col - 5) + "O %s" % L(n), "    |" + " " * (col - 5) + "|",
                "    |" + " " * (col - 5) + "|", _chain(["---"] * (n - 2)), _lab([L(i) for i in range(1, n)])]
    if l == "E":
        if n == 6:
            return ["        O %s" % L(0), "        |", "        |", "        O %s" % L(2), "        |", "        |",
                    _chain(["---"] * 4), _lab([L(i) for i in [1, 3, 4, 5, 6]])]
        if n == 7:
            return ["            O %s" % L(2), "            |", "            |", _chain(["---"] * 6),
                    _lab([L(i) for i in [0, 1, 3, 4, 5, 6, 7]])]
        return ["        O %s" % L(2), "        |", "        |", _chain(["---"] * 7),
                _lab([L(i) for i in [1, 3, 4, 5, 6, 7, 8, 0]])]
    if l == "F":
        return [_chain(["---", "---", "=<=" if dual else "=>=", "---"]), _lab([L(i) for i in range(0, 5)])]
    if l == "G":
        return ["  3", _chain(["=>=" if dual else "=<=", "---"]), _lab([L(1), L(2), L(0)])]
    raise NotImplementedError("Dynkin diagram of %r" % (ct,))


class DynkinDiagram_:
    """A Dynkin diagram (printed as ASCII art).

    EXAMPLES::

        sage: DynkinDiagram("G2")
          3
        O=<=O
        1   2   
        G2
    """

    def __init__(self, ct):
        self._ct = ct

    def cartan_type(self):
        """The Cartan type.

        EXAMPLES::

            sage: DynkinDiagram("G2").cartan_type()
            ['G', 2]
        """
        return self._ct

    def cartan_matrix(self):
        """The Cartan matrix.

        EXAMPLES::

            sage: DynkinDiagram("G2").cartan_matrix()
            [ 2 -3]
            [-1  2]
        """
        return self._ct.cartan_matrix()

    def index_set(self):
        """The labels of the nodes.

        EXAMPLES::

            sage: DynkinDiagram("E6").index_set()
            (1, 2, 3, 4, 5, 6)
        """
        return self._ct.index_set()

    def rank(self):
        """The number of nodes.

        EXAMPLES::

            sage: DynkinDiagram("E6").rank()
            6
        """
        return self._ct.rank()

    def edges(self):
        """The edges (i, j, -a_ji) of the diagram.

        EXAMPLES::

            sage: CartanType("B3").dynkin_diagram().edges()
            [(1, 2, 1), (2, 1, 1), (2, 3, 2), (3, 2, 1)]
        """
        A = _cartan(self._ct)
        I = self._ct.index_set()
        return [(i, j, int(-A[j][i])) for i in I for j in I if i != j and A[j][i] != 0]

    def __repr__(self):
        ct = self._ct
        if ct._components:
            lines, off = [], 0
            for c in ct._components:
                art = _art(c)
                k = c.rank()
                art[-1] = _lab(range(off + 1, off + k + 1)) if c.is_finite() else art[-1]
                lines += art
                off += k
            return "\n".join(lines + [repr(ct)])
        name = ct._short()
        if ct._relabel:
            name += " relabelled by " + _fmt_dict(ct._relabel)
        return "\n".join(_art(ct) + [name])

    def __eq__(self, other):
        return isinstance(other, DynkinDiagram_) and self._ct == other._ct

    def __hash__(self):
        return hash(self._ct)


def DynkinDiagram(*args):
    """The Dynkin diagram of a Cartan type.

    EXAMPLES::

        sage: DynkinDiagram("D5")
                O 5
                |
                |
        O---O---O---O
        1   2   3   4
        D5
    """
    return CartanType(*args).dynkin_diagram()


# --------------------------------------------------- finite ambient spaces

def _dot(u, v):
    return sum((a * b for a, b in zip(u, v)), _F(0))


def _neg(u):
    return tuple(-a for a in u)


def _addv(u, v):
    return tuple(a + b for a, b in zip(u, v))


def _subv(u, v):
    return tuple(a - b for a, b in zip(u, v))


def _smul(c, u):
    return tuple(c * a for a in u)


def _e(dim, *pairs):
    v = [_F(0)] * dim
    for i, c in pairs:
        v[i] += _F(c)
    return tuple(v)


_H = _F(1, 2)


class _Finite:
    """The ambient space data of a finite irreducible type: dimension, simple
    roots, positive roots (Sage's order) and fundamental weights."""

    def __init__(self, letter, n):
        self.letter, self.n = letter, n
        l = letter
        if l == "A":
            d = n + 1
            simple = [_e(d, (i, 1), (i + 1, -1)) for i in range(n)]
            pos = [_e(d, (i, 1), (j, -1)) for j in range(1, d) for i in range(j)]
            fw = [_e(d, *[(k, 1) for k in range(i + 1)]) for i in range(n)]
        elif l in "BC":
            d = n
            last = _e(d, (n - 1, 1 if l == "B" else 2))
            simple = [_e(d, (i, 1), (i + 1, -1)) for i in range(n - 1)] + [last]
            if l == "B":
                pos = []
                for i in range(n):
                    for j in range(i + 1, n):
                        pos += [_e(d, (i, 1), (j, -1)), _e(d, (i, 1), (j, 1))]
                pos += [_e(d, (i, 1)) for i in range(n)]
            else:
                pos = [_e(d, (i, 1), (j, 1)) for j in range(n) for i in range(j)]
                pos += [_e(d, (i, 1), (j, -1)) for j in range(n) for i in range(j)]
                pos += [_e(d, (i, 2)) for i in range(n)]
            fw = None
        elif l == "D":
            d = n
            simple = [_e(d, (i, 1), (i + 1, -1)) for i in range(n - 1)] + [_e(d, (n - 2, 1), (n - 1, 1))]
            pos = [_e(d, (i, 1), (j, 1)) for j in range(n) for i in range(j)]
            pos += [_e(d, (i, 1), (j, -1)) for j in range(n) for i in range(j)]
            fw = None
        elif l == "E":
            d = 8
            h = [_H] * 8
            a1 = (_H, -_H, -_H, -_H, -_H, -_H, -_H, _H)
            simple = [a1, _e(8, (0, 1), (1, 1))] + [_e(8, (i - 1, -1), (i, 1)) for i in range(1, n - 1)]
            m = {6: 5, 7: 6, 8: 8}[n]
            pos = [_e(8, (i, 1), (j, 1)) for i in range(m) for j in range(i + 1, m)]
            pos += [_e(8, (i, -1), (j, 1)) for i in range(m) for j in range(i + 1, m)]
            if n == 7:
                pos.append(_e(8, (6, -1), (7, 1)))
            k = {6: 5, 7: 6, 8: 7}[n]
            tail = {6: (-_H, -_H, _H), 7: (-_H, _H), 8: (_H,)}[n]
            parity = {6: 0, 7: 1, 8: 0}[n]
            for signs in itertools.product((1, -1), repeat=k):
                if sum(1 for s in signs if s < 0) % 2 == parity:
                    pos.append(tuple(_F(s, 2) for s in signs) + tail)
            fw = None
        elif l == "F":
            d = 4
            simple = [_e(4, (1, 1), (2, -1)), _e(4, (2, 1), (3, -1)), _e(4, (3, 1)), (_H, -_H, -_H, -_H)]
            pos = [_e(4, (i, 1)) for i in range(4)]
            pos += [_e(4, (i, 1), (j, 1)) for i in range(4) for j in range(i + 1, 4)]
            pos += [_e(4, (i, 1), (j, -1)) for i in range(4) for j in range(i + 1, 4)]
            for signs in itertools.product((1, -1), repeat=3):
                pos.append((_H,) + tuple(_F(s, 2) for s in signs))
            fw = None
        elif l == "G":
            d = 3
            simple = [_e(3, (1, 1), (2, -1)), _e(3, (0, 1), (1, -2), (2, 1))]
            pos = [(0, 1, -1), (1, -2, 1), (1, -1, 0), (1, 0, -1), (1, 1, -2), (2, -1, -1)]
            pos = [tuple(_F(x) for x in r) for r in pos]
            fw = None
        self.dim, self.simple, self.pos = d, simple, pos
        if fw is None:
            fw = _dual_basis(simple)
        self.fw = fw


def _dual_basis(simple):
    """The weights in the span of the simple roots dual to their coroots."""
    n = len(simple)
    A = [[2 * _dot(simple[j], simple[k]) / _dot(simple[j], simple[j]) for k in range(n)] for j in range(n)]
    # omega_i = sum_k c_ik alpha_k with sum_k c_ik A[j][k] = delta_ij: C = (A^T)^-1
    At = [[A[k][j] for k in range(n)] for j in range(n)]
    C = _inverse(At)
    d = len(simple[0])
    return [tuple(sum((C[i][k] * simple[k][x] for k in range(n)), _F(0)) for x in range(d)) for i in range(n)]


def _inverse(M):
    n = len(M)
    R = [list(M[i]) + [_F(int(i == j)) for j in range(n)] for i in range(n)]
    for c in range(n):
        p = next(k for k in range(c, n) if R[k][c] != 0)
        R[c], R[p] = R[p], R[c]
        inv = 1 / R[c][c]
        R[c] = [x * inv for x in R[c]]
        for k in range(n):
            if k != c and R[k][c] != 0:
                f = R[k][c]
                R[k] = [x - f * y for x, y in zip(R[k], R[c])]
    return [r[n:] for r in R]


_FINITE = {}


def _finite_space(l, n):
    if (l, n) not in _FINITE:
        _FINITE[(l, n)] = _Finite(l, n)
    return _FINITE[(l, n)]


def _highest_root(S):
    rho = _addv_all(S.fw, S.dim)
    return max(S.pos, key=lambda r: (_dot(r, rho), _dot(r, r)))


def _addv_all(vs, d):
    s = tuple([_F(0)] * d)
    for v in vs:
        s = _addv(s, v)
    return s


class _Data:
    """Ambient data of a finite (possibly reducible) Cartan type."""

    def __init__(self, ct):
        self.ct = ct
        comps = ct._components or [ct]
        dims = []
        simple, pos, fw = [], [], []
        off = 0
        total = 0
        for c in comps:
            total += _finite_space(c._letter, c._n).dim
        for c in comps:
            S = _finite_space(c._letter, c._n)
            pad = lambda v: tuple([_F(0)] * off) + tuple(v) + tuple([_F(0)] * (total - off - S.dim))
            simple += [pad(v) for v in S.simple]
            pos += [pad(v) for v in S.pos]
            fw += [pad(v) for v in S.fw]
            dims.append((off, S.dim, c))
            off += S.dim
        self.dim, self.simple, self.pos, self.fw, self.blocks = total, simple, pos, fw, dims
        if ct._relabel:
            # relabelled finite types (F4, G2 duals): same roots, new labels
            pass
        self.I = ct.index_set()
        self.rho = _addv_all(fw, total)
        self.coroots = [_smul(2 / _dot(a, a), a) for a in simple]
        self.poscoroots = [_smul(2 / _dot(a, a), a) for a in pos]
        self.rhocheck = _smul(_F(1, 2), _addv_all(self.poscoroots, total))
        self._gram_inv = _inverse([[_dot(a, b) for b in simple] for a in simple])

    def _dom(self, v):
        """(dominant representative, number of reflections used)."""
        v = tuple(v)
        k = 0
        while True:
            for a, c in zip(self.simple, self.coroots):
                p = _dot(v, c)
                if p < 0:
                    v = _subv(v, _smul(p, a))
                    k += 1
                    break
            else:
                return v, k

    def _isdom(self, v):
        return all(_dot(v, c) >= 0 for c in self.coroots)

    def _root_coords(self, v):
        """Coordinates of v in the simple roots (None if not in their span)."""
        b = [_dot(a, v) for a in self.simple]
        c = [sum((self._gram_inv[i][j] * b[j] for j in range(len(b))), _F(0)) for i in range(len(b))]
        w = tuple([_F(0)] * self.dim)
        for ci, a in zip(c, self.simple):
            w = _addv(w, _smul(ci, a))
        return c if w == tuple(v) else None


# -------------------------------------------------------------- root systems

class RootSystem_:
    """A root system of a given Cartan type.

    EXAMPLES::

        sage: R = RootSystem(["G", 2]); R
        Root system of type ['G', 2]
        sage: R.ambient_space().roots()
        [(0, 1, -1), (1, -2, 1), (1, -1, 0), (1, 0, -1), (1, 1, -2), (2, -1, -1), (0, -1, 1), (-1, 2, -1), (-1, 1, 0), (-1, 0, 1), (-1, -1, 2), (-2, 1, 1)]
    """

    def __init__(self, ct):
        self._ct = ct

    def __repr__(self):
        return "Root system of type %r" % (self._ct,)

    def __eq__(self, other):
        return isinstance(other, RootSystem_) and self._ct == other._ct

    def __hash__(self):
        return hash(("RS", self._ct))

    def cartan_type(self):
        """The Cartan type.

        EXAMPLES::

            sage: RootSystem("C3").cartan_type()
            ['C', 3]
        """
        return self._ct

    def cartan_matrix(self):
        """The Cartan matrix.

        EXAMPLES::

            sage: RootSystem(['B', 2, 1]).cartan_matrix()
            [ 2  0 -1]
            [ 0  2 -1]
            [-2 -2  2]
        """
        return self._ct.cartan_matrix()

    def dynkin_diagram(self):
        """The Dynkin diagram.

        EXAMPLES::

            sage: RootSystem("C3").dynkin_diagram()
            O---O=<=O
            1   2   3   
            C3
        """
        return self._ct.dynkin_diagram()

    def index_set(self):
        """The index set.

        EXAMPLES::

            sage: RootSystem("C3").index_set()
            (1, 2, 3)
        """
        return self._ct.index_set()

    def is_finite(self):
        """Whether the root system is finite.

        EXAMPLES::

            sage: RootSystem("C3").is_finite(), RootSystem("C3~").is_finite()
            (True, False)
        """
        return self._ct.is_finite()

    def ambient_space(self, base_ring=None):
        """The ambient space (Bourbaki's coordinates).

        EXAMPLES::

            sage: RootSystem("A3").ambient_space().simple_roots()
            Finite family {1: (1, -1, 0, 0), 2: (0, 1, -1, 0), 3: (0, 0, 1, -1)}
        """
        if not self._ct.is_finite():
            raise NotImplementedError("ambient spaces of affine types are not available in sagebrush yet")
        return AmbientSpace(self)

    def root_lattice(self):
        """The root lattice.

        EXAMPLES::

            sage: RootSystem("B3").root_lattice()
            Root lattice of the Root system of type ['B', 3]
        """
        return _RootLatticeRealization(self, "Root lattice")

    def root_space(self, base_ring=None):
        """The root space.

        EXAMPLES::

            sage: RootSystem("B3").root_space()
            Root space over the Rational Field of the Root system of type ['B', 3]
        """
        return _RootLatticeRealization(self, "Root space over the Rational Field")

    def weight_lattice(self, extended=False):
        """The weight lattice (extended for affine types: with delta).

        EXAMPLES::

            sage: RootSystem("A2~").weight_lattice(extended=True)
            Extended weight lattice of the Root system of type ['A', 2, 1]
        """
        return WeightLattice(self, extended)

    def weight_space(self, base_ring=None, extended=False):
        """The weight space.

        EXAMPLES::

            sage: RootSystem("B3").weight_space()
            Weight space over the Rational Field of the Root system of type ['B', 3]
        """
        return _RootLatticeRealization(self, "Weight space over the Rational Field")

    def coroot_lattice(self):
        """The coroot lattice.

        EXAMPLES::

            sage: RootSystem("C3").coroot_lattice()
            Coroot lattice of the Root system of type ['C', 3]
        """
        return _RootLatticeRealization(self, "Coroot lattice")

    def dual(self):
        """The dual root system.

        EXAMPLES::

            sage: RootSystem("C3").dual()
            Root system of type ['B', 3]
        """
        return RootSystem_(self._ct.dual())


def RootSystem(*args):
    """The root system of a Cartan type.

    EXAMPLES::

        sage: RootSystem("A1xA1"), RootSystem("B2")
        (Root system of type A1xA1, Root system of type ['B', 2])
    """
    return RootSystem_(CartanType(*args))


class _RootLatticeRealization:
    def __init__(self, R, name):
        self._R, self._name = R, name

    def __repr__(self):
        return "%s of the %r" % (self._name, self._R)


class AmbientVector:
    """An element of the ambient space of a root system (a vector).

    EXAMPLES::

        sage: L = RootSystem("B3").ambient_space(); v = L.simple_root(1) + 2*L.simple_root(3); v
        (1, -1, 2)
        sage: v/2, v.parent()
        ((1/2, -1/2, 1), Ambient space of the Root system of type ['B', 3])
    """

    __slots__ = ("_P", "_v")

    def __init__(self, P, v):
        self._P, self._v = P, tuple(_F(x) for x in v)

    def parent(self):
        """The ambient space.

        EXAMPLES::

            sage: L = RootSystem("B3").ambient_space(); L.rho().parent()
            Ambient space of the Root system of type ['B', 3]
        """
        return self._P

    def __repr__(self):
        return "(" + ", ".join(_fs(x) for x in self._v) + ")"

    def _latex_(self):
        return repr(self)

    def __hash__(self):
        return hash(self._v)

    def __eq__(self, other):
        if isinstance(other, AmbientVector):
            return self._v == other._v
        if isinstance(other, (int, _F)) and other == 0:
            return all(x == 0 for x in self._v)
        if isinstance(other, (tuple, list)):
            return self._v == tuple(_q(x) for x in other)
        return NotImplemented

    def __ne__(self, other):
        r = self.__eq__(other)
        return r if r is NotImplemented else not r

    def _key(self):
        return [(i, x) for i, x in enumerate(self._v) if x != 0]

    def __lt__(self, other):
        return self._key() < other._key()

    def __le__(self, other):
        return self._key() <= other._key()

    def __gt__(self, other):
        return self._key() > other._key()

    def __ge__(self, other):
        return self._key() >= other._key()

    def __add__(self, other):
        if isinstance(other, int) and other == 0:
            return self
        if not isinstance(other, AmbientVector):
            return NotImplemented
        return AmbientVector(self._P, _addv(self._v, other._v))

    def __radd__(self, other):
        if isinstance(other, int) and other == 0:
            return self
        return NotImplemented

    def __sub__(self, other):
        if not isinstance(other, AmbientVector):
            return NotImplemented
        return AmbientVector(self._P, _subv(self._v, other._v))

    def __neg__(self):
        return AmbientVector(self._P, _neg(self._v))

    def __pos__(self):
        return self

    def __mul__(self, c):
        if isinstance(c, (int, _F)):
            return AmbientVector(self._P, _smul(_q(c), self._v))
        return NotImplemented

    __rmul__ = __mul__

    def __truediv__(self, c):
        return AmbientVector(self._P, _smul(1 / _q(c), self._v))

    def __getitem__(self, i):
        return _out(self._v[i])

    def __len__(self):
        return len(self._v)

    def __iter__(self):
        return iter([(i, _out(x)) for i, x in enumerate(self._v) if x != 0])

    def to_vector(self):
        """The coordinates as a vector.

        EXAMPLES::

            sage: RootSystem("B3").ambient_space().simple_root(1).to_vector()
            (1, -1, 0)
        """
        return _sa().vector(_sa().QQ, [_out(x) for x in self._v])

    _vector_ = to_vector

    def support(self):
        """The indices of the nonzero coordinates.

        EXAMPLES::

            sage: L = RootSystem("B3").ambient_space(); L((0, 2, -1)).support()
            [1, 2]
        """
        return [i for i, x in enumerate(self._v) if x != 0]

    def coefficients(self):
        """The nonzero coordinates.

        EXAMPLES::

            sage: L = RootSystem("B3").ambient_space(); L((0, 2, -1/2)).coefficients()
            [2, -1/2]
        """
        return [_out(x) for x in self._v if x != 0]

    def scalar(self, other):
        """The standard inner product.

        EXAMPLES::

            sage: L = RootSystem("B3").ambient_space(); a = L.simple_roots()
            sage: a[1].scalar(a[2]), a[1].scalar(a[1])
            (-1, 2)
        """
        o = other._v if isinstance(other, AmbientVector) else tuple(_q(x) for x in other)
        return _out(_dot(self._v, o))

    inner_product = dot_product = scalar

    def associated_coroot(self):
        """The coroot 2v/(v, v).

        EXAMPLES::

            sage: RootSystem("C3").ambient_space().simple_root(3).associated_coroot()
            (0, 0, 1)
        """
        return AmbientVector(self._P, _smul(2 / _dot(self._v, self._v), self._v))

    def is_dominant(self):
        """Whether <v, alpha_i^vee> >= 0 for all simple roots.

        EXAMPLES::

            sage: L = RootSystem("B3").ambient_space()
            sage: L.rho().is_dominant(), L.simple_root(1).is_dominant()
            (True, False)
        """
        return self._P._data._isdom(self._v)

    def is_dominant_weight(self):
        """Whether this is a dominant integral weight.

        EXAMPLES::

            sage: L = RootSystem("B3").ambient_space(); L((1, 0, 0)).is_dominant_weight(), L((1/3, 0, 0)).is_dominant_weight()
            (True, False)
        """
        D = self._P._data
        return D._isdom(self._v) and all(_dot(self._v, c).denominator == 1 for c in D.coroots)

    def dominant(self):
        """The dominant element of the Weyl orbit.

        EXAMPLES::

            sage: L = RootSystem("B3").ambient_space(); L((0, -2, 1)).dominant()
            (2, 1, 0)
        """
        return AmbientVector(self._P, self._P._data._dom(self._v)[0])

    to_dominant_chamber = dominant

    def simple_reflection(self, i):
        """The image under s_i.

        EXAMPLES::

            sage: L = RootSystem("B3").ambient_space(); L((1, 2, 3)).simple_reflection(3)
            (1, 2, -3)
        """
        D = self._P._data
        k = list(D.I).index(i)
        return AmbientVector(self._P, _subv(self._v, _smul(_dot(self._v, D.coroots[k]), D.simple[k])))

    def reflection(self, root):
        """The reflection in the hyperplane orthogonal to a root.

        EXAMPLES::

            sage: L = RootSystem("B3").ambient_space(); L((1, 2, 3)).reflection(L((0, 1, 1)))
            (1, -3, -2)
        """
        r = root._v
        return AmbientVector(self._P, _subv(self._v, _smul(2 * _dot(self._v, r) / _dot(r, r), r)))

    def coerce_to_sl(self):
        """For type A: the projection to the sum-zero hyperplane.

        EXAMPLES::

            sage: RootSystem("A2").ambient_space().rho().coerce_to_sl()
            (1, 0, -1)
        """
        D = self._P._data
        v = list(self._v)
        for off, d, c in D.blocks:
            if c._letter == "A":
                m = sum(v[off:off + d], _F(0)) / d
                for i in range(off, off + d):
                    v[i] -= m
        return AmbientVector(self._P, v)

    def weyl_action(self, w):
        """The action of a Weyl group element.

        EXAMPLES::

            sage: L = RootSystem("B3").ambient_space(); w = L.weyl_group().simple_reflection(1); L((1, 2, 3)).weyl_action(w)
            (2, 1, 3)
        """
        return w.action(self)

    def __copy__(self):
        return self


class AmbientSpace:
    """The ambient space of a finite root system.

    EXAMPLES::

        sage: L = RootSystem("B3").ambient_space(); L
        Ambient space of the Root system of type ['B', 3]
    """

    def __init__(self, R):
        self._R = R
        self._ct = R._ct
        self._data = _data(R._ct)

    def __repr__(self):
        return "Ambient space of the %r" % (self._R,)

    def __eq__(self, other):
        return isinstance(other, AmbientSpace) and self._ct == other._ct

    def __hash__(self):
        return hash(("AS", self._ct))

    def __call__(self, v):
        """A vector from its coordinates.

        EXAMPLES::

            sage: L = RootSystem("B3").ambient_space(); L((1, 2, 3))
            (1, 2, 3)
        """
        if isinstance(v, AmbientVector):
            return AmbientVector(self, v._v)
        if isinstance(v, int) and v == 0:
            return self.zero()
        return AmbientVector(self, [_q(x) for x in v])

    from_vector = __call__

    def _v(self, t):
        return AmbientVector(self, t)

    def root_system(self):
        """The root system.

        EXAMPLES::

            sage: L = RootSystem("B3").ambient_space(); L.root_system()
            Root system of type ['B', 3]
        """
        return self._R

    def cartan_type(self):
        """The Cartan type.

        EXAMPLES::

            sage: L = RootSystem("B3").ambient_space(); L.cartan_type()
            ['B', 3]
        """
        return self._ct

    def index_set(self):
        """The index set.

        EXAMPLES::

            sage: L = RootSystem("B3").ambient_space(); L.index_set()
            (1, 2, 3)
        """
        return self._ct.index_set()

    def dimension(self):
        """The dimension.

        EXAMPLES::

            sage: RootSystem("A3").ambient_space().dimension(), RootSystem("E6").ambient_space().dimension()
            (4, 8)
        """
        return _sa().Integer(self._data.dim)

    def rank(self):
        """The rank.

        EXAMPLES::

            sage: L = RootSystem("B3").ambient_space(); L.rank()
            3
        """
        return self._ct.rank()

    def zero(self):
        """The zero vector.

        EXAMPLES::

            sage: L = RootSystem("B3").ambient_space(); L.zero()
            (0, 0, 0)
        """
        return AmbientVector(self, [0] * self._data.dim)

    def basis(self):
        """The standard basis.

        EXAMPLES::

            sage: RootSystem("B3").ambient_space().basis()
            Finite family {0: (1, 0, 0), 1: (0, 1, 0), 2: (0, 0, 1)}
        """
        d = self._data.dim
        return Family(range(d), [self._v(_e(d, (i, 1))) for i in range(d)])

    def monomial(self, i):
        """The i-th standard basis vector.

        EXAMPLES::

            sage: L = RootSystem("B3").ambient_space(); L.monomial(1)
            (0, 1, 0)
        """
        return self.basis()[i]

    def simple_roots(self):
        """The simple roots.

        EXAMPLES::

            sage: RootSystem("B1").ambient_space().simple_roots()
            Finite family {1: (1)}
        """
        return Family(self._data.I, [self._v(a) for a in self._data.simple])

    def simple_root(self, i):
        """The i-th simple root.

        EXAMPLES::

            sage: L = RootSystem("B3").ambient_space(); L.simple_root(3)
            (0, 0, 1)
        """
        return self.simple_roots()[i]

    def simple_coroots(self):
        """The simple coroots.

        EXAMPLES::

            sage: RootSystem("G2").ambient_space().simple_coroots()
            Finite family {1: (0, 1, -1), 2: (1/3, -2/3, 1/3)}
        """
        return Family(self._data.I, [self._v(a) for a in self._data.coroots])

    def simple_coroot(self, i):
        """The i-th simple coroot.

        EXAMPLES::

            sage: L = RootSystem("B3").ambient_space(); L.simple_coroot(3)
            (0, 0, 2)
        """
        return self.simple_coroots()[i]

    def alpha(self):
        """The simple roots.

        EXAMPLES::

            sage: RootSystem("A2").ambient_space().alpha()
            Finite family {1: (1, -1, 0), 2: (0, 1, -1)}
        """
        return self.simple_roots()

    def fundamental_weights(self):
        """The fundamental weights.

        EXAMPLES::

            sage: RootSystem("B3").ambient_space().fundamental_weights()
            Finite family {1: (1, 0, 0), 2: (1, 1, 0), 3: (1/2, 1/2, 1/2)}
            sage: RootSystem("D4").ambient_space().fundamental_weights()
            Finite family {1: (1, 0, 0, 0), 2: (1, 1, 0, 0), 3: (1/2, 1/2, 1/2, -1/2), 4: (1/2, 1/2, 1/2, 1/2)}
        """
        return Family(self._data.I, [self._v(a) for a in self._data.fw])

    def fundamental_weight(self, i):
        """The i-th fundamental weight.

        EXAMPLES::

            sage: L = RootSystem("B3").ambient_space(); L.fundamental_weight(3)
            (1/2, 1/2, 1/2)
        """
        return self.fundamental_weights()[i]

    def rho(self):
        """The half sum of the positive roots.

        EXAMPLES::

            sage: RootSystem("B3").ambient_space().rho(), RootSystem("G2").ambient_space().rho()
            ((5/2, 3/2, 1/2), (3, -1, -2))
        """
        return self._v(self._data.rho)

    def positive_roots(self):
        """The positive roots (Sage's order).

        EXAMPLES::

            sage: RootSystem("B2").ambient_space().positive_roots()
            [(1, -1), (1, 1), (1, 0), (0, 1)]
        """
        return [self._v(a) for a in self._data.pos]

    def negative_roots(self):
        """The negative roots.

        EXAMPLES::

            sage: RootSystem("A2").ambient_space().negative_roots()
            [(-1, 1, 0), (-1, 0, 1), (0, -1, 1)]
        """
        return [self._v(_neg(a)) for a in self._data.pos]

    def roots(self):
        """The roots: the positive ones, then their negatives.

        EXAMPLES::

            sage: RootSystem("B2").ambient_space().roots()
            [(1, -1), (1, 1), (1, 0), (0, 1), (-1, 1), (-1, -1), (-1, 0), (0, -1)]
        """
        return self.positive_roots() + self.negative_roots()

    def positive_coroots(self):
        """The positive coroots.

        EXAMPLES::

            sage: RootSystem("B2").ambient_space().positive_coroots()
            [(1, -1), (1, 1), (2, 0), (0, 2)]
        """
        return [self._v(a) for a in self._data.poscoroots]

    def highest_root(self):
        """The highest root (of an irreducible type).

        EXAMPLES::

            sage: RootSystem("B3").ambient_space().highest_root()
            (1, 1, 0)
        """
        return self._v(_highest_root(self._data))

    def weyl_group(self, prefix=None):
        """The Weyl group acting on the ambient space.

        EXAMPLES::

            sage: RootSystem("B2").ambient_space().weyl_group()
            Weyl Group of type ['B', 2] (as a matrix group acting on the ambient space)
        """
        return WeylGroup_(self, prefix)

    def weyl_dimension(self, la):
        """The dimension of the irreducible representation of highest weight
        la (Weyl's dimension formula).

        EXAMPLES::

            sage: L = RootSystem("E8").ambient_space()
            sage: [L.weyl_dimension(f) for f in L.fundamental_weights()]
            [3875, 147250, 6696000, 6899079264, 146325270, 2450240, 30380, 248]
            sage: L.weyl_dimension(L.rho())
            1329227995784915872903807060280344576
        """
        v = la._v if isinstance(la, AmbientVector) else tuple(_q(x) for x in la)
        return _out(_weyl_dim(self._data, v))



def _sl(D, v):
    v = list(v)
    for off, d, c in D.blocks:
        if c._letter == "A":
            m = sum(v[off:off + d], _F(0)) / d
            for i in range(off, off + d):
                v[i] -= m
    return tuple(v)


def _weyl_dim(D, v):
    lr = _addv(v, D.rho)
    r = _F(1)
    for a in D.pos:
        r *= _dot(lr, a) / _dot(D.rho, a)
    return r


_DATA = {}


def _data(ct):
    if ct not in _DATA:
        _DATA[ct] = _Data(ct)
    return _DATA[ct]


# ---------------------------------------------------------------- Weyl groups

def _matmul(A, B):
    n = len(A)
    m = len(B[0])
    k = len(B)
    return tuple(tuple(sum((A[i][t] * B[t][j] for t in range(k) if A[i][t]), _F(0)) for j in range(m)) for i in range(n))


def _matvec(A, v):
    return tuple(sum((a * x for a, x in zip(row, v) if a), _F(0)) for row in A)


def _ident(n):
    return tuple(tuple(_F(int(i == j)) for j in range(n)) for i in range(n))


class WeylGroup_:
    """A Weyl group as a matrix group, on the ambient space of a finite root
    system or on the root space (or extended weight lattice) of an affine one.
    Elements print as matrices, or as words in the simple reflections when a
    prefix is given.

    EXAMPLES::

        sage: W = WeylGroup("B2", prefix="s"); W
        Weyl Group of type ['B', 2] (as a matrix group acting on the ambient space)
        sage: sorted(W)
        [s2*s1*s2*s1, s1*s2*s1, s2*s1*s2, s1*s2, s2*s1, s1, s2, 1]
    """

    def __init__(self, space, prefix=None, kind="ambient", parabolic=None):
        self._space = space
        self._prefix = prefix
        self._kind = kind
        self._parabolic = parabolic
        if kind == "ambient":
            D = space._data
            self._ct = space._ct
            self._I = list(D.I)
            n = D.dim
            self._gens = {}
            for i, a, c in zip(D.I, D.simple, D.coroots):
                # s(v) = v - <v, c> a: matrix I - a c^T
                self._gens[i] = tuple(tuple(_F(int(r == s)) - a[r] * c[s] for s in range(n)) for r in range(n))
            self._roots = {i: a for i, a in zip(D.I, D.simple)}
            self._rho = D.rho
            self._dim = n
        else:
            ct = space._ct if hasattr(space, "_ct") else space
            self._ct = ct
            A = _cartan(ct)
            I = list(ct.index_set())
            self._I = I
            n = len(I)
            if kind == "root":
                self._dim = n
                self._gens = {}
                for a, i in enumerate(I):
                    # s_i(alpha_j) = alpha_j - a_ij alpha_i; column j is the image of alpha_j
                    M = [[_F(int(r == s)) for s in range(n)] for r in range(n)]
                    for b, j in enumerate(I):
                        M[a][b] -= A[i][j]
                    self._gens[i] = tuple(tuple(r) for r in M)
                self._roots = {i: _e(n, (a, 1)) for a, i in enumerate(I)}
            else:
                # extended weight lattice: basis Lambda_0..Lambda_n, delta
                self._dim = n + 1
                self._gens = {}
                acheck = [_q(x) for x in ct.acheck().values()]
                # simple root alpha_i = sum_j a_ji Lambda_j (+ delta for i = 0)
                alpha = {}
                for a, i in enumerate(I):
                    v = [A[j][i] for j in I] + [_F(1) if i == I[0] else _F(0)]
                    alpha[i] = tuple(v)
                self._alpha = alpha
                for a, i in enumerate(I):
                    # s_i(Lambda_j) = Lambda_j - delta_ij alpha_i; s_i(delta) = delta
                    cols = []
                    for b, j in enumerate(I):
                        col = [_F(int(r == b)) for r in range(n + 1)]
                        if j == i:
                            col = [x - y for x, y in zip(col, alpha[i])]
                        cols.append(col)
                    cols.append([_F(int(r == n)) for r in range(n + 1)])
                    self._gens[i] = tuple(tuple(cols[s][r] for s in range(n + 1)) for r in range(n + 1))
                self._roots = alpha
            self._rho = None
        if parabolic is not None:
            self._I = list(parabolic)
        self._one = WeylGroupElement(self, _ident(self._dim))

    def __repr__(self):
        on = {"ambient": "the ambient space", "root": "the root space",
              "weight": "the extended weight lattice"}[self._kind]
        s = "Weyl Group of type %r (as a matrix group acting on %s)" % (self._ct, on)
        if self._parabolic is not None:
            return "Parabolic Subgroup of the " + s
        return s

    def cartan_type(self):
        """The Cartan type.

        EXAMPLES::

            sage: W = WeylGroup("A3", prefix="s"); s1, s2, s3 = W.simple_reflections(); W.cartan_type()
            ['A', 3]
        """
        return self._ct

    def index_set(self):
        """The index set.

        EXAMPLES::

            sage: W = WeylGroup("A3", prefix="s"); s1, s2, s3 = W.simple_reflections(); W.index_set()
            (1, 2, 3)
        """
        return tuple(self._I)

    def domain(self):
        """The space it acts on.

        EXAMPLES::

            sage: W = WeylGroup("A3", prefix="s"); s1, s2, s3 = W.simple_reflections(); W.domain()
            Ambient space of the Root system of type ['A', 3]
        """
        return self._space

    def lattice(self):
        """The space it acts on.

        EXAMPLES::

            sage: W = WeylGroup("A3", prefix="s"); s1, s2, s3 = W.simple_reflections(); W.lattice()
            Ambient space of the Root system of type ['A', 3]
        """
        return self._space

    def one(self):
        """The identity.

        EXAMPLES::

            sage: W = WeylGroup("A3", prefix="s"); s1, s2, s3 = W.simple_reflections(); W.one()
            1
        """
        return self._one

    def unit(self):
        """The identity.

        EXAMPLES::

            sage: W = WeylGroup("A3", prefix="s"); s1, s2, s3 = W.simple_reflections(); W.unit()
            1
        """
        return self._one

    identity = one

    def __call__(self, x):
        """The element with the given matrix.

        EXAMPLES::

            sage: W = WeylGroup("A1"); W([[0, 1], [1, 0]])
            [0 1]
            [1 0]
        """
        if isinstance(x, WeylGroupElement):
            return x
        if x == 1:
            return self._one
        rows = [[_q(a) for a in r] for r in x]
        return WeylGroupElement(self, tuple(tuple(r) for r in rows))

    def simple_reflection(self, i):
        """The simple reflection s_i.

        EXAMPLES::

            sage: WeylGroup("A3").simple_reflection(1)
            [0 1 0 0]
            [1 0 0 0]
            [0 0 1 0]
            [0 0 0 1]
        """
        return WeylGroupElement(self, self._gens[i])

    def simple_reflections(self):
        """The simple reflections.

        EXAMPLES::

            sage: WeylGroup(['A', 2, 1], prefix="s").classical().simple_reflections()
            Finite family {1: s1, 2: s2}
        """
        return Family(self._I, [self.simple_reflection(i) for i in self._I])

    def gens(self):
        """The simple reflections, as a tuple.

        EXAMPLES::

            sage: W = WeylGroup("A3", prefix="s"); s1, s2, s3 = W.simple_reflections(); W.gens()
            (s1, s2, s3)
        """
        return tuple(self.simple_reflections())

    def is_finite(self):
        """Whether the group is finite.

        EXAMPLES::

            sage: WeylGroup("A3").is_finite(), WeylGroup(["A", 3, 1]).is_finite()
            (True, False)
        """
        return self._kind == "ambient" or self._parabolic is not None and _parabolic_finite(self)

    def cardinality(self):
        """The order.

        EXAMPLES::

            sage: WeylGroup("E8").cardinality()
            696729600
            sage: WeylGroup(['A', 2, 1]).cardinality()
            +Infinity
        """
        if self._kind != "ambient" and self._parabolic is None:
            return _sa().oo
        if self._kind == "ambient":
            return _sa().Integer(_weyl_order(self._ct))
        return _sa().Integer(len(self.list()))

    order = cardinality

    def __len__(self):
        return int(self.cardinality())

    def classical(self):
        """The classical Weyl group (parabolic subgroup) of an affine one.

        EXAMPLES::

            sage: W = WeylGroup(['A', 2, 1], prefix="s"); W.classical()
            Parabolic Subgroup of the Weyl Group of type ['A', 2, 1] (as a matrix group acting on the root space)
        """
        W = WeylGroup_(self._space, self._prefix, self._kind, parabolic=[i for i in self._I if i != 0])
        return W

    def long_element(self):
        """The longest element.

        EXAMPLES::

            sage: W = WeylGroup("A3", prefix="s"); W.long_element()
            s1*s2*s3*s1*s2*s1
        """
        w = self._one
        while True:
            for i in self._I:
                if not w.has_descent(i, side="right"):
                    w = w * self.simple_reflection(i)
                    break
            else:
                return w

    def __iter__(self):
        # breadth first by length
        seen = {self._one._m}
        level = [self._one]
        while level:
            for w in level:
                yield w
            nxt = []
            for w in level:
                for i in self._I:
                    if not w.has_descent(i, side="right"):
                        u = w * self.simple_reflection(i)
                        if u._m not in seen:
                            seen.add(u._m)
                            nxt.append(u)
            level = nxt

    def list(self):
        """The elements, by increasing length.

        EXAMPLES::

            sage: W = WeylGroup("A2", prefix="s"); len(W.list())
            6
        """
        return list(iter(self))

    def __contains__(self, x):
        return isinstance(x, WeylGroupElement) and x._W is self

    def reflections(self):
        """The reflections, indexed by the positive roots.

        EXAMPLES::

            sage: W = WeylGroup("B3", prefix="s"); ref = W.reflections(); ref
            Finite family {(1, -1, 0): s1, (0, 1, -1): s2, (0, 0, 1): s3, ...}
        """
        S = self._space
        D = S._data
        keys = [S._v(a) for a in D.pos]
        vals = []
        n = self._dim
        for a in D.pos:
            c = _smul(2 / _dot(a, a), a)
            vals.append(WeylGroupElement(self, tuple(tuple(_F(int(r == s)) - a[r] * c[s] for s in range(n)) for r in range(n))))
        return _ReflFamily(keys, vals, D)

    def positive_roots(self):
        """The positive roots of the domain.

        EXAMPLES::

            sage: WeylGroup("A2").positive_roots()
            [(1, -1, 0), (1, 0, -1), (0, 1, -1)]
        """
        return self._space.positive_roots()

    def bruhat_interval(self, x, y):
        """The elements z with x <= z <= y in the Bruhat order.

        EXAMPLES::

            sage: W = WeylGroup("A2", prefix="s"); s1, s2 = W.simple_reflections()
            sage: W.bruhat_interval(s1, s1*s2*s1)
            [s1*s2*s1, s2*s1, s1*s2, s1]
        """
        if not x.bruhat_le(y):
            return []
        refl = self.reflections().values()
        out, level = [], [y]
        seen = {y._m}
        while level:
            out += level
            nxt = []
            for z in level:
                lz = z.length()
                for t in refl:
                    u = t * z
                    if u._m not in seen and u.length() == lz - 1 and x.bruhat_le(u):
                        seen.add(u._m)
                        nxt.append(u)
            level = nxt
        return out

    def bruhat_graph(self, x, y):
        """The Bruhat graph of the interval [x, y].

        EXAMPLES::

            sage: W = WeylGroup("A3", prefix="s"); s1, s2, s3 = W.simple_reflections()
            sage: W.bruhat_graph(s2, s2*s1*s3*s2)
            Digraph on 10 vertices
        """
        els = self.bruhat_interval(x, y)
        refl = self.reflections().values()
        edges = []
        for u in els:
            for v in els:
                if u.length() < v.length() and any((u * t)._m == v._m for t in refl):
                    edges.append((u, v))
        G = _sa().DiGraph()
        for u in els:
            G.add_vertex(u)
        for u, v in edges:
            G.add_edge(u, v)
        return G

    def an_element(self):
        """An element (the product of the simple reflections).

        EXAMPLES::

            sage: W = WeylGroup("A3", prefix="s"); s1, s2, s3 = W.simple_reflections(); W.an_element()
            s1*s2*s3
        """
        w = self._one
        for i in self._I:
            w = w * self.simple_reflection(i)
        return w

    def random_element(self):
        """A random element.

        EXAMPLES::

            sage: W = WeylGroup("A3", prefix="s"); s1, s2, s3 = W.simple_reflections(); W.random_element() in W
            True
        """
        import random
        w = self._one
        for _ in range(3 * len(self._I) + 3):
            w = w * self.simple_reflection(random.choice(self._I))
        return w


def _parabolic_finite(W):
    return True


def _weyl_order(ct):
    o = 1
    for c in ct.component_types():
        l, n = c._letter, c._n
        if l == "A":
            f = 1
            for k in range(2, n + 2):
                f *= k
        elif l in "BC":
            f = 2 ** n
            for k in range(2, n + 1):
                f *= k
        elif l == "D":
            f = 2 ** (n - 1)
            for k in range(2, n + 1):
                f *= k
        else:
            f = {("E", 6): 51840, ("E", 7): 2903040, ("E", 8): 696729600, ("F", 4): 1152, ("G", 2): 12}[(l, n)]
        o *= f
    return o


class _ReflFamily(Family):
    def __init__(self, keys, vals, D):
        Family.__init__(self, keys, vals)
        self._D = D

    def __repr__(self):
        k = len(self._D.simple)
        sk = [AmbientVector(self._keys[0]._P, a) for a in self._D.simple]
        return "Finite family {" + ", ".join("%r: %r" % (a, self._d[a]) for a in sk) + ", ...}"


class WeylGroupElement:
    """An element of a Weyl group (a matrix).

    EXAMPLES::

        sage: W = WeylGroup("A3", prefix="s"); s1, s2, s3 = W.simple_reflections(); w = s1*s2; w
        s1*s2
        sage: w.matrix()
        [0 0 1 0]
        [1 0 0 0]
        [0 1 0 0]
        [0 0 0 1]
    """

    __slots__ = ("_W", "_m", "_word")

    def __init__(self, W, m):
        self._W, self._m = W, m
        self._word = None

    def parent(self):
        """The Weyl group.

        EXAMPLES::

            sage: W = WeylGroup("A3", prefix="s"); s1, s2, s3 = W.simple_reflections(); s1.parent()
            Weyl Group of type ['A', 3] (as a matrix group acting on the ambient space)
        """
        return self._W

    def matrix(self):
        """The matrix (on the domain).

        EXAMPLES::

            sage: WeylGroup("B2").simple_reflection(2).matrix()
            [ 1  0]
            [ 0 -1]
        """
        return _sa().matrix(_sa().QQ, [[_out(x) for x in r] for r in self._m])

    def __hash__(self):
        return hash(self._m)

    def __eq__(self, other):
        return isinstance(other, WeylGroupElement) and self._m == other._m

    def __ne__(self, other):
        return not self == other

    def _flat(self):
        return [x for r in self._m for x in r]

    def __lt__(self, other):
        return self._flat() < other._flat()

    def __le__(self, other):
        return self._flat() <= other._flat()

    def __gt__(self, other):
        return self._flat() > other._flat()

    def __ge__(self, other):
        return self._flat() >= other._flat()

    def __mul__(self, other):
        if isinstance(other, WeylGroupElement):
            return WeylGroupElement(self._W, _matmul(self._m, other._m))
        return NotImplemented

    def __pow__(self, k):
        k = int(k)
        r = self._W._one
        b = self if k >= 0 else self.inverse()
        for _ in range(abs(k)):
            r = r * b
        return r

    def inverse(self):
        """The inverse.

        EXAMPLES::

            sage: W = WeylGroup("A3", prefix="s"); s1, s2, s3 = W.simple_reflections(); (s1*s2).inverse()
            s2*s1
        """
        # orthogonal on the ambient space; in general invert the matrix
        return WeylGroupElement(self._W, tuple(tuple(r) for r in _inverse([list(r) for r in self._m])))

    __invert__ = inverse

    def _positive(self, v):
        W = self._W
        if W._kind == "ambient":
            return _dot(v, W._rho) > 0
        if W._kind == "root":
            return all(x >= 0 for x in v) and any(x > 0 for x in v)
        # weight lattice: express in simple roots via the root space
        raise NotImplementedError

    def has_descent(self, i, side="right", positive=False):
        """Whether s_i is a (right or left) descent.

        EXAMPLES::

            sage: W = WeylGroup("A3", prefix="s"); s1, s2, s3 = W.simple_reflections(); (s1*s2).has_descent(2), (s1*s2).has_descent(2, side="left")
            (True, False)
        """
        W = self._W
        if W._kind == "weight":
            return _weight_descent(self, i, side) != positive
        if side == "right":
            v = _matvec(self._m, W._roots[i])
        else:
            v = _matvec(self.inverse()._m, W._roots[i])
        return (not self._positive(v)) != positive

    def has_left_descent(self, i):
        """Whether s_i is a left descent.

        EXAMPLES::

            sage: W = WeylGroup("A3", prefix="s"); s1, s2, s3 = W.simple_reflections(); (s1*s2).has_left_descent(1)
            True
        """
        return self.has_descent(i, side="left")

    def has_right_descent(self, i):
        """Whether s_i is a right descent.

        EXAMPLES::

            sage: W = WeylGroup("A3", prefix="s"); s1, s2, s3 = W.simple_reflections(); (s1*s2).has_right_descent(1)
            False
        """
        return self.has_descent(i, side="right")

    def descents(self, side="right", index_set=None, positive=False):
        """The (right or left) descents.

        EXAMPLES::

            sage: W = WeylGroup("A3", prefix="s"); s1, s2, s3 = W.simple_reflections(); (s1*s2*s3).descents(), (s1*s2*s3).descents(side="left")
            ([3], [1])
        """
        I = index_set or self._W._I
        return [i for i in I if self.has_descent(i, side, positive)]

    def first_descent(self, side="right", index_set=None, positive=False):
        """The smallest descent (or None).

        EXAMPLES::

            sage: W = WeylGroup("A3", prefix="s"); s1, s2, s3 = W.simple_reflections(); (s2*s3).first_descent(), W.one().first_descent()
            (3, None)
        """
        d = self.descents(side, index_set, positive)
        return d[0] if d else None

    def is_one(self):
        """Whether this is the identity.

        EXAMPLES::

            sage: W = WeylGroup("A3", prefix="s"); s1, s2, s3 = W.simple_reflections(); (s1*s1).is_one(), s1.is_one()
            (True, False)
        """
        return self._m == self._W._one._m

    def reduced_word(self):
        """A reduced word (Sage's choice: the first left descent first).

        EXAMPLES::

            sage: W = WeylGroup("A3", prefix="s"); s1, s2, s3 = W.simple_reflections()
            sage: (s3*s2*s1*s3*s2*s3).reduced_word()
            [1, 2, 3, 1, 2, 1]
        """
        if self._word is None:
            word = []
            w = self
            while True:
                for i in self._W._I:
                    if w.has_descent(i, side="right"):
                        word.append(i)
                        w = w * self._W.simple_reflection(i)
                        break
                else:
                    break
            self._word = word[::-1]
        return list(self._word)

    def length(self):
        """The length.

        EXAMPLES::

            sage: W = WeylGroup("A3", prefix="s"); s1, s2, s3 = W.simple_reflections()
            sage: (s1*s2*s1).length()
            3
        """
        return _sa().Integer(len(self.reduced_word()))

    def action(self, v):
        """The action on the domain.

        EXAMPLES::

            sage: W = WeylGroup("B3", prefix="s"); s1 = W.simple_reflection(1)
            sage: s1.action(W.domain().fundamental_weight(1))
            (0, 1, 0)
        """
        W = self._W
        if W._kind == "ambient":
            return AmbientVector(W._space, _matvec(self._m, v._v))
        if W._kind == "weight":
            return AffineWeight(v._P, _matvec(self._m, v._v))
        raise NotImplementedError

    def __call__(self, v):
        """The action on the domain.

        EXAMPLES::

            sage: W = WeylGroup("A3", prefix="s"); s1, s2, s3 = W.simple_reflections(); (s1*s2)(W.domain()((1, 2, 3, 4)))
            (3, 1, 2, 4)
        """
        return self.action(v)

    def bruhat_le(self, other):
        """Whether self <= other in the Bruhat order (subword property).

        EXAMPLES::

            sage: W = WeylGroup("A2", prefix="s"); s1, s2 = W.simple_reflections()
            sage: s1.bruhat_le(s1*s2*s1), (s1*s2).bruhat_le(s2*s1)
            (True, False)
        """
        lu, lv = self.length(), other.length()
        if lu > lv:
            return False
        if lu == lv:
            return self == other
        # u <= v iff for a right descent s of v: (us <= vs if s is a descent of u, else u <= vs)
        W = self._W
        for i in W._I:
            if other.has_descent(i, side="right"):
                s = W.simple_reflection(i)
                if self.has_descent(i, side="right"):
                    return (self * s).bruhat_le(other * s)
                return self.bruhat_le(other * s)
        return self.is_one()

    def is_reflection(self):
        """Whether this is a reflection.

        EXAMPLES::

            sage: W = WeylGroup("A3", prefix="s"); s1, s2, s3 = W.simple_reflections(); (s1*s2*s1).is_reflection(), (s1*s2).is_reflection()
            (True, False)
        """
        D = self._W
        return self.length() % 2 == 1 and (self * self).is_one() and any(self == r for r in D.reflections().values())

    def apply_simple_reflection(self, i, side="right"):
        """The product with s_i (on the right or left).

        EXAMPLES::

            sage: W = WeylGroup("A3", prefix="s"); s1, s2, s3 = W.simple_reflections(); (s1*s2).apply_simple_reflection(3), (s1*s2).apply_simple_reflection(3, side="left")
            (s1*s2*s3, s3*s1*s2)
        """
        s = self._W.simple_reflection(i)
        return self * s if side == "right" else s * self

    def coset_representative(self, index_set, side="right"):
        """The minimal coset representative for the parabolic subgroup of the index set.

        EXAMPLES::

            sage: W = WeylGroup("A3", prefix="s"); s1, s2, s3 = W.simple_reflections(); (s1*s2*s3*s1).coset_representative([1])
            s1*s2*s3
        """
        w = self
        while True:
            for i in index_set:
                if w.has_descent(i, side=side):
                    w = w.apply_simple_reflection(i, side)
                    break
            else:
                return w

    def __repr__(self):
        p = self._W._prefix
        if p is None:
            return repr(self.matrix())
        w = self.reduced_word()
        if not w:
            return "1"
        return "*".join("%s%s" % (p, i) for i in w)

    def __str__(self):
        return repr(self)


def WeylGroup(x, prefix=None, implementation="matrix"):
    """The Weyl group of a Cartan type (on the ambient space; affine types
    act on the root space).

    EXAMPLES::

        sage: WeylGroup("A3")
        Weyl Group of type ['A', 3] (as a matrix group acting on the ambient space)
        sage: W = WeylGroup("E6", prefix="s"); W.long_element()
        s1*s3*s4*s5*s6*s2*s4*s5*s3*s4*s1*s3*s2*s4*s5*s6*s2*s4*s5*s3*s4*s1*s3*s2*s4*s5*s3*s4*s1*s3*s2*s4*s1*s3*s2*s1
        sage: W = WeylGroup(['A', 2, 1], prefix="s"); s0, s1, s2 = W.simple_reflections()
        sage: s0*s1*s2*s1*s0
        s0*s1*s2*s1*s0
    """
    if isinstance(x, (AmbientSpace,)):
        return WeylGroup_(x, prefix)
    if isinstance(x, WeightLattice):
        return WeylGroup_(x, prefix, kind="weight")
    if isinstance(x, RootSystem_):
        x = x._ct
    ct = CartanType(x)
    if ct.is_finite():
        return WeylGroup_(RootSystem_(ct).ambient_space(), prefix)
    return WeylGroup_(ct, prefix, kind="root")


def _weight_descent(w, i, side):
    W = w._W
    ct = W._ct
    if side == "right":
        v = _matvec(w._m, W._alpha[i])
    else:
        v = _matvec(w.inverse()._m, W._alpha[i])
    c = _weight_to_root_coords(W, v)
    return all(x <= 0 for x in c) and any(x < 0 for x in c)


def _weight_to_root_coords(W, v):
    # v = sum_i c_i alpha_i in the extended weight lattice basis; solve with
    # the delta coordinate and the Cartan matrix (alpha_i = sum_j a_ji Lambda_j + [i=0] delta)
    I = W._I if W._parabolic is None else list(W._ct.index_set())
    n = len(I)
    rows = [[W._alpha[i][r] for i in I] for r in range(n + 1)]
    # least squares-free: solve the (n+1) x n system exactly
    M = [rows[r] + [v[r]] for r in range(n + 1)]
    piv, r = [], 0
    for c in range(n):
        p = next((k for k in range(r, n + 1) if M[k][c] != 0), None)
        if p is None:
            continue
        M[r], M[p] = M[p], M[r]
        inv = 1 / M[r][c]
        M[r] = [x * inv for x in M[r]]
        for k in range(n + 1):
            if k != r and M[k][c] != 0:
                f = M[k][c]
                M[k] = [x - f * y for x, y in zip(M[k], M[r])]
        piv.append(c)
        r += 1
    out = [_F(0)] * n
    for k, c in enumerate(piv):
        out[c] = M[k][n]
    return out


# ------------------------------------------------ affine weight lattices

class WeightLattice:
    """The (extended) weight lattice of a root system: for affine types the
    basis Lambda[0], ..., Lambda[n], delta.

    EXAMPLES::

        sage: WL = RootSystem(["A", 1, 1]).weight_lattice(extended=True); WL
        Extended weight lattice of the Root system of type ['A', 1, 1]
        sage: WL.fundamental_weights()
        Finite family {0: Lambda[0], 1: Lambda[1]}
    """

    def __init__(self, R, extended=False):
        self._R, self._ct, self._extended = R, R._ct, extended
        self._I = list(self._ct.index_set())

    def __repr__(self):
        return "%seight lattice of the %r" % ("Extended w" if self._extended else "W", self._R)

    def __eq__(self, other):
        return isinstance(other, WeightLattice) and (self._ct, self._extended) == (other._ct, other._extended)

    def __hash__(self):
        return hash(("WL", self._ct, self._extended))

    def cartan_type(self):
        """The Cartan type.

        EXAMPLES::

            sage: RootSystem(["A", 1, 1]).weight_lattice(extended=True).cartan_type()
            ['A', 1, 1]
        """
        return self._ct

    def index_set(self):
        """The index set.

        EXAMPLES::

            sage: RootSystem(["A", 1, 1]).weight_lattice(extended=True).index_set()
            (0, 1)
        """
        return tuple(self._I)

    def root_system(self):
        """The root system.

        EXAMPLES::

            sage: RootSystem(["A", 2, 1]).weight_lattice(extended=True).root_system()
            Root system of type ['A', 2, 1]
        """
        return self._R

    def _v(self, t):
        return AffineWeight(self, t)

    def zero(self):
        """Zero.

        EXAMPLES::

            sage: RootSystem(["A", 1, 1]).weight_lattice(extended=True).zero()
            0
        """
        return self._v([0] * (len(self._I) + 1))

    def fundamental_weights(self):
        """The fundamental weights Lambda[i].

        EXAMPLES::

            sage: L = RootSystem(['E', 6, 1]).weight_lattice(extended=True)
            sage: [L.fundamental_weights()[i].level() for i in L.index_set()]
            [1, 1, 2, 2, 3, 2, 1]
        """
        n = len(self._I)
        return Family(self._I, [self._v(_e(n + 1, (a, 1))) for a in range(n)])

    def fundamental_weight(self, i):
        """The i-th fundamental weight.

        EXAMPLES::

            sage: RootSystem(["A", 1, 1]).weight_lattice(extended=True).fundamental_weight(1)
            Lambda[1]
        """
        return self.fundamental_weights()[i]

    def null_root(self):
        """delta, the null root.

        EXAMPLES::

            sage: RootSystem(['A', 2, 1]).weight_lattice(extended=True).null_root()
            delta
        """
        n = len(self._I)
        return self._v(_e(n + 1, (n, 1)))

    def basic_imaginary_roots(self):
        """The basic imaginary roots (delta).

        EXAMPLES::

            sage: RootSystem(["A", 1, 1]).weight_lattice(extended=True).basic_imaginary_roots()
            [delta]
        """
        return [self.null_root()]

    def simple_roots(self):
        """The simple roots.

        EXAMPLES::

            sage: RootSystem(['A', 2, 1]).weight_lattice(extended=True).simple_roots()
            Finite family {0: 2*Lambda[0] - Lambda[1] - Lambda[2] + delta, 1: -Lambda[0] + 2*Lambda[1] - Lambda[2], 2: -Lambda[0] - Lambda[1] + 2*Lambda[2]}
        """
        A = _cartan(self._ct)
        I = self._I
        return Family(I, [self._v([A[j][i] for j in I] + [_F(1) if i == I[0] and self._extended else _F(0)]) for i in I])

    def simple_root(self, i):
        """The i-th simple root.

        EXAMPLES::

            sage: RootSystem(["A", 1, 1]).weight_lattice(extended=True).simple_root(0)
            2*Lambda[0] - 2*Lambda[1] + delta
        """
        return self.simple_roots()[i]

    def rho(self):
        """The sum of the fundamental weights.

        EXAMPLES::

            sage: RootSystem(["A", 2, 1]).weight_lattice(extended=True).rho()
            Lambda[0] + Lambda[1] + Lambda[2]
        """
        return sum(self.fundamental_weights().values(), self.zero())

    def positive_roots(self):
        """The positive roots (real and imaginary).

        EXAMPLES::

            sage: RootSystem(["A", 1, 1]).weight_lattice(extended=True).positive_roots()
            Disjoint union of Family (Positive real roots of type ['A', 1, 1], Positive imaginary roots of type ['A', 1, 1])
        """
        return _Named("Disjoint union of Family (Positive real roots of type %r, Positive imaginary roots of type %r)" % (self._ct, self._ct))

    def weyl_group(self, prefix=None):
        """The Weyl group acting on the lattice.

        EXAMPLES::

            sage: RootSystem(['A', 2, 1]).weight_lattice(extended=True).weyl_group()
            Weyl Group of type ['A', 2, 1] (as a matrix group acting on the extended weight lattice)
        """
        return WeylGroup_(self, prefix, kind="weight")


class _Named:
    def __init__(self, s):
        self._s = s

    def __repr__(self):
        return self._s


class AffineWeight:
    """An element of an affine weight lattice: sum c_i Lambda[i] + d delta.

    EXAMPLES::

        sage: L = RootSystem(["A", 2, 1]).weight_lattice(extended=True); La = L.fundamental_weights(); d = L.null_root(); 2*La[0] - La[1] + 3*d
        2*Lambda[0] - Lambda[1] + 3*delta
    """

    __slots__ = ("_P", "_v")

    def __init__(self, P, v):
        self._P, self._v = P, tuple(_F(x) for x in v)

    def parent(self):
        """The weight lattice.

        EXAMPLES::

            sage: RootSystem(["A", 1, 1]).weight_lattice(extended=True).null_root().parent()
            Extended weight lattice of the Root system of type ['A', 1, 1]
        """
        return self._P

    def __repr__(self):
        terms = []
        I = self._P._I
        for a, i in enumerate(I):
            terms.append((self._v[a], "Lambda[%s]" % i))
        terms.append((self._v[-1], "delta"))
        return _lincomb(terms) or "0"

    def __hash__(self):
        return hash(self._v)

    def __eq__(self, other):
        if isinstance(other, AffineWeight):
            return self._v == other._v
        if isinstance(other, int) and other == 0:
            return all(x == 0 for x in self._v)
        return NotImplemented

    def __ne__(self, other):
        return not self == other

    def __lt__(self, other):
        return repr(self) < repr(other)

    def __add__(self, other):
        if isinstance(other, int) and other == 0:
            return self
        return AffineWeight(self._P, _addv(self._v, other._v))

    def __radd__(self, other):
        if isinstance(other, int) and other == 0:
            return self
        return NotImplemented

    def __sub__(self, other):
        return AffineWeight(self._P, _subv(self._v, other._v))

    def __neg__(self):
        return AffineWeight(self._P, _neg(self._v))

    def __mul__(self, c):
        if isinstance(c, (int, _F)):
            return AffineWeight(self._P, _smul(_q(c), self._v))
        return NotImplemented

    __rmul__ = __mul__

    def level(self):
        """The level <lambda, c> (c the canonical central element).

        EXAMPLES::

            sage: L = RootSystem(['A', 2, 1]).weight_lattice(extended=True)
            sage: (2*L.fundamental_weight(0) + L.fundamental_weight(1)).level()
            3
        """
        ac = [_q(x) for x in self._P._ct.acheck().values()]
        return _out(sum((a * x for a, x in zip(ac, self._v)), _F(0)))

    def coefficient(self, i):
        """The coefficient of Lambda[i] (or of delta, for i = 'delta').

        EXAMPLES::

            sage: L = RootSystem(["A", 2, 1]).weight_lattice(extended=True); x = 2*L.fundamental_weight(0) + L.null_root(); x.coefficient(0), x.coefficient("delta")
            (2, 1)
        """
        if i == "delta":
            return _out(self._v[-1])
        return _out(self._v[self._P._I.index(i)])

    def __getitem__(self, i):
        return self.coefficient(i)

    def simple_reflection(self, i):
        """The image under s_i.

        EXAMPLES::

            sage: L = RootSystem(["A", 1, 1]).weight_lattice(extended=True); L.fundamental_weight(0).simple_reflection(0)
            -Lambda[0] + 2*Lambda[1] - delta
        """
        W = self._P.weyl_group()
        return W.simple_reflection(i).action(self)

    def is_dominant(self):
        """Whether all coefficients of the Lambda[i] are nonnegative.

        EXAMPLES::

            sage: L = RootSystem(["A", 2, 1]).weight_lattice(extended=True); L.fundamental_weight(0).is_dominant(), L.simple_root(1).is_dominant()
            (True, False)
        """
        return all(x >= 0 for x in self._v[:-1])


def _coeff_str(c, name):
    """'c*name' as Sage prints a term (c a nonzero Fraction), with its sign."""
    if c == 1:
        return "+", name
    if c == -1:
        return "-", name
    s = "-" if c < 0 else "+"
    return s, "%s*%s" % (_fs(abs(c)), name)


def _lincomb(terms):
    out = ""
    for c, name in terms:
        if c == 0:
            continue
        s, t = _coeff_str(c, name)
        if not out:
            out = ("-" if s == "-" else "") + t
        else:
            out += " %s %s" % (s, t)
    return out


# ------------------------------------------------- Weyl character rings

def _dominant_weights(D, lam):
    """The dominant weights of V(lam) with their multiplicities
    (Freudenthal's formula), as a dict."""
    lam = tuple(lam)
    key = (D.ct, lam)
    if key in _FREUD:
        return _FREUD[key]
    doms = {lam: None}
    order = [lam]
    k = 0
    while k < len(order):
        mu = order[k]
        k += 1
        for a in D.pos:
            nu = _subv(mu, a)
            if D._isdom(nu) and nu not in doms:
                doms[nu] = None
                order.append(nu)
    rho = D.rho
    order.sort(key=lambda m: -_dot(m, rho))
    lr = _addv(lam, rho)
    top = _dot(lr, lr)
    mult = {lam: 1}
    for mu in order[1:]:
        s = _F(0)
        for a in D.pos:
            j = 1
            while True:
                v = _addv(mu, _smul(j, a))
                d = D._dom(v)[0]
                m = mult.get(d)
                if not m:
                    break
                s += m * _dot(v, a)
                j += 1
        mr = _addv(mu, rho)
        m = 2 * s / (top - _dot(mr, mr))
        if m:
            mult[mu] = int(m)
    _FREUD[key] = mult
    return mult


_FREUD = {}


def _orbit(D, mu):
    seen = {mu}
    todo = [mu]
    while todo:
        v = todo.pop()
        for a, c in zip(D.simple, D.coroots):
            p = _dot(v, c)
            if p:
                w = _subv(v, _smul(p, a))
                if w not in seen:
                    seen.add(w)
                    todo.append(w)
    return seen


def _all_weights(D, lam):
    key = (D.ct, tuple(lam))
    if key in _ALLW:
        return _ALLW[key]
    out = {}
    for mu, m in _dominant_weights(D, lam).items():
        for v in _orbit(D, mu):
            out[v] = m
    _ALLW[key] = out
    return out


_ALLW = {}


def _strict_dominant(D, x):
    """(w(x), sign of w) with w(x) dominant, or None if x is on a wall."""
    y, k = D._dom(x)
    if any(_dot(y, c) == 0 for c in D.coroots):
        return None
    return y, (-1) ** k


def _decompose(D, weights):
    """The irreducible decomposition (dict highest weight -> coefficient) of
    a character given by its weight multiplicities (only the dominant ones
    are used)."""
    rem = {w: m for w, m in weights.items() if m and D._isdom(w)}
    out = {}
    while rem:
        top = max(rem, key=lambda w: (_dot(w, D.rho), w))
        c = rem[top]
        out[top] = out.get(top, 0) + c
        for mu, m in _dominant_weights(D, top).items():
            r = rem.get(mu, 0) - c * m
            if r:
                rem[mu] = r
            else:
                rem.pop(mu, None)
    return out


def _wkey(v):
    return [(i, x) for i, x in enumerate(v) if x != 0]


class WeylCharacterRing_:
    """The ring of characters of a compact Lie group (finite Cartan type),
    with basis the irreducible characters, indexed by dominant weights in the
    ambient space (style "lattice") or by coroot coordinates (style
    "coroots").

    EXAMPLES::

        sage: G2 = WeylCharacterRing("G2", style="coroots"); G2
        The Weyl Character Ring of Type G2 with Integer Ring coefficients
        sage: G2(1,0)^2
        G2(0,0) + G2(1,0) + G2(0,1) + G2(2,0)
    """

    def __init__(self, ct, base_ring=None, prefix=None, style="lattice"):
        self._ct = ct
        self._space = RootSystem_(ct).ambient_space()
        self._D = self._space._data
        self._style = style
        self._prefix = prefix or ct._short().replace("~", "")
        self._base = base_ring

    def __repr__(self):
        return "The Weyl Character Ring of Type %s with Integer Ring coefficients" % (self._ct._short(),)

    def __eq__(self, other):
        return isinstance(other, WeylCharacterRing_) and (self._ct, self._style, self._prefix) == (other._ct, other._style, other._prefix)

    def __hash__(self):
        return hash(("WCR", self._ct, self._style))

    def _zero_weight(self):
        return tuple([_F(0)] * self._D.dim)

    def _norm(self, v):
        """Weights in coroot style are taken in the sl (sum-zero) normalization."""
        if self._style == "coroots":
            return AmbientVector(self._space, v).coerce_to_sl()._v
        return tuple(v)

    def _el(self, d):
        return WeylCharacterRingElement(self, {k: c for k, c in d.items() if c})

    def __call__(self, *args):
        """The irreducible character of a highest weight (coordinates, a vector or, in coroot style, coroot coordinates).

        EXAMPLES::

            sage: B3 = WeylCharacterRing("B3"); B3(1,1,0), B3(B3.fundamental_weights()[3]), B3(0)
            (B3(1,1,0), B3(1/2,1/2,1/2), 0)
        """
        if len(args) == 1:
            x = args[0]
            if isinstance(x, WeylCharacterRingElement):
                if x._P == self:
                    return x
                raise TypeError("no conversion of %r to %r" % (x, self))
            if isinstance(x, int) and not isinstance(x, bool):
                return self._el({self._zero_weight(): x})
            if isinstance(x, AmbientVector):
                v = x._v
            else:
                v = list(x)
                v = self._from_coroots(v) if self._style == "coroots" else tuple(_q(a) for a in v)
        else:
            v = list(args)
            v = self._from_coroots(v) if self._style == "coroots" else tuple(_q(a) for a in v)
        if len(v) != self._D.dim:
            raise ValueError("wrong number of coordinates")
        return self._el(self._irr(self._norm(v)))

    def _from_coroots(self, c):
        D = self._D
        v = self._zero_weight()
        for a, w in zip(c, D.fw):
            v = _addv(v, _smul(_q(a), w))
        return v

    def _irr(self, v):
        """The character with highest weight v (by the Weyl character formula
        if v is not dominant)."""
        D = self._D
        if D._isdom(v):
            return {v: 1}
        r = _strict_dominant(D, _addv(v, D.rho))
        if r is None:
            return {}
        return {self._norm(_subv(r[0], D.rho)): r[1]}

    def cartan_type(self):
        """The Cartan type.

        EXAMPLES::

            sage: B3 = WeylCharacterRing("B3"); B3.cartan_type()
            ['B', 3]
        """
        return self._ct

    def space(self):
        """The ambient space.

        EXAMPLES::

            sage: WeylCharacterRing("B3").space()
            Ambient space of the Root system of type ['B', 3]
        """
        return self._space

    def rank(self):
        """The rank.

        EXAMPLES::

            sage: B3 = WeylCharacterRing("B3"); B3.rank()
            3
        """
        return self._ct.rank()

    def base_ring(self):
        """The base ring.

        EXAMPLES::

            sage: B3 = WeylCharacterRing("B3"); B3.base_ring()
            Integer Ring
        """
        return _sa().ZZ

    def dynkin_diagram(self):
        """The Dynkin diagram.

        EXAMPLES::

            sage: WeylCharacterRing("B4").dynkin_diagram()
            O---O---O=>=O
            1   2   3   4
            B4
        """
        return self._ct.dynkin_diagram()

    def extended_dynkin_diagram(self):
        """The extended (affine) Dynkin diagram.

        EXAMPLES::

            sage: WeylCharacterRing("G2").extended_dynkin_diagram()
              3
            O=<=O---O
            1   2   0
            G2~
        """
        return self._ct.affine().dynkin_diagram()

    def fundamental_weights(self):
        """The fundamental weights (in the ambient space).

        EXAMPLES::

            sage: WeylCharacterRing("B3").fundamental_weights()
            Finite family {1: (1, 0, 0), 2: (1, 1, 0), 3: (1/2, 1/2, 1/2)}
        """
        return self._space.fundamental_weights()

    def simple_roots(self):
        """The simple roots.

        EXAMPLES::

            sage: B3 = WeylCharacterRing("B3"); B3.simple_roots()
            Finite family {1: (1, -1, 0), 2: (0, 1, -1), 3: (0, 0, 1)}
        """
        return self._space.simple_roots()

    def simple_coroots(self):
        """The simple coroots.

        EXAMPLES::

            sage: B3 = WeylCharacterRing("B3"); B3.simple_coroots()
            Finite family {1: (1, -1, 0), 2: (0, 1, -1), 3: (0, 0, 2)}
        """
        return self._space.simple_coroots()

    def positive_roots(self):
        """The positive roots.

        EXAMPLES::

            sage: WeylCharacterRing("A2").positive_roots()
            [(1, -1, 0), (1, 0, -1), (0, 1, -1)]
        """
        return self._space.positive_roots()

    def highest_root(self):
        """The highest root.

        EXAMPLES::

            sage: B3 = WeylCharacterRing("B3"); B3.highest_root()
            (1, 1, 0)
        """
        return self._space.highest_root()

    def adjoint_representation(self):
        """The adjoint representation (highest weight the highest root).

        EXAMPLES::

            sage: WeylCharacterRing("G2", style="coroots").adjoint_representation()
            G2(0,1)
        """
        return self(self._space.highest_root())

    def one(self):
        """The trivial character.

        EXAMPLES::

            sage: B3 = WeylCharacterRing("B3"); B3.one()
            B3(0,0,0)
        """
        return self._el({self._zero_weight(): 1})

    def zero(self):
        """Zero.

        EXAMPLES::

            sage: B3 = WeylCharacterRing("B3"); B3.zero()
            0
        """
        return self._el({})

    def char_from_weights(self, mdict):
        """The character with the given weight multiplicities.

        EXAMPLES::

            sage: A2 = WeylCharacterRing("A2")
            sage: A2.char_from_weights(A2(1,0,0).weight_multiplicities())
            A2(1,0,0)
        """
        w = {}
        for k, m in mdict.items():
            v = k._v if isinstance(k, AmbientVector) else tuple(_q(a) for a in k)
            w[v] = w.get(v, 0) + int(m)
        return self._el({self._norm(v): c for v, c in _decompose(self._D, w).items()})

    def lift(self, x):
        """The weights of a character, in the weight ring.

        EXAMPLES::

            sage: A1 = WeylCharacterRing("A1"); A1.lift(A1(2,0))
            a1(1,1) + a1(2,0) + a1(0,2)
        """
        return WeightRing(self)(x)


_WCR = {}


def WeylCharacterRing(ct, base_ring=None, prefix=None, style="lattice", k=None, conjugate=False, cyclotomic_order=None, fusion_labels=None):
    """The Weyl character ring of a finite Cartan type.

    EXAMPLES::

        sage: B3 = WeylCharacterRing("B3"); B3
        The Weyl Character Ring of Type B3 with Integer Ring coefficients
        sage: spin = B3(1/2,1/2,1/2); spin*spin
        B3(0,0,0) + B3(1,0,0) + B3(1,1,0) + B3(1,1,1)
        sage: A2 = WeylCharacterRing("A2"); A2(1,0,0)^5
        5*A2(2,2,1) + 6*A2(3,1,1) + 5*A2(3,2,0) + 4*A2(4,1,0) + A2(5,0,0)
        sage: B3 = WeylCharacterRing("B3", style="coroots"); B3(0,0,1).degree()
        8
    """
    if k is not None:
        raise NotImplementedError("fusion rings are not available in sagebrush yet")
    ct = CartanType(ct)
    key = (ct, prefix, style)
    if key not in _WCR:
        _WCR[key] = WeylCharacterRing_(ct, base_ring, prefix, style)
    return _WCR[key]


class WeylCharacterRingElement:
    """A virtual character: a dict highest weight -> coefficient.

    EXAMPLES::

        sage: B3 = WeylCharacterRing("B3"); chi = B3(1,0,0) - 2*B3(0,0,0); chi
        -2*B3(0,0,0) + B3(1,0,0)
        sage: chi.degree(), chi^2
        (5, 5*B3(0,0,0) - 4*B3(1,0,0) + B3(1,1,0) + B3(2,0,0))
    """

    def __init__(self, P, d):
        self._P, self._d = P, d

    def parent(self):
        """The Weyl character ring.

        EXAMPLES::

            sage: B3 = WeylCharacterRing("B3"); B3(1,0,0).parent()
            The Weyl Character Ring of Type B3 with Integer Ring coefficients
        """
        return self._P

    def _terms(self):
        return sorted(self._d, key=_wkey)

    def _wname(self, v):
        P = self._P
        if P._style == "coroots":
            cs = [_dot(v, c) for c in P._D.coroots]
            return "%s(%s)" % (P._prefix, ",".join(_fs(c) for c in cs))
        return "%s(%s)" % (P._prefix, ",".join(_fs(c) for c in v))

    def __repr__(self):
        if not self._d:
            return "0"
        return _lincomb([(_F(self._d[v]), self._wname(v)) for v in self._terms()])

    def _latex_(self):
        return repr(self)

    def __hash__(self):
        return hash(tuple(sorted(self._d.items())))

    def __eq__(self, other):
        if isinstance(other, WeylCharacterRingElement):
            return self._d == other._d
        if isinstance(other, int):
            return self._d == ({self._P._zero_weight(): other} if other else {})
        return NotImplemented

    def __ne__(self, other):
        r = self.__eq__(other)
        return r if r is NotImplemented else not r

    def __add__(self, other):
        if isinstance(other, int):
            other = self._P(other)
        if not isinstance(other, WeylCharacterRingElement):
            return NotImplemented
        d = dict(self._d)
        for k, c in other._d.items():
            d[k] = d.get(k, 0) + c
        return self._P._el(d)

    def __radd__(self, other):
        if isinstance(other, int):
            return self + other
        return NotImplemented

    def __neg__(self):
        return self._P._el({k: -c for k, c in self._d.items()})

    def __sub__(self, other):
        if isinstance(other, int):
            other = self._P(other)
        return self + (-other)

    def __rsub__(self, other):
        return (-self) + other

    def __mul__(self, other):
        if isinstance(other, int) and not isinstance(other, bool):
            return self._P._el({k: c * other for k, c in self._d.items()})
        if not isinstance(other, WeylCharacterRingElement):
            return NotImplemented
        P = self._P
        D = P._D
        out = {}
        for la, a in self._d.items():
            for mu, b in other._d.items():
                small, big = (la, mu) if _weyl_dim(D, la) <= _weyl_dim(D, mu) else (mu, la)
                for nu, m in _all_weights(D, small).items():
                    r = _strict_dominant(D, _addv(_addv(big, nu), D.rho))
                    if r is None:
                        continue
                    w = P._norm(_subv(r[0], D.rho))
                    out[w] = out.get(w, 0) + a * b * m * r[1]
        return P._el(out)

    def __rmul__(self, other):
        if isinstance(other, int) and not isinstance(other, bool):
            return self * other
        return NotImplemented

    def __pow__(self, n):
        n = int(n)
        r = self._P.one()
        for _ in range(n):
            r = r * self
        return r

    def __iter__(self):
        return iter([(AmbientVector(self._P._space, v), _out(self._d[v])) for v in self._terms()])

    def __len__(self):
        return len(self._d)

    def monomials(self):
        """The irreducible constituents.

        EXAMPLES::

            sage: B3 = WeylCharacterRing("B3"); chi = B3(1/2,1/2,1/2)^2
            sage: sorted(chi.monomials(), key=lambda x: tuple(x.support()))
            [B3(0,0,0), B3(1,0,0), B3(1,1,0), B3(1,1,1)]
        """
        return [self._P._el({v: 1}) for v in self._terms()]

    def support(self):
        """The highest weights of the constituents.

        EXAMPLES::

            sage: B3 = WeylCharacterRing("B3"); (B3(1,0,0)^2).support()
            [(0, 0, 0), (1, 1, 0), (2, 0, 0)]
        """
        return [AmbientVector(self._P._space, v) for v in self._terms()]

    def coefficients(self):
        """The coefficients (multiplicities of the constituents).

        EXAMPLES::

            sage: B3 = WeylCharacterRing("B3"); (B3(1/2,1/2,1/2)^2).coefficients()
            [1, 1, 1, 1]
        """
        return [_out(self._d[v]) for v in self._terms()]

    def highest_weight(self):
        """The highest weight of an irreducible character.

        EXAMPLES::

            sage: B3 = WeylCharacterRing("B3"); B3(1/2,1/2,1/2).highest_weight()
            (1/2, 1/2, 1/2)
        """
        if len(self._d) != 1:
            raise ValueError("not an irreducible character")
        return AmbientVector(self._P._space, list(self._d)[0])

    def is_irreducible(self):
        """Whether this is an irreducible character.

        EXAMPLES::

            sage: B3 = WeylCharacterRing("B3"); B3(1,0,0).is_irreducible(), (B3(1,0,0)^2).is_irreducible()
            (True, False)
        """
        return len(self._d) == 1 and list(self._d.values())[0] == 1

    def cartan_type(self):
        """The Cartan type.

        EXAMPLES::

            sage: B3 = WeylCharacterRing("B3"); B3(1,0,0).cartan_type()
            ['B', 3]
        """
        return self._P._ct

    def degree(self):
        """The dimension of the representation.

        EXAMPLES::

            sage: WeylCharacterRing("A3", style="coroots")(1,0,1).degree()
            15
        """
        D = self._P._D
        return _out(sum((c * _weyl_dim(D, v) for v, c in self._d.items()), _F(0)))

    dimension = degree

    def _weights(self):
        D = self._P._D
        out = {}
        for v, c in self._d.items():
            for w, m in _all_weights(D, v).items():
                out[w] = out.get(w, 0) + c * m
        return {w: m for w, m in out.items() if m}

    def weight_multiplicities(self):
        """The weights with their multiplicities.

        EXAMPLES::

            sage: A2 = WeylCharacterRing("A2", style="coroots")
            sage: A2(1,0).weight_multiplicities()
            {(-1/3, -1/3, 2/3): 1, (-1/3, 2/3, -1/3): 1, (2/3, -1/3, -1/3): 1}
        """
        S = self._P._space
        w = self._weights()
        return {AmbientVector(S, v): _out(w[v]) for v in sorted(w, key=_wkey)}

    def invariant_degree(self):
        """The multiplicity of the trivial representation.

        EXAMPLES::

            sage: A2 = WeylCharacterRing("A2", style="coroots"); ad = A2(1,1)
            sage: [ad.symmetric_power(k).invariant_degree() for k in [0..6]]
            [1, 0, 1, 1, 1, 1, 2]
        """
        return _out(self._d.get(self._P._zero_weight(), 0))

    def multiplicity(self, other):
        """The multiplicity of an irreducible character.

        EXAMPLES::

            sage: A2 = WeylCharacterRing("A2", style="coroots"); ad = A2(1,1)
            sage: (ad^3).multiplicity(ad)
            8
        """
        if not other.is_irreducible():
            raise ValueError("%r is not irreducible" % (other,))
        return _out(self._d.get(list(other._d)[0], 0))

    def dual(self):
        """The contragredient character.

        EXAMPLES::

            sage: A2 = WeylCharacterRing("A2", style="coroots"); A2(2,1).dual()
            A2(1,2)
        """
        D = self._P._D
        return self._P._el({self._P._norm(D._dom(_neg(v))[0]): c for v, c in self._d.items()})

    def frobenius_schur_indicator(self):
        """1 for orthogonal, -1 for symplectic, 0 for non self-dual irreducible
        representations.

        EXAMPLES::

            sage: B3 = WeylCharacterRing("B3"); B3(1/2,1/2,1/2).frobenius_schur_indicator()
            1
            sage: WeylCharacterRing("C4", style="coroots")(1,0,0,0).frobenius_schur_indicator()
            -1
        """
        if not self.is_irreducible():
            raise ValueError("Frobenius-Schur indicator is only defined for irreducible representations")
        P = self._P
        D = P._D
        v = list(self._d)[0]
        if P._norm(D._dom(_neg(v))[0]) != v:
            return _sa().Integer(0)
        k = _dot(v, _smul(2, D.rhocheck))
        return _sa().Integer(1 if int(k) % 2 == 0 else -1)

    def _power(self, k, sym):
        k = int(k)
        ws = self._weights()
        z = self._P._zero_weight()
        layers = [{z: 1}] + [{} for _ in range(k)]
        for w, m in ws.items():
            for _ in range(m):
                if sym:
                    for j in range(1, k + 1):
                        for u, c in list(layers[j - 1].items()):
                            v = _addv(u, w)
                            layers[j][v] = layers[j].get(v, 0) + c
                else:
                    for j in range(k, 0, -1):
                        for u, c in list(layers[j - 1].items()):
                            v = _addv(u, w)
                            layers[j][v] = layers[j].get(v, 0) + c
        P = self._P
        dec = _decompose(P._D, layers[k])
        return P._el({P._norm(v): c for v, c in dec.items()})

    def symmetric_power(self, k):
        """The k-th symmetric power.

        EXAMPLES::

            sage: B3 = WeylCharacterRing("B3", style="coroots")
            sage: B3(0,0,1).symmetric_power(5)
            B3(0,0,1) + B3(0,0,3) + B3(0,0,5)
        """
        return self._power(k, True)

    def exterior_power(self, k):
        """The k-th exterior power.

        EXAMPLES::

            sage: B3 = WeylCharacterRing("B3", style="coroots")
            sage: B3(0,0,1).exterior_power(2), B3(0,0,1).exterior_power(5)
            (B3(1,0,0) + B3(0,1,0), B3(0,0,1) + B3(1,0,1))
        """
        return self._power(k, False)

    def symmetric_square(self):
        """The symmetric square.

        EXAMPLES::

            sage: B3 = WeylCharacterRing("B3"); B3(1,0,0).symmetric_square()
            B3(0,0,0) + B3(2,0,0)
        """
        return self._power(2, True)

    def exterior_square(self):
        """The exterior square.

        EXAMPLES::

            sage: C4 = WeylCharacterRing("C4", style="coroots"); chi = C4(1,0,0,0)
            sage: chi.exterior_square(), chi.symmetric_square()
            (C4(0,0,0,0) + C4(0,1,0,0), C4(2,0,0,0))
        """
        return self._power(2, False)

    def adams_operation(self, r):
        """The Adams operation psi^r (weights multiplied by r).

        EXAMPLES::

            sage: A1 = WeylCharacterRing("A1"); A1(1,0).adams_operation(3)
            -A1(2,1) + A1(3,0)
        """
        P = self._P
        ws = {}
        for w, m in self._weights().items():
            v = _smul(int(r), w)
            ws[v] = ws.get(v, 0) + m
        return P.char_from_weights({AmbientVector(P._space, v): m for v, m in ws.items()})

    def branch(self, S, rule="default"):
        """The restriction to a subgroup (a Weyl character ring S) along a
        branching rule.

        EXAMPLES::

            sage: A3 = WeylCharacterRing("A3", style="coroots"); C2 = WeylCharacterRing("C2", style="coroots")
            sage: A3(1,0,1).branch(C2, rule="symmetric")
            C2(0,1) + C2(2,0)
        """
        if isinstance(rule, BranchingRule):
            b = rule
        elif callable(rule) and not isinstance(rule, str):
            b = BranchingRule(self._P._ct, S._ct, rule, "custom")
        else:
            b = branching_rule(self._P._ct, S._ct, rule)
        return b._branch(self, S)


# ---------------------------------------------------------------- weight rings

class WeightRing_:
    """The group algebra of the weight lattice (formal sums of weights).

    EXAMPLES::

        sage: A2 = WeylCharacterRing("A2"); a2 = WeightRing(A2); a2
        The Weight ring attached to The Weyl Character Ring of Type A2 with Integer Ring coefficients
        sage: a2(1,0,0)*a2(0,1,0) + 2*a2(1,1,0)
        3*a2(1,1,0)
    """

    def __init__(self, parent):
        self._wcr = parent
        self._space = parent._space
        self._prefix = parent._prefix.lower()

    def __repr__(self):
        return "The Weight ring attached to %r" % (self._wcr,)

    def __eq__(self, other):
        return isinstance(other, WeightRing_) and self._wcr == other._wcr

    def __hash__(self):
        return hash(("WR", self._wcr))

    def _el(self, d):
        return WeightRingElement(self, {k: c for k, c in d.items() if c})

    def __call__(self, *args):
        """A weight (or the weights of a character).

        EXAMPLES::

            sage: A2 = WeylCharacterRing("A2"); a2 = WeightRing(A2); a2(1,0,0), a2(A2(1,0,0))
            (a2(1,0,0), a2(1,0,0) + a2(0,1,0) + a2(0,0,1))
        """
        if len(args) == 1:
            x = args[0]
            if isinstance(x, WeylCharacterRingElement):
                return self._el(x._weights())
            if isinstance(x, WeightRingElement):
                return x
            if isinstance(x, int):
                return self._el({self._wcr._zero_weight(): x})
            if isinstance(x, AmbientVector):
                return self._el({x._v: 1})
            v = list(x)
        else:
            v = list(args)
        if self._wcr._style == "coroots":
            v = self._wcr._from_coroots(v)
        return self._el({tuple(_q(a) for a in v): 1})

    def one(self):
        """The unit (the zero weight).

        EXAMPLES::

            sage: WeightRing(WeylCharacterRing("A2")).one()
            a2(0,0,0)
        """
        return self._el({self._wcr._zero_weight(): 1})

    def space(self):
        """The ambient space.

        EXAMPLES::

            sage: WeightRing(WeylCharacterRing("A2")).space()
            Ambient space of the Root system of type ['A', 2]
        """
        return self._space

    def parent(self):
        """The Weyl character ring.

        EXAMPLES::

            sage: WeightRing(WeylCharacterRing("A2")).parent()
            The Weyl Character Ring of Type A2 with Integer Ring coefficients
        """
        return self._wcr

    def cartan_type(self):
        """The Cartan type.

        EXAMPLES::

            sage: WeightRing(WeylCharacterRing("A2")).cartan_type()
            ['A', 2]
        """
        return self._wcr._ct


def WeightRing(parent, prefix=None):
    """The weight ring of a Weyl character ring.

    EXAMPLES::

        sage: A2 = WeylCharacterRing(['A', 2]); a2 = WeightRing(A2)
        sage: a2(A2(1,0,-1))
        2*a2(0,0,0) + a2(-1,1,0) + a2(-1,0,1) + a2(1,-1,0) + a2(1,0,-1) + a2(0,-1,1) + a2(0,1,-1)
    """
    R = WeightRing_(parent)
    if prefix:
        R._prefix = prefix
    return R


class WeightRingElement:
    """

    EXAMPLES::

        sage: A1 = WeylCharacterRing("A1"); a1 = WeightRing(A1); (a1(1,0) + a1(0,1))^2
        2*a1(1,1) + a1(2,0) + a1(0,2)
    """
    def __init__(self, P, d):
        self._P, self._d = P, d

    def parent(self):
        """The weight ring.

        EXAMPLES::

            sage: A1 = WeylCharacterRing("A1"); a1 = WeightRing(A1); a1(1,0).parent()
            The Weight ring attached to The Weyl Character Ring of Type A1 with Integer Ring coefficients
        """
        return self._P

    def _terms(self):
        return sorted(self._d, key=_wkey)

    def __repr__(self):
        if not self._d:
            return "0"
        P = self._P
        if P._wcr._style == "coroots":
            nm = lambda v: "%s(%s)" % (P._prefix, ",".join(_fs(_dot(v, c)) for c in P._space._data.coroots))
        else:
            nm = lambda v: "%s(%s)" % (P._prefix, ",".join(_fs(c) for c in v))
        return _lincomb([(_F(self._d[v]), nm(v)) for v in self._terms()])

    def __eq__(self, other):
        if isinstance(other, WeightRingElement):
            return self._d == other._d
        return NotImplemented

    def __ne__(self, other):
        return not self == other

    def __hash__(self):
        return hash(tuple(sorted(self._d.items())))

    def __add__(self, other):
        if isinstance(other, int):
            other = self._P(other)
        if not isinstance(other, WeightRingElement):
            return NotImplemented
        d = dict(self._d)
        for k, c in other._d.items():
            d[k] = d.get(k, 0) + c
        return self._P._el(d)

    def __radd__(self, other):
        if isinstance(other, int):
            return self + other
        return NotImplemented

    def __neg__(self):
        return self._P._el({k: -c for k, c in self._d.items()})

    def __sub__(self, other):
        if isinstance(other, int):
            other = self._P(other)
        return self + (-other)

    def __rsub__(self, other):
        return (-self) + other

    def __mul__(self, other):
        if isinstance(other, int) and not isinstance(other, bool):
            return self._P._el({k: c * other for k, c in self._d.items()})
        if not isinstance(other, WeightRingElement):
            return NotImplemented
        out = {}
        for a, x in self._d.items():
            for b, y in other._d.items():
                v = _addv(a, b)
                out[v] = out.get(v, 0) + x * y
        return self._P._el(out)

    def __rmul__(self, other):
        if isinstance(other, int) and not isinstance(other, bool):
            return self * other
        return NotImplemented

    def __pow__(self, n):
        r = self._P.one()
        for _ in range(int(n)):
            r = r * self
        return r

    def weight_multiplicities(self):
        """The weights with their coefficients.

        EXAMPLES::

            sage: A1 = WeylCharacterRing("A1"); a1 = WeightRing(A1); ((a1(1,0) + a1(0,1))^2).weight_multiplicities()
            {(1, 1): 2, (2, 0): 1, (0, 2): 1}
        """
        S = self._P._space
        return {AmbientVector(S, v): _out(self._d[v]) for v in self._terms()}

    def character(self):
        """The character with these weight multiplicities.

        EXAMPLES::

            sage: A1 = WeylCharacterRing("A1"); a1 = WeightRing(A1); ((a1(1,0) + a1(0,1))^2).character()
            A1(1,1) + A1(2,0)
        """
        return self._P._wcr.char_from_weights(self.weight_multiplicities())

    def support(self):
        """The weights.

        EXAMPLES::

            sage: A1 = WeylCharacterRing("A1"); a1 = WeightRing(A1); ((a1(1,0) + a1(0,1))^2).support()
            [(1, 1), (2, 0), (0, 2)]
        """
        return [AmbientVector(self._P._space, v) for v in self._terms()]

    def coefficients(self):
        """The coefficients.

        EXAMPLES::

            sage: A1 = WeylCharacterRing("A1"); a1 = WeightRing(A1); ((a1(1,0) + a1(0,1))^2).coefficients()
            [2, 1, 1]
        """
        return [_out(self._d[v]) for v in self._terms()]

    def __iter__(self):
        return iter([(AmbientVector(self._P._space, v), _out(self._d[v])) for v in self._terms()])


# ------------------------------------------------------------ branching rules

class BranchingRule:
    """A branching rule R => S: a map from weights of R (ambient coordinates)
    to weights of S.

    EXAMPLES::

        sage: b = BranchingRule("A3", "C2", lambda x: [x[0] - x[3], x[1] - x[2]], "custom"); b
        custom branching rule A3 => C2
        sage: WeylCharacterRing("A3")(1,1,0,0).branch(WeylCharacterRing("C2"), rule=b)
        C2(0,0) + C2(1,1)
    """

    def __init__(self, R, S, f, name="default", intermediate_types=None, intermediate_names=None):
        self._R, self._S = CartanType(R), CartanType(S)
        self._f = f
        self._name = name
        self._inter = intermediate_types or []
        self._inames = intermediate_names or []

    def __repr__(self):
        R, S = self._R._short(), self._S._short()
        if self._name == "composite":
            s = "composite branching rule %s" % R
            for t, n in zip(self._inter + [self._S], self._inames):
                s += " => (%s) %s" % (n, t._short())
            return s
        return "%s branching rule %s => %s" % (self._name, R, S)

    def Rtype(self):
        """The type of the group.

        EXAMPLES::

            sage: branching_rule("A3", "C2", "symmetric").Rtype()
            ['A', 3]
        """
        return self._R

    def Stype(self):
        """The type of the subgroup.

        EXAMPLES::

            sage: branching_rule("A3", "C2", "symmetric").Stype()
            ['C', 2]
        """
        return self._S

    def _map(self, v):
        """v: a tuple of Fractions in R's ambient space -> a tuple in S's."""
        L = RootSystem_(self._R).ambient_space()
        r = self._f(AmbientVector(L, v))
        return tuple(_q(a) for a in (r._v if isinstance(r, AmbientVector) else r))

    def __call__(self, x):
        """The image of a weight.

        EXAMPLES::

            sage: b = branching_rule("B3", "D3", "extended"); b([1/2, 1/2, 1/2])
            [1/2, 1/2, 1/2]
        """
        v = x._v if isinstance(x, AmbientVector) else tuple(_q(a) for a in x)
        return [_out(a) for a in self._map(v)]

    def __mul__(self, other):
        if self._S != other._R:
            raise ValueError("can not compose: %s and %s" % (self._S, other._R))
        f1, f2 = self, other
        names = (self._inames if self._name == "composite" else [self._name]) + \
                (other._inames if other._name == "composite" else [other._name])
        inter = (self._inter if self._name == "composite" else []) + [self._S] + \
                (other._inter if other._name == "composite" else [])
        return BranchingRule(self._R, other._S, lambda x: list(f2._map(f1._map(x._v))), "composite", inter, names)

    def branch(self, chi, style=None):
        """The restriction of a character (to the ring of the same style).

        EXAMPLES::

            sage: b = branching_rule("D4", "B3", "symmetric"); b.branch(WeylCharacterRing("D4", style="coroots")(0,0,0,1))
            B3(0,0,1)
        """
        S = WeylCharacterRing(self._S, style=style or chi._P._style)
        return self._branch(chi, S)

    def _branch(self, chi, S):
        w = {}
        for v, m in chi._weights().items():
            u = S._norm(self._map(v))
            w[u] = w.get(u, 0) + m
        dec = _decompose(S._D, w)
        return S._el({S._norm(v): c for v, c in dec.items()})

    def describe(self, verbose=False, debug=False, no_r=False):
        """Print the extended Dynkin diagram of R, the Dynkin diagram of S and
        the simple roots of R that restrict to simple roots of S (or zero).

        EXAMPLES::

            sage: branching_rule("A3", "C2", "symmetric").describe()
            <BLANKLINE>
            0
            O-------+
            |       |
            |       |
            O---O---O
            1   2   3
            A3~
            root restrictions A3 => C2:
            <BLANKLINE>
            O=<=O
            1   2
            C2
            <BLANKLINE>
            1 => 1
            2 => 2
            3 => 1
            <BLANKLINE>
            For more detailed information use verbose=True
        """
        R, S = self._R, self._S
        LR = RootSystem_(R).ambient_space()
        DR, DS = LR._data, _data(S)
        lines = [""]
        if R.is_irreducible():
            lines.append(repr(R.affine().dynkin_diagram()))
            roots = [(0, _neg(_highest_root(DR)))] + list(zip(DR.I, DR.simple))
        else:
            lines.append(repr(R.dynkin_diagram()))
            roots = list(zip(DR.I, DR.simple))
        lines.append("root restrictions %s => %s:" % (R._short(), S._short()))
        lines.append("")
        lines.append(repr(S.dynkin_diagram()))
        lines.append("")
        Ssl = [_sl(DS, a) for a in DS.simple]
        for i, a in sorted(roots, key=lambda p: p[0]):
            im = self._map(a)
            if all(c == 0 for c in im):
                lines.append("%s => (zero)" % i)
                continue
            v = _sl(DS, im)
            for j, b in zip(DS.I, Ssl):
                if v == b:
                    lines.append("%s => %s" % (i, j))
                    break
        lines.append("")
        lines.append("For more detailed information use verbose=True")
        print("\n".join(lines))


def _xs(x):
    return [_q(a) for a in (x._v if isinstance(x, AmbientVector) else x)]


def _split_comps(ct):
    return ct._components or [ct]


def _rule(R, S, rule):
    """The weight map of a named branching rule, as a function on lists."""
    rc, sc = _split_comps(R), _split_comps(S)
    r = rc[0] if len(rc) == 1 else None
    s0 = sc[0]
    if rule == "identity":
        return lambda x: x
    if rule.startswith("proj"):
        picks = [int(c) for c in rule[4:]]
        offs, o = [], 0
        for c in rc:
            d = _finite_space(c._letter, c._n).dim
            offs.append((o, d))
            o += d
        return lambda x: [a for k in picks for a in x[offs[k - 1][0]:offs[k - 1][0] + offs[k - 1][1]]]
    if r is None:
        raise NotImplementedError("branching rule %s from %s" % (rule, R))
    l, n = r._letter, r._n
    sdim = sum(_finite_space(c._letter, c._n).dim for c in sc)
    if rule == "levi":
        if l == "A":
            return lambda x: x[:sdim]
        if l in "BCD":
            if len(sc) == 1 and s0._letter == "A" and s0._n == n - 1:
                return lambda x: x
            if len(sc) == 1 and (s0._letter == l or l == "D" and s0._letter == "D"):
                return lambda x: x[1:]
            return lambda x: x
        if l == "E" and len(sc) == 1 and s0._letter == "E":
            return lambda x: x
        raise NotImplementedError("levi branching rule %s => %s" % (R, S))
    if rule == "automorphic":
        if l == "A":
            return lambda x: [-a for a in reversed(x)]
        if l == "D":
            return lambda x: x[:-1] + [-x[-1]]
        if l == "E" and n == 6:
            W = WeylGroup_(RootSystem_(R).ambient_space())
            w0 = W.long_element()._m
            return lambda x: [-a for a in _matvec(w0, tuple(x))]
        raise NotImplementedError("automorphic branching rule for %s" % R)
    if rule == "symmetric":
        if l == "A" and s0._letter in "BC":
            m = s0._n
            return lambda x: [x[i] - x[n - i] for i in range(m)]
        if l == "D" and s0._letter == "B":
            return lambda x: x[:-1]
        raise NotImplementedError("symmetric branching rule %s => %s" % (R, S))
    if rule == "extended":
        if l == "G" and s0._letter == "A":
            t = _F(1, 3)
            return lambda x: [t * (x[0] - x[1]), t * (x[1] - x[2]), t * (x[2] - x[0])]
        if l == "D" and n == 2:
            return _rule(R, S, "isomorphic")
        if l in "BCDF":
            return lambda x: x
        raise NotImplementedError("extended branching rule %s => %s" % (R, S))
    if rule == "orthogonal_sum":
        if l == "D" and all(c._letter == "B" for c in sc):
            return lambda x: x[:-1]
        return lambda x: x
    if rule == "isomorphic":
        h = _F(1, 2)
        if l == "B" and n == 2 and s0._letter == "C":
            return lambda x: [x[0] + x[1], x[0] - x[1]]
        if l == "C" and n == 2 and s0._letter == "B":
            return lambda x: [h * (x[0] + x[1]), h * (x[0] - x[1])]
        if l == "D" and n == 2:
            return lambda x: [h * (x[0] - x[1]), -h * (x[0] - x[1]), h * (x[0] + x[1]), -h * (x[0] + x[1])]
        if l == "A" and n == 1 and s0._letter == "B":
            return lambda x: [h * (x[0] - x[1])]
        if l == "A" and n == 1 and s0._letter == "C":
            return lambda x: [x[0] - x[1]]
        if l in "BC" and n == 1 and s0._letter == "A":
            k = 1 if l == "B" else h
            return lambda x: [k * x[0], -k * x[0]]
        if l == "A" and n == 3 and s0._letter == "D":
            return lambda x: [h * (x[0] + x[1] - x[2] - x[3]), h * (x[0] - x[1] + x[2] - x[3]), h * (-x[0] + x[1] + x[2] - x[3])]
        if l == "D" and n == 3 and s0._letter == "A":
            return lambda x: [h * (x[0] + x[1] - x[2]), h * (x[0] - x[1] + x[2]), h * (-x[0] + x[1] + x[2]), h * (-x[0] - x[1] - x[2])]
        if R == S:
            return lambda x: x
        raise NotImplementedError("isomorphic branching rule %s => %s" % (R, S))
    if rule == "triality" and l == "D" and n == 4:
        fw = _data(R).fw
        perm = {0: 2, 2: 3, 3: 0, 1: 1}
        Winv = _inverse([list(w) for w in fw])

        def T(x):
            # x = sum_i c_i omega_i; T(omega_i) = omega_perm(i)
            c = [sum((x[k] * Winv[k][i] for k in range(4)), _F(0)) for i in range(4)]
            out = [_F(0)] * 4
            for i in range(4):
                for k in range(4):
                    out[k] += c[i] * fw[perm[i]][k]
            return out
        return T
    if rule == "symmetric_power" and len(sc) == 1 and s0._letter == "A" and s0._n == 1:
        A1 = WeylCharacterRing("A1", style="coroots")
        N = {"A": n + 1, "B": 2 * n + 1, "C": 2 * n, "D": 2 * n}[l]
        return _plethysm_map(A1([N - 1]), R)
    raise NotImplementedError("branching rule %r from %s to %s is not available in sagebrush yet" % (rule, R, S))


def _plethysm_map(chi, R):
    """The weight map R => S along the representation chi of S (into the
    classical group of type R)."""
    D = chi._P._D
    ws = []
    for w, m in chi._weights().items():
        ws += [w] * m
    ws.sort(key=lambda w: (-_dot(w, D.rho), [-a for a in w]))
    use = ws if R._letter == "A" else ws[:R._n]
    return lambda x: list(_addv_all([_smul(a, w) for a, w in zip(x, use)], D.dim))


def branching_rule(Rtype, Stype, rule="default"):
    """A branching rule from Rtype to Stype ("levi", "automorphic",
    "symmetric", "extended", "orthogonal_sum", "isomorphic", "triality",
    "symmetric_power", "projI", or a function on weights).

    EXAMPLES::

        sage: branching_rule("A3", "C2", rule="symmetric")
        symmetric branching rule A3 => C2
        sage: branching_rule("C4", "A3", "levi")*branching_rule("A3", "C2", "symmetric")
        composite branching rule C4 => (levi) A3 => (symmetric) C2
        sage: b = branching_rule("A3", "C2", "symmetric")
        sage: [b(r) for r in RootSystem("A3").ambient_space().simple_roots()]
        [[1, -1], [0, 2], [1, -1]]
    """
    R = CartanType(Rtype)
    if isinstance(rule, BranchingRule):
        return rule
    if callable(rule) and not isinstance(rule, str):
        return BranchingRule(R, CartanType(Stype), lambda x: rule(x), "custom")
    if rule == "default":
        rule = "levi"
    if rule == "plethysm":
        # Stype names a representation, e.g. "A2.adjoint_representation()" or "A1(5)"
        t = Stype.split(".")[0].split("(")[0]
        W = WeylCharacterRing(t, style="coroots")
        chi = eval(Stype.replace(t, "W", 1), {"W": W})
        return branching_rule_from_plethysm(chi, R)
    S = CartanType(Stype)
    f = _rule(R, S, rule)
    return BranchingRule(R, S, lambda x: f(_xs(x)), rule)


def branching_rule_from_plethysm(chi, cartan_type, return_matrix=False):
    """The branching rule along the representation chi into the classical
    group of the given type.

    EXAMPLES::

        sage: A1 = WeylCharacterRing("A1", style="coroots"); C3 = WeylCharacterRing("C3", style="coroots")
        sage: sym5rule = branching_rule_from_plethysm(A1([5]), "C3")
        sage: [C3(hwv).branch(A1, rule=sym5rule) for hwv in C3.fundamental_weights()]
        [A1(5), A1(4) + A1(8), A1(3) + A1(9)]
    """
    R = CartanType(cartan_type)
    f = _plethysm_map(chi, R)
    return BranchingRule(R, chi._P._ct, lambda x: f(_xs(x)), "plethysm (along %r)" % (chi,))
