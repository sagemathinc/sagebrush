"""Magma mode's conjugacy classes of Sym(n) (ConjugacyClasses) and its
elliptic curves over finite fields (ChangeRing(E, GF(q))): lib/_magma.py's
signatures call into this module, loaded the first time one is used, so
that Magma mode's start doesn't carry it."""

import math as _math
import sys as _sys

import _magma as _m
from _magma import (MSeq, MTuple, MagmaError, _MPerm, _MSymGroup, _MDihedralGroup, _wrap, _global_name,
                    _bad_types, _collect_refusal, _gf_name)


def _term(c, mono):
    """c*mono as Magma prints a term: mono alone for c = 1, c alone for a
    constant."""
    return "%d" % c if not mono else mono if c == 1 else "%d*%s" % (c, mono)


def _curve_ff_refusals(cls, what):
    """The methods the elliptic curve intrinsics call (Conductor(E) is
    E.conductor()), each refusing in words for a curve ChangeRing made over
    a finite field."""
    for meth, name in (("a_invariants", "aInvariants"), ("b_invariants", "bInvariants"),
                       ("j_invariant", "jInvariant"), ("discriminant", "Discriminant"),
                       ("conductor", "Conductor"), ("cremona_label", "CremonaReference"),
                       ("torsion_order", "TorsionSubgroup"), ("ap", "TraceOfFrobenius"), ("rank", "Rank")):
        def refuse(self, *args, _name=name):
            raise MagmaError("%s of %s is not supported yet" % (_name, what), "'%s'" % _name)
        setattr(cls, meth, refuse)
    return cls


class _MEllFF:
    """An elliptic curve over GF(q) that ChangeRing made from one over the
    rationals (CrvEll[FldFin]): its a-invariants in the prime field, printed
    and counted as Magma's."""

    _lazy_magma_type = "CrvEll"

    def __init__(self, F, a):
        self.F, self.a = F, tuple(a)

    def __repr__(self):
        a1, a2, a3, a4, a6 = self.a
        lhs = "y^2" + "".join(" + " + _term(c, m) for c, m in ((a1, "x*y"), (a3, "y")) if c)
        rhs = "x^3" + "".join(" + " + _term(c, m) for c, m in ((a2, "x^2"), (a4, "x"), (a6, "")) if c)
        # (wrapped at 80 columns where it is printed, as any value)
        return "Elliptic Curve defined by %s = %s over %s" % (lhs, rhs, _gf_name(self.F))

    def __eq__(self, other):
        return isinstance(other, _MEllFF) and other.F is self.F and other.a == self.a

    def __hash__(self):
        return hash(("CrvEll", self.F.q, self.a))

    def _magma_card(self):
        # (over GF(p), counted by Sage mode's point counting; over GF(p^k)
        # from it: q + 1 - (alpha^k + beta^k), with alpha + beta = t and
        # alpha*beta = p, t = p + 1 - #E(GF(p)))
        import _sage_ec_ff as _ecff
        p, k = self.F.p, self.F.n
        try:
            N = _ecff._count(_ecff._Curve(self.a, p))
        except NotImplementedError:
            raise MagmaError("the number of points of an elliptic curve over GF(p) with p >= 2^64 is not supported yet, "
                             "except for j-invariant 0 or 1728", "'#'")
        t = p + 1 - N
        s0, s1 = 2, t
        for _ in range(k - 1):
            s0, s1 = s1, t * s1 - p * s0
        return self.F.q + 1 - s1


