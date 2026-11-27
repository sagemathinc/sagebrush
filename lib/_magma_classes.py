"""Magma mode's conjugacy classes of Sym(n) (ConjugacyClasses) and its
elliptic curves over finite fields (ChangeRing(E, GF(q))): lib/_magma.py's
signatures call into this module, loaded the first time one is used, so
that Magma mode's start doesn't carry it."""

import math as _math
import sys as _sys

import _magma as _m
from _magma import (MSeq, MTuple, MagmaError, _MPerm, _MSymGroup, _MDihedralGroup, _wrap, _global_name,
                    _bad_types, _gf_name)


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


# a class's share of the heap while ConjugacyClasses makes Sym(n)'s classes,
# at its peak (the partitions, the sort keys and the result together),
# conservatively: measured on node 24.21.0 at 763 to 975 bytes a class for n
# from 25 to 40 (less as n grows), so 2048, two collection elements' allowance
# (LIMIT-2209-1)
_CLASS_BYTES = 2048


def _classes_refusal(n, count, allow):
    """The collection memory guard's refusal, for more classes than the
    allowance holds (count, or more than count)."""
    import _capacity
    e = _m._memory_error(_m._memguard.memory_guard("A list of more than %d conjugacy classes of Sym(%d)" % (allow // _CLASS_BYTES, n),
                                                   count * _CLASS_BYTES, allow, "one collection",
                                                   fixed=_m._COLLECT_MAX == 10 ** 6))
    e.capacity = _capacity.capacity()
    return e


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


# a group element's share of the engine's peak while it lists the classes by
# enumerating the group, measured (Nov 2026, the engine native and in wasm32):
# at most 8n + 212 bytes, an abelian group's (each element its own class's
# representative too); and the enumeration's own fixed part, at most 1 KB
# (LIMIT-CLS-1)
def _element_bytes(n):
    return 8 * n + 256


_ENUM_FIXED = 4096


# a class's share of the output's peak once the engine has counted them,
# measured: its row decoded (a tuple of n images, a new int each past 256
# under CPython, the _MPerm and the MTuple: at most 40n + 700 bytes under
# CPython, 16n + 1000 in pyjs) and its words in the engine's reply (8n + 16),
# alive together (LIMIT-CLS-1)
def _class_output_bytes(n):
    return 48 * n + 1040


def _bin_classes(G):
    """The classes the engine counted, fetched by the binary op
    conjugacy_classes_bin (SBW1, engine/wire: words, no text): memoryviews
    ('Q') of the representatives' images (n a class, on 0 .. n-1), the
    lengths and the orders."""
    import array
    import _magma_groups as gr
    from _sagebrush_lib._engine import call_bin
    n = G.n
    gens = gr._engine_gens(n, gr._distinct(n, gr.gens_of(G)))
    words = array.array("Q", [x for g in gens for x in g])
    u641 = lambda w: b"".join([(12 + 8 * len(w)).to_bytes(4, "little"), b"U641", len(w).to_bytes(8, "little"), w.tobytes()])
    op = b"conjugacy_classes_bin"
    r = call_bin(b"".join([b"SBW1", len(op).to_bytes(4, "little"), op, (2).to_bytes(4, "little"), u641(array.array("Q", (n,))), u641(words)]))
    del words
    if r is None:
        raise RuntimeError("Sagebrush engine: no binary entry point for conjugacy_classes_bin")
    return _u641_results(memoryview(r))


def _u641_results(r):
    """An SBW1 reply's U641 results, as memoryviews ('Q') over it; an error
    record raises (a refused reservation, code 7, as a memory error)."""
    if bytes(r[:4]) != b"SBW1":
        raise RuntimeError("Sagebrush engine: a malformed SBW1 reply")
    if bytes(r[4:6]) == b"er":
        code = int.from_bytes(r[6:8], "little")
        text = bytes(r[18:18 + int.from_bytes(r[16:18], "little")]).decode("ascii", "replace")
        if code == 7:
            raise _m._memory_error(_m._memguard.memory_guard("The conjugacy classes' output", 0, 0, "one computation",
                                                             unmeasured="the engine's memory ledger refused its reservation"))
        raise RuntimeError("Sagebrush engine: conjugacy_classes_bin: %s" % text)
    out, i = [], 10
    for _ in range(int.from_bytes(r[6:10], "little")):
        m, k = int.from_bytes(r[i:i + 4], "little"), int.from_bytes(r[i + 8:i + 16], "little")
        if bytes(r[i + 4:i + 8]) != b"U641" or m != 12 + 8 * k:
            raise RuntimeError("Sagebrush engine: a malformed SBW1 reply")
        out.append(r[i + 16:i + 16 + 8 * k].cast("Q"))
        i += 4 + m
    if i != len(r):
        raise RuntimeError("Sagebrush engine: a malformed SBW1 reply")
    return out


def _engine_count(G):
    """The number of G's classes, the engine's (kept there for
    _engine_classes), its order times its degree admitted first."""
    import _magma_groups as gr
    n, order = G.n, gr.order(G)
    _admit_classes(order * _element_bytes(n) + _ENUM_FIXED, "The conjugacy classes of a permutation group of order %d" % order)
    return gr._engine_group(G, "conjugacy_class_count")


def _admit_classes(need, what):
    allow = _m._COLLECT_MAX * _m._COLLECT_COST
    if need > allow:
        import _capacity
        e = _m._memory_error(_m._memguard.memory_guard(what, need, allow, "one computation", fixed=_m._COLLECT_MAX == 10 ** 6))
        e.capacity = _capacity.capacity()
        raise e


def _engine_classes(G):
    """The conjugacy classes of any other permutation group, from the group
    engine: Sagebrush's canonical order and representatives (each class's
    least element, by its sequence of images; the classes by the order of
    their elements, then their length, then their representative), not
    Magma's, whose representatives come from its own algorithm.  The
    elements are enumerated, admitted first by the memory guard."""
    import _magma_groups as gr
    n = G.n
    count = _engine_count(G)
    # (then their output, by their number, before the engine writes it)
    try:
        _admit_classes(count * _class_output_bytes(n), "The %d conjugacy classes of a permutation group of order %d" % (count, gr.order(G)))
    except BaseException:
        gr._engine_group(G, "conjugacy_classes_clear")
        raise
    reps, lengths, orders = _bin_classes(G)
    rows = [MTuple([orders[i], lengths[i], _MPerm(G, tuple(x + 1 for x in reps[i * n:(i + 1) * n]))]) for i in range(count)]
    del reps
    C = _MClasses(rows)
    C._G, C._classes_table = G, True
    return C


def _partition_number(n):
    """The number of partitions of n (Sym(n)'s classes), by Euler's
    pentagonal number recurrence: about n^1.5 steps, exact for any n."""
    p = [1] + [0] * n
    for m in range(1, n + 1):
        t, k = 0, 1
        while True:
            g1 = k * (3 * k - 1) // 2
            if g1 > m:
                break
            sign = 1 if k % 2 else -1
            t += sign * p[m - g1]
            g2 = k * (3 * k + 1) // 2
            if g2 <= m:
                t += sign * p[m - g2]
            k += 1
        p[m] = t
    return p[n]


def number_of_classes(G):
    """The number of conjugacy classes: Sym(n)'s, the partitions of n,
    counted for any n; another group's, listed by the engine."""
    if isinstance(G, _MSymGroup) or (isinstance(G, _MDihedralGroup) and G.n == 3):
        return _partition_number(G.n)
    import _magma_groups as gr
    count = _engine_count(G)
    gr._engine_group(G, "conjugacy_classes_clear")
    return count


def conjugacy_classes(G):
    """Sym(n)'s conjugacy classes, one for each cycle type, as Magma 2.18
    lists them: by the order of their elements, then by their length, then
    with the representative whose sequence of images is the larger first;
    each representative is the type's cycles from the longest, on 1, 2, ...
    in turn.  (Checked against Magma for every n up to 30; the same rule
    for any n.)  A dihedral
    group's representatives are those of Magma's own algorithm, not
    modelled (DihedralGroup(3) is Sym(3))."""
    if not (isinstance(G, _MSymGroup) or (isinstance(G, _MDihedralGroup) and G.n == 3)):
        return _engine_classes(G)
    n = G.n
    # (the classes are one collection, admitted before any is made by their
    # peak while they are made: _CLASS_BYTES each against the collection
    # allowance; whatever n, memory is the only bound)
    allow = _m._COLLECT_MAX * _m._COLLECT_COST
    count = _partition_count(n, allow // _CLASS_BYTES)
    if count * _CLASS_BYTES > allow:
        raise _classes_refusal(n, count, allow)
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
