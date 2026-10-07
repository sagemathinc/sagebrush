"""Sage's permutation groups, on Sagebrush's engine (engine/group):

    G = PermutationGroup(['(1,2,3)(4,5)', '(1,4)'])
    G.order(), G.is_transitive(), G.is_primitive(), G.blocks_all()
    MathieuGroup(23).order()            # 10200960

Points are 1..n and elements multiply left to right (g*h applies g first),
as in Sage and GAP.  Orders and membership are exact: the engine's
stabilizer chains are completed by the deterministic Schreier-Sims test.
"""

from sagebrush._engine import call as _call

__all__ = ["PermutationGroup", "PermutationGroupElement", "SymmetricGroup", "AlternatingGroup",
           "CyclicPermutationGroup", "DihedralGroup", "MathieuGroup", "PSL", "PGL", "AGL1",
           "KleinFourGroup", "TransitiveGroup", "TransitiveGroups"]


def _Int(x):
    try:
        from _sage_lang import Integer
        return Integer(x)
    except ImportError:
        return int(x)


def _parse_cycles(s):
    s = s.strip().replace(" ", "")
    if s in ("", "()"):
        return []
    if not (s.startswith("(") and s.endswith(")")):
        raise ValueError("cannot read %r as cycles" % s)
    return [tuple(int(x) for x in c.split(",") if x) for c in s[1:-1].split(")(")]


def _cycles_of(g):
    """cycles (1-based tuples) from a string, tuple of points, list of tuples, or element"""
    if isinstance(g, PermutationGroupElement):
        return g.cycle_tuples()
    if isinstance(g, str):
        return _parse_cycles(g)
    if isinstance(g, tuple):
        return [tuple(int(x) for x in g)] if g and not isinstance(g[0], (tuple, list)) else [tuple(int(x) for x in c) for c in g]
    if isinstance(g, list):
        if g and all(isinstance(x, (tuple, list)) for x in g):
            return [tuple(int(x) for x in c) for c in g]
        return None  # one-line notation: images
    raise TypeError("cannot make a permutation from %r" % (g,))


def _images(g, n=None):
    """0-based images; n is grown to fit"""
    if isinstance(g, PermutationGroupElement):
        im = list(g._im)
    else:
        cyc = _cycles_of(g)
        if cyc is None:
            im = [int(x) - 1 for x in g]
            if sorted(im) != list(range(len(im))):
                raise ValueError("%r is not a permutation of 1..%d" % (g, len(im)))
        else:
            m = max([max(c) for c in cyc if c] + [0])
            im = list(range(m))
            seen = set()
            for c in cyc:
                for i, x in enumerate(c):
                    if x < 1:
                        raise ValueError("points are 1, 2, 3, ...")
                    if x in seen:
                        raise ValueError("the cycles of %r are not disjoint" % (g,))
                    seen.add(x)
                    im[x - 1] = c[(i + 1) % len(c)] - 1
    if n is not None and len(im) < n:
        im += list(range(len(im), n))
    return im