class _MPlaneCubic:
    """What ChangeRing makes of an elliptic curve over GF(q) whose
    reduction is singular (the model's discriminant is 0 there): as
    Magma's, a plane curve (CrvPln[FldFin]), the projective Weierstrass
    cubic in $.1, $.2, $.3; # of it is Bad argument types, as in Magma."""

    _lazy_magma_type = "CrvPln"

    def __init__(self, F, a):
        self.F, self.a = F, tuple(a)

    def __repr__(self):
        a1, a2, a3, a4, a6 = self.a
        p = self.F.p
        # x^3 + a2 x^2 z - a1 xyz - y^2 z + a4 x z^2 - a3 y z^2 + a6 z^3, its
        # terms in Magma's (graded reverse lexicographic) order
        terms = ((1, "$.1^3"), (a2, "$.1^2*$.3"), (-a1, "$.1*$.2*$.3"), (-1, "$.2^2*$.3"),
                 (a4, "$.1*$.3^2"), (-a3, "$.2*$.3^2"), (a6, "$.3^3"))
        f = " + ".join(_term(c % p, m) for c, m in terms if c % p)
        return "Curve over %s defined by\n%s" % (_gf_name(self.F), _wrap(f, 0, 4))

    def __eq__(self, other):
        return isinstance(other, _MPlaneCubic) and other.F is self.F and other.a == self.a

    def __hash__(self):
        return hash(("CrvPln", self.F.q, self.a))

    def _magma_card(self):
        raise _bad_types("#", (self,))


_curve_ff_refusals(_MEllFF, "an elliptic curve over a finite field")
_curve_ff_refusals(_MPlaneCubic, "a plane curve")


def change_ring_curve(E, F):
    """An elliptic curve over the rationals (its coefficients integers, as
    EllipticCurve takes them so far) with its coefficients mapped into
    GF(q): an elliptic curve over GF(q), or the singular plane cubic when
    the model's discriminant is 0 there, as Magma's."""
    if isinstance(E, _MEllFF):
        raise MagmaError("ChangeRing of an elliptic curve over a finite field is not supported yet", "'ChangeRing'")
    p = F.p
    a = [int(c) % p for c in E.a_invariants()]
    return _MPlaneCubic(F, a) if int(E.discriminant()) % p == 0 else _MEllFF(F, a)


# the largest n of Sym(n) whose classes ConjugacyClasses lists: the range
# its order and representatives were checked against Magma 2.18 in
_CLASSES_SYM_N = 30


def _partition_count(n, stop):
    """The number of partitions of n (Sym(n)'s classes), counted, not
    listed; once more than stop, a number more than stop."""
    p = [1] + [0] * n
    for k in range(1, n + 1):
        for m in range(k, n + 1):
            p[m] += p[m - k]
        if p[n] > stop:
            break
    return p[n]


def _partitions(n):
    """The partitions of n, each a list of parts from the largest, one at a
    time (none kept)."""
    stack = [(n, n, [])]
    while stack:
        rest, top, parts = stack.pop()
        if rest == 0:
            yield parts
            continue
        for k in range(1, min(rest, top) + 1):
            stack.append((rest - k, k, parts + [k]))


class _MClasses(MSeq):
    """ConjugacyClasses(G): the sequence of tuples <order, length, rep>,
    printed as Magma prints it, as a table under a heading, until it is
    changed (C[1] := x, Append, Remove: then a sequence as any other, as in
    Magma; a copy, D := C, keeps the table)."""

    __slots__ = ("_G", "_classes_table")

    def _plain(self):
        self._classes_table = False

    def __setitem__(self, i, x):
        self._plain()
        MSeq.__setitem__(self, i, x)

    def __delitem__(self, i):
        self._plain()
        MSeq.__delitem__(self, i)

    def __iadd__(self, other):
        self._plain()
        return MSeq.__iadd__(self, other)

    def append(self, x):
        self._plain()
        MSeq.append(self, x)

    def extend(self, xs):
        self._plain()
        MSeq.extend(self, xs)

    def insert(self, i, x):
        self._plain()
        MSeq.insert(self, i, x)

    def pop(self, *i):
        self._plain()
        return MSeq.pop(self, *i)

    def remove(self, x):
        self._plain()
        MSeq.remove(self, x)

    def sort(self, **k):
        self._plain()
        MSeq.sort(self, **k)

    def reverse(self):
        self._plain()
        MSeq.reverse(self)

    def clear(self):
        self._plain()
        MSeq.clear(self)

    def _table_copy(self, t):
        """The copy _own made of it, t, as such a sequence (D := C keeps the
        table)."""
        c = _MClasses(t, t.universe, t.sample)
        for a in ("_inf", "_wit", "_null"):
            if hasattr(t, a):
                setattr(c, a, getattr(t, a))
        c._G, c._classes_table = self._G, self._classes_table
        return c

    def _table(self):
        """The table (Magma 2.18's layout): a heading naming the group if a
        variable holds it, then each class's order and length on one line
        and its representative on the next, a line wrapped at 80 columns
        indented by 12."""
        name = _global_name(self._G)
        head = "Conjugacy Classes" + (" of group %s" % name if name else "")
        blocks = []
        for i, (o, n, r) in enumerate(self, 1):
            blocks.append(("[%d]" % i).ljust(8) + "Order %-7d Length %-7d\n" % (o, n) + " " * 8 + _wrap("Rep " + repr(r), 8, 12) + "\n")
        return head + "\n" + "-" * len(head) + "\n" + "\n".join(blocks) + "\n"