class PermutationGroupElement:
    """A permutation of 1..n, printed in cycle notation as Sage does."""
    __slots__ = ("_im", "_parent")

    def __init__(self, g, parent=None, check=True):
        n = parent.degree() if parent is not None else None
        im = _images(g, n)
        if parent is not None and len(im) > n:
            if any(im[i] != i for i in range(n, len(im))):
                raise ValueError("%s is not in %s" % (g, parent))
            im = im[:n]
        self._im = tuple(im)
        self._parent = parent
        if check and parent is not None and not parent._contains_images(self._im):
            raise ValueError("permutation %s not in %s" % (self, parent))

    @classmethod
    def _make(cls, im, parent=None):
        e = cls.__new__(cls)
        e._im = tuple(im)
        e._parent = parent
        return e

    def parent(self):
        return self._parent

    def _common(self, other):
        if not isinstance(other, PermutationGroupElement):
            other = PermutationGroupElement(other)
        n = max(len(self._im), len(other._im))
        a = list(self._im) + list(range(len(self._im), n))
        b = list(other._im) + list(range(len(other._im), n))
        return a, b

    def __mul__(self, other):
        if not isinstance(other, (PermutationGroupElement, str, tuple, list)):
            return NotImplemented
        a, b = self._common(other)
        return PermutationGroupElement._make([b[x] for x in a], self._parent)

    def __rmul__(self, other):
        return PermutationGroupElement(other) * self

    def inverse(self):
        r = [0] * len(self._im)
        for x, y in enumerate(self._im):
            r[y] = x
        return PermutationGroupElement._make(r, self._parent)

    __invert__ = inverse

    def __pow__(self, k):
        k = int(k)
        base = self if k >= 0 else self.inverse()
        r = PermutationGroupElement._make(range(len(self._im)), self._parent)
        k = abs(k)
        while k:
            if k & 1:
                r = r * base
            base = base * base
            k >>= 1
        return r

    def __truediv__(self, other):
        return self * PermutationGroupElement(other).inverse()

    def __call__(self, i):
        i = int(i)
        return _Int(self._im[i - 1] + 1) if 1 <= i <= len(self._im) else _Int(i)

    def __eq__(self, other):
        try:
            a, b = self._common(other)
        except (TypeError, ValueError):
            return False
        return a == b

    def __ne__(self, other):
        return not self == other

    def __lt__(self, other):
        a, b = self._common(other)
        return a < b

    def __hash__(self):
        im = list(self._im)
        while im and im[-1] == len(im) - 1:
            im.pop()
        return hash(tuple(im))

    def cycle_tuples(self, singletons=False):
        n, seen, out = len(self._im), set(), []
        for s in range(n):
            if s in seen:
                continue
            c, x = [], s
            while x not in seen:
                seen.add(x)
                c.append(x + 1)
                x = self._im[x]
            if len(c) > 1 or singletons:
                out.append(tuple(_Int(v) for v in c))
        return out

    def cycle_string(self):
        return "".join("(" + ",".join(str(v) for v in c) + ")" for c in self.cycle_tuples()) or "()"

    def __repr__(self):
        return self.cycle_string()

    __str__ = __repr__

    def _latex_(self):
        cs = self.cycle_tuples()
        return "".join("(" + ",".join(str(v) for v in c) + ")" for c in cs) or "()"

    def cycle_type(self, singletons=True):
        t = sorted((len(c) for c in self.cycle_tuples(singletons=True)), reverse=True)
        if not singletons:
            t = [l for l in t if l > 1]
        return [_Int(l) for l in t]

    def order(self):
        from math import gcd
        r = 1
        for c in self.cycle_tuples():
            r = r * len(c) // gcd(r, len(c))
        return _Int(r)

    def sign(self):
        return _Int(-1 if sum(len(c) - 1 for c in self.cycle_tuples()) % 2 else 1)

    def is_one(self):
        return all(x == i for i, x in enumerate(self._im))

    def domain(self):
        return [_Int(i + 1) for i in range(len(self._im))]

    def tuple(self):
        return tuple(_Int(x + 1) for x in self._im)

    def dict(self):
        return {_Int(i + 1): _Int(x + 1) for i, x in enumerate(self._im)}

    def conjugate(self, h):
        h = PermutationGroupElement(h)
        return h.inverse() * self * h


class PermutationGroup:
    """The group generated by permutations of 1..n (Sage's PermutationGroup)."""

    def __init__(self, gens=None, gap_group=None, domain=None, canonicalize=True, category=None):
        if gens is None:
            gens = []
        if isinstance(gens, PermutationGroup):
            gens = gens.gens()
        ims = [_images(g) for g in gens]
        n = max([len(i) for i in ims] + [0])
        if domain is not None:
            dom = list(domain)
            if dom != list(range(1, len(dom) + 1)):
                raise NotImplementedError("only the domain 1..n is supported")
            n = max(n, len(dom))
        self._n = n
        self._gens = [tuple(i + list(range(len(i), n))) for i in ims]
        self._cache = {}

    # --- the engine
    def _q(self, *what, **args):
        r = _call("perm_group", n=self._n, gens=[list(g) for g in self._gens], what=list(what), **args)
        return r if len(what) > 1 else r[what[0]]

    def _cached(self, key, *what, **args):
        if key not in self._cache:
            self._cache[key] = self._q(*what, **args)
        return self._cache[key]

    def _elt(self, im):
        return PermutationGroupElement._make(im, self)

    def _sub(self, gens):
        return PermutationGroup([self._elt(g) for g in gens], domain=range(1, self._n + 1)) if self._n else PermutationGroup([])

    def _contains_images(self, im):
        if all(x == i for i, x in enumerate(im)):
            return True
        return self._q("contains", g=list(im))

    # --- basics
    def __repr__(self):
        return "Permutation Group with generators [%s]" % ", ".join(str(g) for g in self.gens())

    def _latex_(self):
        return "\\langle " + ", ".join(g._latex_() for g in self.gens()) + " \\rangle"

    def degree(self):
        return _Int(self._n)

    def domain(self):
        return [_Int(i) for i in range(1, self._n + 1)]

    def gens(self):
        return [self._elt(g) for g in self._gens]

    def gen(self, i=0):
        return self.gens()[i]

    def ngens(self):
        return _Int(len(self._gens))

    def identity(self):
        return self._elt(range(self._n))

    one = identity

    def __call__(self, g, check=True):
        return PermutationGroupElement(g, self, check=check)

    def order(self):
        return _Int(int(self._cached("order", "order")))

    cardinality = order

    def __contains__(self, g):
        try:
            im = _images(g, self._n)
        except (TypeError, ValueError):
            return False
        if len(im) > self._n:
            if any(im[i] != i for i in range(self._n, len(im))):
                return False
            im = im[:self._n]
        return self._contains_images(im)

    def __eq__(self, other):
        if not isinstance(other, PermutationGroup):
            return False
        return self.degree() == other.degree() and self.order() == other.order() and other.is_subgroup(self)

    def __ne__(self, other):
        return not self == other

    def __hash__(self):
        return hash((self._n, int(self.order())))

    def is_subgroup(self, other):
        """Is self a subgroup of other?"""
        n = max(self._n, other._n)
        return _call("perm_group", n=n, gens=[list(g) + list(range(self._n, n)) for g in other._gens] or [list(range(n))],
                     what=["is_subgroup"], sub=[list(g) + list(range(self._n, n)) for g in self._gens] or [list(range(n))])["is_subgroup"]

    def is_normal(self, other):
        """Is self a normal subgroup of other?"""
        n = max(self._n, other._n)
        pad = lambda gs: [list(g) + list(range(len(g), n)) for g in gs] or [list(range(n))]
        return _call("perm_group", n=n, gens=pad(other._gens), what=["is_normal"], sub=pad(self._gens))["is_normal"]

    def subgroup(self, gens):
        H = PermutationGroup([PermutationGroupElement(g, self) for g in gens], domain=range(1, self._n + 1))
        return H

    def random_element(self):
        import random
        return self._elt(self._q("random", seed=random.getrandbits(62))[0])

    def list(self):
        return [self._elt(g) for g in self._q("elements", limit=10 ** 6)]

    def __iter__(self):
        return iter(self.list())

    # --- orbits and blocks
    def orbits(self):
        return [tuple(_Int(x + 1) for x in o) for o in self._cached("orbits", "orbits")]

    def orbit(self, point):
        return tuple(_Int(x + 1) for x in self._q("orbit", point=int(point) - 1))

    def is_transitive(self, domain=None):
        if domain is not None:
            dom = sorted(int(x) for x in domain)
            return any(sorted(o) == dom for o in self.orbits())
        return self._cached("is_transitive", "is_transitive")

    def is_primitive(self, domain=None):
        return self._cached("is_primitive", "is_primitive")

    def transitivity(self):
        """the largest k for which the group is k-transitive (Sagebrush; GAP's Transitivity)"""
        return _Int(self._cached("transitivity", "transitivity"))

    def blocks_all(self, representatives=True):
        """For a transitive group, the block containing 1 of each nontrivial
        block system (or, with representatives=False, the systems)."""
        bs = self._q("blocks", point=0)
        if representatives:
            return [[_Int(x + 1) for x in b] for b in bs]
        return [[[_Int(x + 1) for x in c] for c in self._q("block_system", block=b)] for b in bs]

    def minimal_block(self, points):
        """the smallest block containing the given points (Sagebrush)"""
        return [_Int(x + 1) for x in self._q("min_block", block=[int(p) - 1 for p in points])]

    # --- subgroups
    def stabilizer(self, point):
        r = self._q("stabilizer", point=int(point) - 1)
        H = self._sub(r["gens"])
        H._cache["order"] = r["order"]
        return H

    def derived_subgroup(self):
        r = self._q("derived_subgroup")
        H = self._sub(r["gens"])
        H._cache["order"] = r["order"]
        return H

    commutator = derived_subgroup

    def derived_series(self):
        out = []
        for r in self._q("derived_series"):
            H = self._sub(r["gens"])
            H._cache["order"] = r["order"]
            out.append(H)
        return out

    def is_abelian(self):
        return self._cached("is_abelian", "is_abelian")

    is_commutative = is_abelian

    def is_solvable(self):
        return self._cached("is_solvable", "is_solvable")

    def is_perfect(self):
        return self.derived_subgroup().order() == self.order()

    def is_simple(self):
        """True for the groups of prime order and the perfect groups whose
        derived series stops at once and that are primitive and 2-transitive...
        (not implemented in general yet)"""
        raise NotImplementedError("is_simple needs composition series (coming)")

    def cycle_type_counts(self, limit=200000, samples=10000):
        """{cycle type: number of elements} (exact when the order is at most
        limit, else estimated from random elements; Sagebrush)"""
        r = self._q("cycle_type_counts", limit=limit, samples=samples)
        return {tuple(_Int(x) for x in t): _Int(k) for t, k in r["counts"]}