def _classes_group(G):
    """The group the classes' representatives are in: the first variable's
    that holds a group equal to G (Magma's Sym(n) is one object: after G :=
    Sym(5), Sym(5)'s classes are of group G, their identity Id(G))."""
    main = _sys.modules.get("__main__")
    for k, v in (vars(main).items() if main is not None else ()):
        if not k.startswith("_") and isinstance(v, (_MSymGroup, _MDihedralGroup)) and v == G:
            return v
    return G


def conjugacy_classes(G):
    """Sym(n)'s conjugacy classes, one for each cycle type, as Magma 2.18
    lists them: by the order of their elements, then by their length, then
    with the representative whose sequence of images is the larger first;
    each representative is the type's cycles from the longest, on 1, 2, ...
    in turn.  (Checked against Magma for every n up to 30, the n listed.)  A dihedral
    group's representatives are those of Magma's own algorithm, not
    modelled (DihedralGroup(3) is Sym(3))."""
    if isinstance(G, _MDihedralGroup) and G.n != 3:
        raise MagmaError("ConjugacyClasses of a dihedral group is not supported yet", "'ConjugacyClasses'")
    n = G.n
    # (n up to 30 only: the order and representatives are checked against
    # Magma that far, 5604 classes; a coverage bound, LIMIT-2209-1)
    if n > _CLASSES_SYM_N:
        raise MagmaError("ConjugacyClasses of Sym(n) for n above %d is not supported yet" % _CLASSES_SYM_N, "'ConjugacyClasses'")
    # (and the classes are one collection, refused as one, before any is
    # made, in a heap too small for them)
    if _partition_count(n, _m._COLLECT_MAX) > _m._COLLECT_MAX:
        raise _collect_refusal()
    H = _classes_group(G)
    # (each class's permutation made once, the one the result holds, and no
    # other copy of its images: the rows are sorted by the permutations'
    # own images, larger first, then (stably) by order and length, and
    # each row becomes its class's tuple in place, so the peak is about the
    # result itself; LIMIT-2209-1)
    rows = []
    for lam in _partitions(n):
        img, a, o = list(range(1, n + 1)), 1, 1
        size = _math.factorial(n)
        for k in lam:
            if k > 1:
                for j in range(k):
                    img[a + j - 1] = a + (j + 1) % k
                a += k
                o = o * k // _math.gcd(o, k)
        for k in set(lam):
            m = lam.count(k)
            size //= k ** m * _math.factorial(m)
        rows.append((o, size, _MPerm(H, img)))
    rows.sort(key=lambda t: t[2].images, reverse=True)
    rows.sort(key=lambda t: (t[0], t[1]))
    for i, (o, size, p) in enumerate(rows):
        rows[i] = MTuple([o, size, p])
    C = _MClasses(rows)
    del rows
    C._G, C._classes_table = H, True
    return C