def _named(name, n, cls, text):
    r = _call("perm_group_named", name=name, n=int(n))
    G = object.__new__(cls)
    PermutationGroup.__init__(G, [PermutationGroupElement._make(g) for g in r["gens"]], domain=range(1, r["n"] + 1))
    G._text = text
    return G


class _Named(PermutationGroup):
    def __repr__(self):
        return self._text


class SymmetricGroup(_Named):
    def __new__(cls, n):
        return _named("symmetric", n, cls, "Symmetric group of order %d! as a permutation group" % int(n))

    def __init__(self, n):
        pass


class AlternatingGroup(_Named):
    def __new__(cls, n):
        return _named("alternating", n, cls, "Alternating group of order %d!/2 as a permutation group" % int(n))

    def __init__(self, n):
        pass


class CyclicPermutationGroup(_Named):
    def __new__(cls, n):
        return _named("cyclic", n, cls, "Cyclic group of order %d as a permutation group" % int(n))

    def __init__(self, n):
        pass


class DihedralGroup(_Named):
    def __new__(cls, n):
        return _named("dihedral", n, cls, "Dihedral group of order %d as a permutation group" % (2 * int(n)))

    def __init__(self, n):
        pass


class MathieuGroup(_Named):
    def __new__(cls, n):
        G = _named("mathieu", n, cls, "")
        G._text = "Mathieu group of degree %d and order %d as a permutation group" % (int(n), int(G.order()))
        return G

    def __init__(self, n):
        pass


def PSL(n, q):
    if int(n) != 2:
        raise NotImplementedError("PSL(n, q) for n = 2 (on the projective line) only")
    return _named("psl2", q, _Named, "The projective special linear group of degree 2 over Finite Field of size %d" % int(q))


def PGL(n, q):
    if int(n) != 2:
        raise NotImplementedError("PGL(n, q) for n = 2 (on the projective line) only")
    return _named("pgl2", q, _Named, "The projective general linear group of degree 2 over Finite Field of size %d" % int(q))


def AGL1(p):
    """AGL(1, p) = {x -> ax + b} on the p points of F_p (Sagebrush)"""
    return _named("agl1", p, _Named, "The affine group AGL(1, %d) as a permutation group" % int(p))


def KleinFourGroup():
    G = PermutationGroup(["(1,2)(3,4)", "(1,3)(2,4)"])
    G.__class__ = _Named
    G._text = "The Klein 4 group of order 4, as a permutation group"
    return G


class TransitiveGroup(_Named):
    """The transitive group nTk: number k of degree n in the standard
    numbering (degrees up to 13, and 17, 19, 23).  Sagebrush computed these groups itself
    (engine/group); the numbering and the names were matched against GAP's
    transitive groups library."""

    def __new__(cls, n, k):
        r = _call("transitive_group", n=int(n), k=int(k))
        G = object.__new__(cls)
        PermutationGroup.__init__(G, [PermutationGroupElement._make(g) for g in r["gens"]], domain=range(1, int(n) + 1))
        G._text = "Transitive group number %d of degree %d" % (int(k), int(n))
        G._n, G._k, G._name = int(n), int(k), r["name"]
        G._order_str = r["order"]
        return G

    def __init__(self, n, k):
        pass

    def transitive_number(self):
        return _Int(self._k)

    def transitive_label(self):
        return "%dT%d" % (self._n, self._k)

    def name(self):
        """The name in the transitive groups library, e.g. 'F(5) = [5]4 = 5:4'."""
        return self._name


class TransitiveGroups:
    """The transitive groups of degree n, up to conjugacy (n <= 13 or n = 17, 19, 23)."""

    def __init__(self, n):
        self._n = int(n)
        self._count = _call("transitive_group", n=self._n)

    def __repr__(self):
        return "Transitive Groups of degree %d" % self._n

    def cardinality(self):
        return _Int(self._count)

    def __len__(self):
        return self._count

    def __getitem__(self, k):
        return TransitiveGroup(self._n, k)

    def __iter__(self):
        return (TransitiveGroup(self._n, k) for k in range(1, self._count + 1))

    def __contains__(self, G):
        return isinstance(G, TransitiveGroup) and G._n == self._n


def galois_group(f, proof=None):
    """The Galois group of an irreducible polynomial over QQ (degree <= 13, or 17, 19, 23),
    given by its integer coefficients (constant term first), as a
    TransitiveGroup.  G.proven tells whether every step was proven
    (proof=None proves the steps that are cheap to prove, proof=True all of
    them, however long that takes, proof=False none); G.galois_log() says
    how the group was found."""
    c = [str(a) for a in f]
    r = _call("galois_group", f=",".join(c), proof=proof)
    G = TransitiveGroup(r["n"], r["k"])
    G.proven = r["proven"]
    G._log = r["log"]
    G.galois_log = lambda: print("\n".join(G._log))
    return G
