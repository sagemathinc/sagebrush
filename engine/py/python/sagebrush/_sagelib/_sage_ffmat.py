"""Matrices and vectors over finite fields (and Z/nZ for the arithmetic), as
in Sage: matrix(GF(p), rows), MatrixSpace(GF(q), m, n), VectorSpace(GF(q),
n), vector(GF(q), entries); arithmetic, echelon form, rank, determinant,
inverse, kernels (left: kernel(), and right), solving, characteristic
polynomials, multiplicative orders, subspaces.  Gaussian elimination over
the field; printed as Sage prints them."""

import random as _random

import _sage_ff as _ff
from fractions import Fraction as _F


def _sa():
    import sage_all
    return sage_all


def _is_ff(base):
    # finite fields, Z/nZ, and other exact fields with elements of their own
    # (QQbar, AA: _is_generic_field) whose matrices are Gaussian elimination
    return isinstance(base, (_ff.IntegerModRing_, _ff.FiniteField_ext)) or getattr(base, "_is_generic_field", False)


def _field_elements(base):
    """The elements of a finite field, for iterating over its vector
    spaces (refused beyond the entry limit rather than listed)."""
    from _sage_matrix import _MAX_ENTRIES
    q = int(base.order())
    if q > _MAX_ENTRIES:
        raise NotImplementedError("iterating over a vector space over a field of %d elements is not available in sagebrush yet" % q)
    return list(base)


def _double_field(base):
    """Whether base is a numerical field of at most 53 bits (RDF, CDF, RR,
    CC, RealField(p) or ComplexField(p) for p <= 53), whose matrices' linear
    algebra numpy does in doubles.  A higher precision is done in the
    field's own arithmetic: numpy's doubles padded to 200 bits were a
    plausible wrong answer (RealField(200) 4 x 4 determinants, inverses,
    solutions and eigenvalues)."""
    if not getattr(base, "_numeric", False):
        return False
    prec = getattr(base, "precision", None)
    return not callable(prec) or int(prec()) <= 53


def _mp_field(base):
    """A numerical field of more than 53 bits (RealField(p), ComplexField(p))."""
    return getattr(base, "_numeric", False) and not _double_field(base)


def _field(base):
    return isinstance(base, _ff.FiniteField_ext) or getattr(base, "_is_generic_field", False) or (isinstance(base, _ff.IntegerModRing_) and base.is_field())


# ------------------------------------------------------------------ memory

# One matrix may use at most this share of the old generation the process
# can grow to (sys._sagebrush_heap_limit, from the host: --max-old-space-size
# when given; V8's heap_size_limit, which adds a young generation of a size
# that varies by Node version, gave GitHub's Node 24 half again the budget
# the VMs had, and its test admitted a matrix the VMs refused).  The admitted
# matrix, the operands of the operation that made it and that operation's
# working copies then fit together: a 512 x 512 matrix over AA ran V8 out
# of memory in a 96 MiB heap instead of being refused (daybreak2's
# HARD-F4E-1).  _MAX_ENTRIES stays the absolute ceiling.
_HEAP_SHARE = 4


def _heap_limit():
    import sys
    n = getattr(sys, "_sagebrush_heap_limit", None)
    # (CPython, or a host that cannot say: a nominal 1 GiB)
    return int(n) if n else 1 << 30


def _entry_cost(base):
    """A conservative estimate of the heap one entry over base takes, in
    bytes, with its share of the working copies of an elementwise
    operation: measured in a 96 MiB heap as the largest n for which an n x
    n matrix of distinct entries and its sum with itself fit."""
    # (bytes: about 39 * 10^6 / n^2 for the largest such n, so that the
    # budget admits 0.8 n there; measured on sagebrush-3, Oct 16 2026: GF(p)
    # 512, GF(4) 314, GF(2^8) 245, RR 362, RealField(1000) 285, CDF 256,
    # ComplexField(1000) 221, QQ(sqrt2) 232, degree 4 199, degree 8 161,
    # AA with rational entries 210, with sqrt(2) 167, with 2^(1/5) + sqrt(3)
    # 162, QQbar 185; GF(2^127 - 1) 484, Zmod(2^400 + 1) 358, GF(2^16) 268,
    # GF(2^32) 221, GF(1009^6) 275)
    import _sage_nf
    import _sage_qqbar as qb
    import _sage_rdf
    if isinstance(base, _ff.IntegerModRing_):
        return 150 + 2 * int(base.order()).bit_length() // 5
    if isinstance(base, _ff.FiniteField_ext):
        k = int(base.degree())
        c = 450 + 12 * k + 2 * int(base.characteristic()).bit_length() * k // 5
        return c if c > 660 else 660
    if base is _sage_rdf.RDF:
        return 300
    if base is _sage_rdf.CDF:
        return 610
    if isinstance(base, _sage_nf.NumberField_absolute):
        return 470 + 130 * int(base.degree())
    if base is qb.QQbar or base is qb.AA:
        return 1500
    prec = getattr(base, "precision", None)
    if callable(prec):
        # (RealField(p) and ComplexField(p), RR and CC among them)
        bits = int(prec())
        return (590 + bits // 4) if "Complex" in type(base).__name__ else (290 + bits // 5)
    # (another field: the costliest above)
    return 1500


def _common_field(a, b):
    """The field where matrices over a and b meet, as Sage's coercion has
    it: a itself when b is the same field, QQbar for AA with QQbar; None
    otherwise (refused, never computed over one of them)."""
    if a is b or a == b:
        return a
    import _sage_qqbar as qb
    if (a is qb.AA and b is qb.QQbar) or (a is qb.QQbar and b is qb.AA):
        return qb.QQbar
    return None


def _admit_size(base, m, n, factor=1):
    """(m, n) after checking that an m x n matrix over base, times factor
    for an operation's larger working matrix, fits this process's budget
    for one matrix: NotImplementedError, before anything is built, if
    not."""
    from _sage_matrix import _shape
    m, n = _shape(m, n)
    need = m * n * factor * _entry_cost(base)
    limit = _heap_limit()
    if need > limit // _HEAP_SHARE:
        mib = 1 << 20
        raise NotImplementedError("a %d x %d matrix over %r needs about %d MiB%s, more than sagebrush's budget of %d MiB for one matrix (1/%d of this process's %d MiB heap)" % (
            m, n, base, -(-need // mib), " with its working space" if factor > 1 else "", limit // _HEAP_SHARE // mib, _HEAP_SHARE, limit // mib))
    return m, n


def _alg_base(base):
    import _sage_qqbar as qb
    return base is qb.QQbar or base is qb.AA


class _AlgCharge:
    """The running charge of a matrix's entries over QQbar or AA: each
    entry, and each distinct number field once (_sage_qqbar._heap_units),
    against the budget for one matrix.  A charge per entry alone admitted
    100 x 100 entries sqrt(k) + sqrt(3), each in its own degree-4 field,
    which ran a 96 MiB heap out (2290 to 9300 units an entry where 1500
    was charged).  Rows are charged as they are made, so a refusal comes
    within one row of the budget and nothing is kept."""

    def __init__(self, base):
        self.base, self.seen, self.total = base, set(), 0
        self.limit = _heap_limit() // _HEAP_SHARE

    def row(self, r):
        import _sage_qqbar as qb
        for x in r:
            self.total += qb._heap_units(x, self.seen)
        if self.total > self.limit:
            mib = 1 << 20
            raise NotImplementedError("a matrix over %r of these algebraic numbers needs more than sagebrush's budget of %d MiB for one matrix (1/%d of this process's %d MiB heap): each entry, and each of their number fields, counts" % (
                self.base, self.limit // mib, _HEAP_SHARE, _heap_limit() // mib))
        return r


def _admit_vector(base, n, factor=1):
    """n, after checking that a vector of n entries over base (times factor
    for its working space) fits this process's budget for one matrix:
    NotImplementedError, before anything is built, if not."""
    from _sage_matrix import _vector_dim
    n = _vector_dim(n)
    need = n * factor * _entry_cost(base)
    limit = _heap_limit()
    if need > limit // _HEAP_SHARE:
        mib = 1 << 20
        raise NotImplementedError("a vector of %d entries over %r needs about %d MiB%s, more than sagebrush's budget of %d MiB for one matrix or vector (1/%d of this process's %d MiB heap)" % (
            n, base, -(-need // mib), " with its working space" if factor > 1 else "", limit // _HEAP_SHARE // mib, _HEAP_SHARE, limit // mib))
    return n


def _admitted_entries(base, entries):
    """The entries of a vector over base, as a list, read no further than
    the budget allows: a list, tuple, range or vector is admitted by its
    length before it is read; other entries (an iterator) are read with
    the budget as the limit (the entries as read and the vector converted
    from them live together: factor 2), so that an iterator cannot make
    more than the budget first."""
    from _sage_matrix import _bounded_list, _MAX_ENTRIES
    if type(entries) in (list, tuple, range) or isinstance(entries, FFVector):
        if len(entries) <= _MAX_ENTRIES:
            _admit_vector(base, len(entries))
        return _bounded_list(entries)
    cap = _heap_limit() // _HEAP_SHARE // (2 * _entry_cost(base))
    if cap >= _MAX_ENTRIES:
        return _bounded_list(entries)
    try:
        return _bounded_list(entries, cap)
    except ValueError as e:
        if not str(e).startswith("more than %d " % cap):
            raise
    mib, limit = 1 << 20, _heap_limit()
    raise NotImplementedError("a vector over %r of more than %d entries, as they are read, needs more than sagebrush's budget of %d MiB for one matrix or vector (1/%d of this process's %d MiB heap)" % (
        base, cap, limit // _HEAP_SHARE // mib, _HEAP_SHARE, limit // mib))


def _admitted_rows(base, rows, ncols=None, loose=False, structural=True):
    """The rows of a matrix over base, each a list (_read_rows; loose:
    _bounded_rows, whose rows may be vectors or single entries), read no
    further than the budget for one matrix allows.  When the rows are
    lists or tuples their lengths are known without reading anything, so
    Sage's structural error for ragged rows comes before the budget (astra's
    CORR-21A-1); other rows (an iterator, vectors) are counted as they are
    read, so that an iterator cannot make more than the budget first
    (daybreak2's HARD-21A-1).  structural=False: always counted as read,
    with no check of the lengths (a subspace's generators)."""
    from _sage_matrix import _read_rows, _bounded_rows, _MAX_ENTRIES
    reader = _bounded_rows if loose else _read_rows
    if structural and type(rows) in (list, tuple) and len(rows) <= _MAX_ENTRIES and all(type(r) in (list, tuple) for r in rows):
        n = ncols if ncols is not None else (len(rows[0]) if rows else 0)
        for r in rows:
            if len(r) != n:
                raise ValueError("the rows of a matrix must all have %d entries" % n)
        if len(rows) * n <= _MAX_ENTRIES:
            _admit_size(base, len(rows), n)
        return reader(rows)
    # (the rows as read and the matrix converted from them live together:
    # factor 2.  The readers above take up to limit rows before counting
    # their entries, so 83887 rows of 512 floats were read for a budget of
    # 83886 entries and ran V8 out of memory: daybreak2's HARD-5B6-1.  Here
    # each row is counted as it is read, an empty row as one entry.)
    cap = _heap_limit() // _HEAP_SHARE // (2 * _entry_cost(base))
    if cap >= _MAX_ENTRIES:
        return reader(rows)
    from _sage_matrix import _bounded_list
    if isinstance(rows, (str, bytes)):
        raise TypeError("%r is not a list of rows" % (rows,))
    def refuse():
        mib, limit = 1 << 20, _heap_limit()
        return NotImplementedError("a matrix over %r of more than %d entries, as they are read, needs more than sagebrush's budget of %d MiB for one matrix (1/%d of this process's %d MiB heap)" % (
            base, cap, limit // _HEAP_SHARE // mib, _HEAP_SHARE, limit // mib))
    out, used = [], 0
    for r in iter(rows):
        if loose and not (isinstance(r, (list, tuple)) or (hasattr(r, "__iter__") and not isinstance(r, str)) or type(r).__name__ in ("Vector", "FFVector")):
            r = [r]
        elif isinstance(r, str):
            raise TypeError("a row of a matrix must be a list, not a string")
        else:
            try:
                r = _bounded_list(r, cap - used, total=cap)
            except ValueError as e:
                # (the row itself is past the budget: refused at once, the
                # row, a generator perhaps, not touched again: astra's
                # CORR-03D-1)
                if str(e).startswith("more than %d " % cap):
                    raise refuse()
                raise
        used += len(r) or 1
        if used > cap:
            raise refuse()
        out.append(r)
    return out


# ------------------------------------------------------------------ vectors

def _strict_base(B):
    """Whether scalars meet matrices over B by Sage's canonical coercion
    (finite fields, Z/nZ, number fields, QQbar, AA) rather than by
    conversion (RDF, RR, CC, ...)."""
    import _sage_qqbar as qb
    if isinstance(B, (_ff.IntegerModRing_, _ff.FiniteField_ext)) or B is qb.QQbar or B is qb.AA:
        return True
    import _sage_nf
    return isinstance(B, _sage_nf.NumberField_absolute)


def _admit(B, o):
    """o as an element of B when Sage coerces it into B, else None.  Over
    the strict bases (_strict_base) that is an integer, a rational in
    characteristic 0, an element of B, or an AA element for QQbar: a float
    is never admitted (identity_matrix(GF(7), 2) == 1.5 was True and + 1.5
    added 1, the float truncated) nor an element of another field (GF(5)
    in GF(7)), astra's CORR-BD3-1.  Other bases convert as before."""
    # (None first: isinstance(None, Fraction) below raised, so A == None was
    # a TypeError: astra's CORR-8F9-2)
    if o is None or isinstance(o, (list, tuple, str, dict)) or getattr(o, "_is_ffmatrix", False) or isinstance(o, FFVector):
        return None
    if not _strict_base(B):
        try:
            return B(o)
        except (TypeError, ValueError):
            return None
    if isinstance(o, int):
        return B(int(o))
    if isinstance(o, (float, complex)):
        return None
    if isinstance(o, _F) or type(o).__name__ == "Rational":
        return B(o) if B.characteristic() == 0 else None
    par = getattr(o, "parent", None)
    if callable(par):
        try:
            P = par()
        except Exception:
            return None
        import _sage_qqbar as qb
        if P is B or P == B or (B is qb.QQbar and P is qb.AA):
            return B(o)
    return None


def _pushout(B, o):
    """The field where a matrix over QQbar or AA and the scalar o meet when
    o is not admitted into B (as Sage: a float with AA gives RDF and with
    QQbar CDF, RR gives RR or CC, a QQbar element with AA gives QQbar),
    else None."""
    import _sage_qqbar as qb
    if (B is not qb.QQbar and B is not qb.AA) or isinstance(o, int):
        return None
    par = getattr(o, "parent", None)
    P = None
    if callable(par):
        try:
            P = par()
        except Exception:
            return None
    if B is qb.AA and P is qb.QQbar:
        return qb.QQbar
    name = type(o).__name__
    is_c = isinstance(o, complex) or name in ("ComplexDoubleElement", "ComplexNumber", "ComplexNumberMP")
    is_r = not is_c and (isinstance(o, float) or name in ("RealNumberMP", "_RealLiteralMP"))
    if not (is_c or is_r):
        return None
    import _sage_rdf
    F = P if P is not None else (_sage_rdf.CDF if is_c else _sage_rdf.RDF)
    if B is qb.QQbar and is_r:
        F = _sage_rdf.CDF if F is _sage_rdf.RDF else _sa().ComplexField(F.prec())
    return F


# ------------------------------------------------------------------ vector parents

def _num_kind(R):
    """(complex, double, bits) for the numerical fields (RDF, CDF, RR, CC,
    RealField(p) and ComplexField(p) rounding to nearest), else None."""
    import _sage_rdf, _sage_real
    sa = _sa()
    if R is _sage_rdf.RDF or R is _sage_rdf.CDF:
        return (R is _sage_rdf.CDF, True, 53)
    if R is sa.RR or R is sa.CC:
        return (R is sa.CC, False, 53)
    if isinstance(R, _sage_real.RealField_) and R._rnd == "RNDN" and not R._rr_internal:
        return (False, False, R._prec)
    if isinstance(R, _sage_real.ComplexField_):
        return (True, False, R._prec)
    return None


def _ring_class(R):
    """What sagebrush models of R's coercions into other rings: "ZZ", "QQ",
    "mod" (GF(q), Z/nZ), "AA", "QQbar", "num", "nf", "SR", else None."""
    import _sage_qqbar as qb, _sage_nf
    sa = _sa()
    if R is sa.ZZ:
        return "ZZ"
    if R is sa.QQ:
        return "QQ"
    if isinstance(R, (_ff.IntegerModRing_, _ff.FiniteField_ext)):
        return "mod"
    if R is qb.AA:
        return "AA"
    if R is qb.QQbar:
        return "QQbar"
    if _num_kind(R) is not None:
        return "num"
    if isinstance(R, _sage_nf.NumberField_absolute):
        return "nf"
    if R is sa.SR:
        return "SR"
    return None


def _mod_pushout(R, S):
    """The common ring of GF(q) or Z/nZ R and S: Z/mZ and Z/nZ meet in
    Z/gcd(m, n)Z (GF(p) when either is GF(p) of that size), a prime field
    in its extension; None (Sage's TypeError) otherwise."""
    import math
    ext = [isinstance(X, _ff.FiniteField_ext) for X in (R, S)]
    if ext[0] and ext[1]:
        return None  # (two extension fields: GF(4) and GF(16) do not meet in Sage)
    if ext[0] or ext[1]:
        E, Z = (R, S) if ext[0] else (S, R)
        if Z._n == 1:
            raise NotImplementedError("vectors over %r and %r are not available together in sagebrush yet" % (R, S))
        return E if Z._n % E._p == 0 else None
    g = math.gcd(R._n, S._n)
    if g == 1:
        # (Z/1Z meets every Z/nZ, but not GF(p); GF(5) and GF(7) do not meet)
        if R._is_gf or S._is_gf:
            return None
        return R if R._n == 1 else S if S._n == 1 else None
    for X in (R, S):
        if X._n == g and X._is_gf:
            return X
    for X in (R, S):
        if X._n == g:
            return X
    return _ff.IntegerModRing(g)


def _num_pushout(R, S):
    """Where two numerical fields meet, as Sage's coercion finds it: the
    lower precision (of RDF and RR, or CDF and CC, the left one), and
    complex when either is (CDF with a real field of at least 53 bits,
    else ComplexField of the lower precision: RDF and ComplexField(100)
    give CC, CDF and RealField(24) ComplexField(24))."""
    (cr, dr, pr), (cs, ds, ps) = _num_kind(R), _num_kind(S)
    if cr == cs:
        return R if pr <= ps else S
    C = R if cr else S
    if (dr if cr else ds) and min(pr, ps) >= 53:
        return C
    return _sa().ComplexField(min(pr, ps))


def _complexified(R):
    import _sage_rdf
    sa = _sa()
    if R is _sage_rdf.RDF:
        return _sage_rdf.CDF
    if R is sa.RR:
        return sa.CC
    k = _num_kind(R)
    return R if k[0] else sa.ComplexField(k[2])


def _vector_pushout(R, S):
    """The ring in which vectors over R and over S meet (their sum, product
    and cross product lie over it), as Sage's coercion finds it; None when
    Sage has none (TypeError); NotImplementedError for rings whose meeting
    sagebrush does not model (number fields with other fields: their
    embeddings).

    EXAMPLES::

        sage: K = QuadraticField(2)
        sage: (vector(QQ, [1, 2]) + vector(K, [1, 1])).parent()
        Vector space of dimension 2 over Number Field in a with defining polynomial x^2 - 2 with a = 1.414213562373095?
        sage: vector(RDF, [1, 2]) + vector(K, [1, 1])  # sagebrush only (Sage: (2.0, 3.0))
        Traceback (most recent call last):
        ...
        NotImplementedError: vectors over Real Double Field and Number Field in a with defining polynomial x^2 - 2 with a = 1.414213562373095? are not available together in sagebrush yet
    """
    if R is S or R == S:
        return R
    a, b = _ring_class(R), _ring_class(S)
    if a is None or b is None:
        raise NotImplementedError("vectors over %r and %r are not available together in sagebrush yet" % (R, S))
    if a == "ZZ":
        return S
    if b == "ZZ":
        return R
    if "mod" in (a, b):
        return _mod_pushout(R, S) if a == b else None
    if "nf" in (a, b):
        if a == "QQ" or b == "QQ":
            return S if a == "QQ" else R
        # (a number field without an embedding meets nothing else: Sage's
        # TypeError; with one, it meets AA, QQbar, the numerical fields and
        # other number fields by its embedding: not modelled)
        if "SR" not in (a, b) and any(c == "nf" and not getattr(X, "_emb", None) for c, X in ((a, R), (b, S))):
            return None
        raise NotImplementedError("vectors over %r and %r are not available together in sagebrush yet" % (R, S))
    if "SR" in (a, b):
        return _sa().SR
    if a == "QQ":
        return S
    if b == "QQ":
        return R
    import _sage_qqbar as qb
    if a == "num" and b == "num":
        return _num_pushout(R, S)
    if a == "num" or b == "num":
        N, E = (R, S) if a == "num" else (S, R)
        return _complexified(N) if E is qb.QQbar else N
    return qb.QQbar  # (AA and QQbar)


def _vec_base(v):
    """The base ring of a vector (FFVector or a ZZ, QQ or symbolic Vector),
    else None."""
    if isinstance(v, FFVector):
        return v._base
    import _sage_matrix
    if isinstance(v, _sage_matrix.Vector) and not isinstance(v, _sage_matrix.SeriesVector):
        return v.base_ring()
    return None


def _vector_op(u, v, op):
    """u op v for vectors u and v, one of them an FFVector: "+", "-", "*"
    (the dot product), "dot" (dot_product) or "cross" (cross_product), in
    the ring where their base rings meet.  The dimensions and the rings are
    checked before any entry is computed, with Sage's errors: TypeError
    "unsupported operand parent(s)" naming the vector spaces (the base
    rings for dot and cross products), ArithmeticError for dot products of
    different degrees."""
    R, S = _vec_base(u), _vec_base(v)
    n, m = len(u), len(v)
    sym = "*" if op in ("dot", "cross") else op
    if op == "dot" and n != m:
        raise ArithmeticError("degrees (%d and %d) must be the same" % (n, m))
    if op in ("+", "-", "*") and n != m:
        raise TypeError("unsupported operand parent(s) for %s: '%r' and '%r'" % (sym, u.parent(), v.parent()))
    P = _vector_pushout(R, S)
    if P is None:
        if op in ("dot", "cross"):
            raise TypeError("unsupported operand parent(s) for *: '%r' and '%r'" % (R, S))
        raise TypeError("unsupported operand parent(s) for %s: '%r' and '%r'" % (sym, u.parent(), v.parent()))
    if op == "cross" and not (n == m and n in (3, 7)):
        raise TypeError("Cross product only defined for vectors of length three or seven, not (%d and %d)" % (n, m))
    if P is _sa().SR:
        # (a symbolic vector and one over a field of characteristic 0: the
        # entries meet in SR themselves)
        a, b = list(u), list(v)
    else:
        a, b = _in_ring(P, u, R), _in_ring(P, v, S)
    if op == "+":
        r = [x + y for x, y in zip(a, b)]
    elif op == "-":
        r = [x - y for x, y in zip(a, b)]
    elif op == "cross":
        r = _cross(a, b)
    else:
        s = P.zero() if P is not _sa().SR else 0
        for x, y in zip(a, b):
            s = s + x * y
        return _symbolic(s) if P is _sa().SR else s
    if P is _sa().SR:
        import _sage_matrix
        w = _sage_matrix.Vector(r)
        w._ring = P
        return w
    return FFVector(P, r)


def _symbolic(s):
    """s in SR, or NotImplementedError when sagebrush's SR cannot hold it
    as Sage does (an RDF or CDF number: SR(RDF(11)) prints as RR's 11.0000000000000,
    Sage's as 11.0)."""
    import _sage_rdf
    if type(s).__name__ in ("RealDoubleElement", "ComplexDoubleElement") or (callable(getattr(s, "parent", None)) and s.parent() in (_sage_rdf.RDF, _sage_rdf.CDF)):
        raise NotImplementedError("%r as a symbolic expression is not available in sagebrush yet" % (s,))
    try:
        return _sa().SR(s)
    except TypeError:
        raise NotImplementedError("%r as a symbolic expression is not available in sagebrush yet" % (s,))


def _in_ring(P, v, R):
    """The entries of the vector v over R, as elements of P (from Z/mZ to
    Z/nZ or GF(p^k) by their integer representatives: Z/6Z -> GF(3))."""
    if R is P:
        return list(v)
    if isinstance(R, _ff.IntegerModRing_):
        return [P(int(x)) for x in v]
    return [P(x) for x in v]


def _cross(a, b):
    """The cross product of two lists of 3 or of 7 entries (7: e_i x e_(i+1)
    = e_(i+3), indices mod 7, as Sage)."""
    if len(a) == 3:
        return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
    r = [a[0] * 0 for _ in range(7)]
    for i in range(7):
        j, k = (i + 1) % 7, (i + 3) % 7
        # e_i x e_j = e_k, e_j x e_k = e_i, e_k x e_i = e_j
        r[k] = r[k] + a[i] * b[j] - a[j] * b[i]
        r[i] = r[i] + a[j] * b[k] - a[k] * b[j]
        r[j] = r[j] + a[k] * b[i] - a[i] * b[k]
    return r


# ------------------------------------------------------------------ norms

# exact p-norms (over AA and QQbar) for integer p up to this; and over ZZ
# and QQ while the p-th powers have at most _EXACT_NORM_BITS bits
_EXACT_NORM_P = 64
_EXACT_NORM_BITS = 1 << 22


def _inf_sign(p):
    """1 for +Infinity (Sage's, a float or a real), -1 for -Infinity, else 0."""
    if isinstance(p, (int, str, _F)) or type(p).__name__ in ("Integer", "Rational"):
        return 0
    try:
        f = float(p)
    except Exception:
        return 0
    return 1 if f == float("inf") else -1 if f == float("-inf") else 0


def _exact_exponent(p):
    return isinstance(p, (int, _F)) or type(p).__name__ in ("Integer", "Rational")


def _real_exponent(p):
    """Whether p is an element of RR or of RealField(prec) (not a Python
    float, not NaN)."""
    if type(p) is float or isinstance(p, (int, str, _F)):
        return False
    par = getattr(p, "parent", None)
    try:
        k = _num_kind(par()) if callable(par) else None
    except Exception:
        return False
    return k is not None and not k[0] and not k[1] and p == p


def _p_norm(vals, p, root, check=None, R=None):
    """Sage's p-norm of the absolute values vals: the largest for p =
    Infinity (ValueError when there are none), else (p >= 1, else
    ValueError) root(sum of their p-th powers, p); when there are none, 0
    in QQ for an integer or rational p, 0 in p's field for a real p.  An
    exponent in RR or RealField(prec) is admitted only over a real field R
    (the powers in R: Sage keeps the vector's precision); other exponents
    (a Python float, RDF, ...) are refused, empty vectors included.
    check(vals, p) runs first, to refuse powers too large to compute."""
    if _inf_sign(p) > 0:
        return max(vals)
    if p < 1:
        raise ValueError("%s is not greater than or equal to 1" % (p,))
    real = _real_exponent(p)
    if not _exact_exponent(p) and not (real and R is not None):
        raise NotImplementedError("the norm with exponent %r (%s) is not available in sagebrush yet" % (p, type(p).__name__))
    if not vals:
        return p.parent()(0) if real else _sa().QQ(0)
    if check is not None:
        check(vals, p)
    q = R(p) if real else p
    s = vals[0] ** q
    for t in vals[1:]:
        s = s + t ** q
    return root(s, p)


def _double_norm(vals, p):
    """The p-norm of the doubles vals, as RDF and CDF vectors (IEEE double
    arithmetic: no scaling, so squares overflow and underflow): any real p,
    -Infinity the smallest, 0 the number of nonzero values."""
    inf = float("inf")
    nan = any(t != t for t in vals)
    s = _inf_sign(p)
    if s > 0:
        return float("nan") if nan else max(vals, default=0.0)
    if s < 0:
        if not vals:
            raise ValueError("zero-size array to reduction operation minimum which has no identity")
        return float("nan") if nan else min(vals)
    try:
        q = float(p)
    except (TypeError, ValueError):
        raise ValueError("vector norm 'p' must be +/- infinity or a real number, not %s" % (p,))
    if q != q:
        return q  # (a NaN exponent: NaN, empty vectors included)
    if q == 0:
        return float(sum(1 for t in vals if t != 0))
    if q == 2:
        import math
        return math.sqrt(sum(t * t for t in vals))

    def pw(t, e):
        if t == 0:
            return inf if e < 0 else 0.0
        if t == inf:
            return 0.0 if e < 0 else inf
        return t ** e
    return pw(sum(pw(t, q) for t in vals), 1.0 / q)


def _real_field(R):
    """The real field of the absolute values of a numerical field's
    elements (RR for CC, RealField(p) for ComplexField(p))."""
    k = _num_kind(R)
    if not k[0]:
        return R
    return _sa().RealField(k[2])


class FFVector:
    """A vector over a finite field.

    EXAMPLES::

        sage: v = vector(GF(5), [1, 2, 3]); v, 2*v, v*v
        ((1, 2, 3), (2, 4, 1), 4)
    """

    __slots__ = ("_base", "_e")

    def __init__(self, base, entries):
        self._base = base
        # (read within the heap budget, and admitted, before converting:
        # a vector had only the 4M-entry ceiling)
        self._e = [base(x) for x in _admitted_entries(base, entries)]

    def __repr__(self):
        return "(" + ", ".join(repr(x) for x in self._e) + ")"

    def _latex_(self):
        return "\\left(" + ", ".join(repr(x) for x in self._e) + "\\right)"

    def __len__(self):
        return len(self._e)

    def __iter__(self):
        return iter(self._e)

    def __getitem__(self, i):
        if isinstance(i, slice):
            return FFVector(self._base, self._e[i])
        return self._e[i]

    def __setitem__(self, i, v):
        self._e[i] = self._base(v)

    def cross_product(self, other):
        """The cross product of vectors of length 3.

        EXAMPLES::

            sage: vector(GF(7), [1, 2, 3]).cross_product(vector(GF(7), [4, 5, 6]))
            (4, 6, 4)
        """
        if _vec_base(other) is None:
            raise TypeError("right must be a free module element")
        return _vector_op(self, other, "cross")

    def list(self):
        """The entries.

        EXAMPLES::

            sage: vector(GF(5), [1, 7]).list()
            [1, 2]
        """
        return list(self._e)

    def parent(self):
        """The ambient vector space.

        EXAMPLES::

            sage: vector(GF(5), [1, 2, 3]).parent()
            Vector space of dimension 3 over Finite Field of size 5
        """
        return VectorSpace(self._base, len(self._e))

    def base_ring(self):
        """The field.

        EXAMPLES::

            sage: vector(GF(5), [1, 2]).base_ring()
            Finite Field of size 5
        """
        return self._base

    def degree(self):
        """The number of entries.

        EXAMPLES::

            sage: vector(GF(5), [1, 2, 3]).degree()
            3
        """
        return len(self._e)

    def __eq__(self, o):
        if isinstance(o, FFVector):
            return self._e == o._e
        if isinstance(o, (list, tuple)):
            return len(o) == len(self._e) and all(a == b for a, b in zip(self._e, o))
        return NotImplemented

    def __hash__(self):
        return hash(tuple(self._e))

    # (with another vector: in the ring where their base rings meet, the
    # dimensions and rings checked first, _vector_op; a list or tuple is not
    # a vector, as in Sage)
    def __add__(self, o):
        if _vec_base(o) is None:
            return NotImplemented
        return _vector_op(self, o, "+")

    def __radd__(self, o):
        if _vec_base(o) is None:
            return NotImplemented
        return _vector_op(o, self, "+")

    def __neg__(self):
        return FFVector(self._base, [-a for a in self._e])

    def __sub__(self, o):
        if _vec_base(o) is None:
            return NotImplemented
        return _vector_op(self, o, "-")

    def __rsub__(self, o):
        if _vec_base(o) is None:
            return NotImplemented
        return _vector_op(o, self, "-")

    def __mul__(self, o):
        if _vec_base(o) is not None:
            return _vector_op(self, o, "*")
        if isinstance(o, FFMatrix):
            return o._vecmat(self)
        c = _admit(self._base, o)
        if c is None:
            return NotImplemented
        return FFVector(self._base, [a * c for a in self._e])

    def __rmul__(self, o):
        if _vec_base(o) is not None:
            return _vector_op(o, self, "*")
        c = _admit(self._base, o)
        if c is None:
            return NotImplemented
        return FFVector(self._base, [c * a for a in self._e])

    def dot_product(self, o):
        """The dot product, in the ring where the two base rings meet.

        EXAMPLES::

            sage: vector(GF(5), [1, 2]).dot_product(vector(GF(5), [3, 4]))
            1
            sage: vector(GF(7), [1, 2]).dot_product(vector(ZZ, [3, 4])).parent()
            Finite Field of size 7
            sage: vector(GF(7), [1, 2]).dot_product(vector(GF(7), [3]))
            Traceback (most recent call last):
            ...
            ArithmeticError: degrees (2 and 1) must be the same
        """
        if _vec_base(o) is None:
            raise TypeError("Cannot convert %s to sage.modules.free_module_element.FreeModuleElement" % type(o).__name__)
        return _vector_op(self, o, "dot")

    def _dot(self, o):
        # (the dot product with entries o over this field, of this length)
        s = self._base.zero()
        for a, b in zip(self._e, o):
            s = s + a * b
        return s

    def norm(self, p=2):
        """The p-norm: over RDF and CDF in double arithmetic (any real p;
        -Infinity the smallest entry, 0 the number of nonzero entries);
        over RR, CC and the real and complex fields of other precisions in
        the real field of that precision (p >= 1 or Infinity); exactly in AA
        over AA and QQbar (an integer p >= 1, or Infinity).  Finite fields
        and Z/nZ have no absolute value: ArithmeticError.

        EXAMPLES::

            sage: vector(RDF, [3, 4]).norm(), vector(RDF, [3, 4]).norm(Infinity)
            (5.0, 4.0)
            sage: vector(RealField(100), [1, 1]).norm()
            1.4142135623730950488016887242
            sage: vector(RR, [RR('1e200'), RR('1e200')]).norm()
            1.41421356237310e200
            sage: v = vector(QQbar, [I, 1]).norm(); v, v.parent()
            (1.414213562373095?, Algebraic Real Field)
            sage: vector(GF(7), [3, 4]).norm()
            Traceback (most recent call last):
            ...
            ArithmeticError: absolute value not defined on integers modulo n.
        """
        import _sage_rdf, _sage_qqbar as qb
        B = self._base
        if B is _sage_rdf.RDF or B is _sage_rdf.CDF:
            return _sage_rdf.RealDoubleElement(_double_norm([abs(complex(x)) for x in self._e], p))
        if isinstance(B, (_ff.IntegerModRing_, _ff.FiniteField_ext)):
            if self._e and isinstance(B, _ff.FiniteField_ext):
                raise TypeError("bad operand type for abs(): '%s'" % type(self._e[0]).__name__)
            if self._e:
                raise ArithmeticError("absolute value not defined on integers modulo n.")
            return _p_norm([], p, None)
        if B is qb.AA or B is qb.QQbar:
            vals = [qb.AA(abs(x)) for x in self._e]

            def check(vals, q):
                # (exact powers grow with q: an integer q up to _EXACT_NORM_P)
                if not (isinstance(q, int) or type(q).__name__ == "Integer") or q > _EXACT_NORM_P:
                    raise NotImplementedError("the %s-norm of a vector over %r is not available in sagebrush yet" % (q, B))
            return _p_norm(vals, p, lambda s, q: s if q == 1 else s.nth_root(int(q)), check)
        import _sage_nf
        if isinstance(B, _sage_nf.NumberField_absolute):
            # (Sage's checks of p; the norm itself, an element of K, QQ or
            # SR by the embedding, is not modelled)
            if self._e and (_inf_sign(p) > 0 or not p < 1):
                raise NotImplementedError("the norm of a vector over %r is not available in sagebrush yet" % (B,))
            return _p_norm([], p, None)
        if _num_kind(B) is not None:
            R = _real_field(B)
            vals = [R(abs(x)) for x in self._e]

            def root(s, q):
                if q == 1:
                    return s
                if q == 2:
                    return s.sqrt()
                # (1/q as Sage: exact for an integer or rational q, then
                # rounded into R; for a real q, in q's own field)
                e = R(1) / R(q) if isinstance(q, int) or type(q).__name__ == "Integer" else R(1 / q)
                return s ** e
            return _p_norm(vals, p, root, R=R)
        raise NotImplementedError("the norm of a vector over %r is not available in sagebrush yet" % (B,))

    def is_zero(self):
        """Whether all entries are 0.

        EXAMPLES::

            sage: vector(GF(5), [5, 10]).is_zero()
            True
        """
        return not any(self._e)

    def __bool__(self):
        return any(self._e)

    def hamming_weight(self):
        """The number of nonzero entries.

        EXAMPLES::

            sage: vector(GF(2), [1, 0, 1, 1]).hamming_weight()
            3
        """
        return _sa().Integer(sum(1 for a in self._e if a))

    def nonzero_positions(self):
        """The positions of the nonzero entries.

        EXAMPLES::

            sage: vector(GF(2), [1, 0, 1, 1]).nonzero_positions()
            [0, 2, 3]
        """
        return [i for i, a in enumerate(self._e) if a]

    def support(self):
        """The positions of the nonzero entries.

        EXAMPLES::

            sage: vector(GF(2), [1, 0, 1, 1]).support()
            [0, 2, 3]
        """
        return [i for i, a in enumerate(self._e) if a]

    def __copy__(self):
        return FFVector(self._base, self._e)


def _rhs_entries(b, n, what):
    """The entries of a right-hand side that must have n: read boundedly
    (at most n + 1), and the number actually read checked, not only the
    length b declares (a list subclass may iterate more or fewer entries
    than its len), with Sage's ValueError."""
    from _sage_matrix import _bounded_list
    msg = "number of %s of self must equal degree of right-hand side" % what
    if hasattr(b, "__len__") and len(b) != n:
        raise ValueError(msg)
    try:
        b = _bounded_list(b, n + 1)
    except ValueError:
        raise ValueError(msg)
    if len(b) != n:
        raise ValueError(msg)
    return b


# ------------------------------------------------------------------ elimination

def _echelon(rows, base, ncols):
    """(reduced row echelon form, pivot columns, determinant factor) by
    Gauss-Jordan elimination over the field."""
    m = [list(r) for r in rows]
    one = base.one()
    pivots = []
    det = one
    r = 0
    nrows = len(m)
    for c in range(ncols):
        piv = None
        for i in range(r, nrows):
            if m[i][c]:
                piv = i
                break
        if piv is None:
            continue
        if piv != r:
            m[r], m[piv] = m[piv], m[r]
            det = -det
        inv = 1 / m[r][c]
        det = det * m[r][c]
        m[r] = [x * inv for x in m[r]]
        for i in range(nrows):
            if i != r and m[i][c]:
                f = m[i][c]
                m[i] = [x - f * y for x, y in zip(m[i], m[r])]
        pivots.append(c)
        r += 1
        if r == nrows:
            break
    if hasattr(one, "_exactified"):
        # (over QQbar and AA: rational entries exact, as Sage's are after
        # its elimination's zero tests, so that they print as rationals)
        m = [[x._exactified() for x in row] for row in m]
    return m, pivots, det


# ------------------------------------------------------------------ matrices

class FFMatrix:
    """A dense matrix over a finite field.

    EXAMPLES::

        sage: A = matrix(GF(7), [[1, 2], [3, 4]]); A
        [1 2]
        [3 4]
        sage: A^-1, A.det(), A.charpoly(), A.multiplicative_order()
        (
        [5 1]
        [5 3], 5, x^2 + 2*x + 5, 48
        )
    """

    __slots__ = ("_base", "_rows", "_ncols")

    def __init__(self, base, rows, ncols=None):
        # read boundedly, within the heap budget, and check the shape and
        # the heap its entries take before converting anything
        rows = _admitted_rows(base, rows, ncols)
        ncols = ncols if ncols is not None else (len(rows[0]) if rows else 0)
        if any(len(r) != ncols for r in rows):
            raise ValueError("the rows of a matrix must all have %d entries" % ncols)
        _admit_size(base, len(rows), ncols)
        self._base = base
        if _alg_base(base):
            # (charged by what the entries hold, row by row as converted)
            charge = _AlgCharge(base)
            self._rows = [charge.row([base(x) for x in r]) for r in rows]
        else:
            self._rows = [[base(x) for x in r] for r in rows]
        self._ncols = ncols

    # ---- data
    def parent(self):
        """The matrix space.

        EXAMPLES::

            sage: matrix(GF(7), [[1, 2], [3, 4]]).parent()
            Full MatrixSpace of 2 by 2 dense matrices over Finite Field of size 7
        """
        return MatrixSpace(self._base, self.nrows(), self.ncols())

    def base_ring(self):
        """The field.

        EXAMPLES::

            sage: matrix(GF(7), [[1, 2]]).base_ring()
            Finite Field of size 7
        """
        return self._base

    def nrows(self):
        """The number of rows.

        EXAMPLES::

            sage: matrix(GF(7), 2, 3).nrows(), matrix(GF(7), 2, 3).ncols()
            (2, 3)
        """
        return len(self._rows)

    def ncols(self):
        """The number of columns.

        EXAMPLES::

            sage: matrix(GF(7), 2, 3).ncols()
            3
        """
        return self._ncols

    def dimensions(self):
        """(rows, columns).

        EXAMPLES::

            sage: matrix(GF(7), 2, 3).dimensions()
            (2, 3)
        """
        return (self.nrows(), self.ncols())

    def is_square(self):
        """Whether square.

        EXAMPLES::

            sage: matrix(GF(7), 2, 2).is_square()
            True
        """
        return self.nrows() == self.ncols()

    def __repr__(self):
        if not self._rows:
            return "%d x %d dense matrix over %r" % (0, self._ncols, self._base)
        cells = [[repr(x) for x in r] for r in self._rows]
        # (one width for every entry, the widest, as Sage over every field:
        # matrix(GF(101), [[1, 100], [2, 3]]) printed its columns at their
        # own widths, [1 100] for Sage's [  1 100])
        w = max((len(c) for r in cells for c in r), default=0)
        return "\n".join("[" + " ".join(c.rjust(w) for c in r) + "]" for r in cells)

    def _latex_(self):
        import _sage_expr
        return _sage_expr._latex_matrix(self._rows, self._ncols)

    def __getitem__(self, ij):
        if isinstance(ij, tuple):
            i, j = ij
            if isinstance(i, slice) or isinstance(j, slice):
                rows = self._rows[i] if isinstance(i, slice) else [self._rows[i]]
                return FFMatrix(self._base, [r[j] if isinstance(j, slice) else [r[j]] for r in rows])
            return self._rows[i][j]
        if isinstance(ij, slice):
            return FFMatrix(self._base, self._rows[ij], self._ncols)
        return FFVector(self._base, self._rows[ij])

    def __setitem__(self, ij, v):
        i, j = ij
        self._rows[i][j] = self._base(v)

    def rows(self):
        """The rows, as vectors.

        EXAMPLES::

            sage: matrix(GF(7), [[1, 2], [3, 4]]).rows()
            [(1, 2), (3, 4)]
        """
        return [FFVector(self._base, r) for r in self._rows]

    def columns(self):
        """The columns, as vectors.

        EXAMPLES::

            sage: matrix(GF(7), [[1, 2], [3, 4]]).columns()
            [(1, 3), (2, 4)]
        """
        return [FFVector(self._base, [r[j] for r in self._rows]) for j in range(self._ncols)]

    def row(self, i):
        """Row i, a vector.

        EXAMPLES::

            sage: matrix(GF(7), [[1, 2], [3, 4]]).row(1)
            (3, 4)
        """
        return FFVector(self._base, self._rows[i])

    def column(self, j):
        """Column j, a vector.

        EXAMPLES::

            sage: matrix(GF(7), [[1, 2], [3, 4]]).column(1)
            (2, 4)
        """
        return FFVector(self._base, [r[j] for r in self._rows])

    def list(self):
        """The entries, row by row.

        EXAMPLES::

            sage: matrix(GF(7), [[1, 2], [3, 4]]).list()
            [1, 2, 3, 4]
        """
        return [x for r in self._rows for x in r]

    def __eq__(self, o):
        if isinstance(o, FFMatrix):
            return self._rows == o._rows and self._ncols == o._ncols
        import _sage_matrix
        if isinstance(o, _sage_matrix.Matrix) and getattr(self._base, "_is_generic_field", False):
            return o.dimensions() == self.dimensions() and all(a == b for r, t in zip(self._rows, o._rows) for a, b in zip(r, t))
        # a scalar c is c times the identity (any shape for 0), as in Sage;
        # it was NotImplemented, so A * A.inverse() == 1 was False
        c = self._scalar(o)
        if c is None:
            r = self._numeric_eq(o)
            if r is not None:
                return r
        if c is not None:
            zero = self._base.zero()
            if c == zero:
                return all(x == zero for r in self._rows for x in r)
            if len(self._rows) != self._ncols:
                return False
            return all(x == (c if i == j else zero) for i, r in enumerate(self._rows) for j, x in enumerate(r))
        return NotImplemented

    def __ne__(self, o):
        r = self.__eq__(o)
        return r if r is NotImplemented else not r

    def _scalar_identity(self, o, op, left):
        """o as o times the identity, for A + o, A - o and o - A (a square
        A), or None when o is not a scalar; a non-square A is Sage's
        TypeError."""
        if isinstance(o, (list, tuple, str)):
            return None
        c = self._scalar(o)
        if c is None:
            return None
        n = len(self._rows)
        if n != self._ncols and c == self._base.zero():
            # (A + 0 is A for any shape, as in Sage)
            return FFMatrix(self._base, [[c] * self._ncols for _ in self._rows], self._ncols)
        if n != self._ncols:
            op_parent = o.parent() if callable(getattr(o, "parent", None)) else _sa().ZZ
            pair = (op_parent, self.parent()) if left else (self.parent(), op_parent)
            raise TypeError("unsupported operand parent(s) for %s: '%r' and '%r'" % ((op,) + pair))
        zero = self._base.zero()
        return FFMatrix(self._base, [[c if i == j else zero for j in range(n)] for i in range(n)], n)

    def __hash__(self):
        return hash(tuple(tuple(r) for r in self._rows))

    def __copy__(self):
        return FFMatrix(self._base, self._rows, self._ncols)

    def copy(self):
        """A copy (mutable independently).

        EXAMPLES::

            sage: A = matrix(GF(7), [[1, 2]]); B = A.copy(); B[0, 0] = 5; A, B  # sagebrush only
            ([1 2], [5 2])
        """
        return self.__copy__()

    def transpose(self):
        """The transpose.

        EXAMPLES::

            sage: matrix(GF(5), 2, 3, range(6)).transpose()
            [0 3]
            [1 4]
            [2 0]
        """
        return FFMatrix(self._base, [[r[j] for r in self._rows] for j in range(self._ncols)], len(self._rows))

    T = property(transpose)

    # ---- arithmetic
    _is_ffmatrix = True

    def _scalar(self, c):
        return _admit(self._base, c)

    def _numeric_eq(self, o):
        """self == o in the field where they meet when o is not admitted
        (_pushout), else None.  Entry by entry: a converted copy of the
        matrix ran out of heap for zero_matrix(AA, 512) == 1.0 in 96 MB
        (daybreak2's HARD-F4E-1)."""
        F = _pushout(self._base, o)
        if F is None:
            return None
        c, zero = F(o), F.zero()
        if not c == zero and len(self._rows) != self._ncols:
            return False
        for i, r in enumerate(self._rows):
            for j, x in enumerate(r):
                if not F(x) == (c if i == j else zero):
                    return False
        return True

    def _numeric_op(self, o, op, left=False):
        """self op o (o op self when left) in the field where they meet when
        o is not admitted (_pushout), else None: each entry is converted
        into the result as it is built, with no converted copy of the
        matrix (HARD-F4E-1).  For + and -, o is o times the identity (0
        for any shape, as in Sage)."""
        F = _pushout(self._base, o)
        if F is None:
            return None
        c, zero = F(o), F.zero()
        n, m = len(self._rows), self._ncols
        _admit_size(F, n, m)  # (the result is over F, whose entries can cost more)
        if op in "+-":
            if n != m and not c == zero:
                op_parent = o.parent() if callable(getattr(o, "parent", None)) else type(o)
                pair = (op_parent, self.parent()) if left else (self.parent(), op_parent)
                raise TypeError("unsupported operand parent(s) for %s: '%r' and '%r'" % ((op,) + pair))
            if op == "+":
                f = lambda x, d: F(x) + d
            elif left:
                f = lambda x, d: d - F(x)
            else:
                f = lambda x, d: F(x) - d
            return FFMatrix(F, [[f(x, c if i == j else zero) for j, x in enumerate(r)] for i, r in enumerate(self._rows)], m)
        if op == "/":
            c = 1 / c
        return FFMatrix(F, [[F(x) * c for x in r] for r in self._rows], m)

    def _coerced(self, o, op):
        """self and the matrix o over their common field, as Sage's
        coercion has it: the same field, or QQbar for AA with QQbar.  Any
        other pair is Sage's TypeError, before any entry is read: a zero,
        non-overlapping or empty product of matrices over QQ(sqrt2) and
        QQ(sqrt3) was a zero matrix, and AA + QQbar was over AA, the left
        operand's field (astra's CORR-ABC-1/2)."""
        F = _common_field(self._base, o._base)
        if F is None:
            raise TypeError("unsupported operand parent(s) for %s: '%r' and '%r'" % (op, self.parent(), o.parent()))
        return (self if self._base is F else FFMatrix(F, self._rows, self._ncols)), (o if o._base is F else FFMatrix(F, o._rows, o._ncols))

    def _join_field(self, other, what):
        """For augment and stack: nothing when other is over this field;
        Sage's TypeError when the two fields have no common field (astra's
        24 cases after CORR-ABC-1); NotImplementedError for a widening
        sagebrush does not do here (AA with QQbar on the right)."""
        F = _common_field(self._base, other._base)
        if F is None:
            raise TypeError("no common canonical parent for objects with parents: '%r' and '%r'" % (self.parent(), other.parent()))
        if F is not self._base:
            raise NotImplementedError("%s a matrix over %r with one over %r is not available in sagebrush yet" % (what, self._base, other._base))

    def _from_qq(self, o):
        """A QQ matrix o as a matrix over this (QQbar) field."""
        import _sage_matrix
        if isinstance(o, _sage_matrix.Matrix) and getattr(self._base, "_is_generic_field", False):
            return FFMatrix(self._base, o._rows, o.ncols())
        return o

    def __add__(self, o):
        o = self._from_qq(o)
        if not isinstance(o, FFMatrix):
            q = self._scalar_identity(o, "+", False)
            if q is None:
                p = self._numeric_op(o, "+")
                return NotImplemented if p is None else p
            o = q
        A, o = self._coerced(o, "+")
        if o.dimensions() != A.dimensions():
            return NotImplemented
        return FFMatrix(A._base, [[a + b for a, b in zip(r, s)] for r, s in zip(A._rows, o._rows)], A._ncols)

    def __radd__(self, o):
        if not isinstance(o, FFMatrix) and self._from_qq(o) is o:
            q = self._scalar_identity(o, "+", True)
            if q is None:
                p = self._numeric_op(o, "+", True)
                return NotImplemented if p is None else p
            o = q
        return self.__add__(o)

    def __neg__(self):
        return FFMatrix(self._base, [[-a for a in r] for r in self._rows], self._ncols)

    def __sub__(self, o):
        o = self._from_qq(o)
        if not isinstance(o, FFMatrix):
            q = self._scalar_identity(o, "-", False)
            if q is None:
                p = self._numeric_op(o, "-")
                return NotImplemented if p is None else p
            o = q
        A, o = self._coerced(o, "-")
        if o.dimensions() != A.dimensions():
            return NotImplemented
        return A + (-o)

    def __rsub__(self, o):
        # o - A for a scalar o (a QQ matrix o goes through _from_qq)
        q = self._from_qq(o)
        if isinstance(q, FFMatrix):
            return q + (-self)
        q = self._scalar_identity(o, "-", True)
        if q is None:
            p = self._numeric_op(o, "-", True)
            return NotImplemented if p is None else p
        return q + (-self)

    def __mul__(self, o):
        o = self._from_qq(o)
        if isinstance(o, FFMatrix):
            if self._ncols != o.nrows():
                raise TypeError("unsupported operand parent(s) for *: '%r' and '%r'" % (self.parent(), o.parent()))
            # (the common field first: the entry loop below skips zeros, so
            # it cannot be what refuses incompatible fields)
            A, o = self._coerced(o, "*")
            _admit_size(A._base, A.nrows(), o.ncols())  # (the product's size before it is built)
            cols = o.columns()
            z = A._base.zero()
            out = []
            for r in A._rows:
                row = []
                for c in cols:
                    s = z
                    for a, b in zip(r, c._e):
                        if a and b:
                            s = s + a * b
                    row.append(s)
                out.append(row)
            return FFMatrix(A._base, out, o.ncols())
        if _vec_base(o) is not None:
            # (an FFVector, or a plain ZZ/QQ vector: one was multiplied as a
            # scalar, entry by entry, into a vector of matrices)
            A, o = self._vector_operand(o, False)
            return FFVector(A._base, [FFVector(A._base, r)._dot(o._e) for r in A._rows])
        c = self._scalar(o)
        if c is None:
            p = self._numeric_op(o, "*")
            return NotImplemented if p is None else p
        return FFMatrix(self._base, [[a * c for a in r] for r in self._rows], self._ncols)

    def __rmul__(self, o):
        c = self._scalar(o)
        if c is None:
            p = self._numeric_op(o, "*")
            return NotImplemented if p is None else p
        return FFMatrix(self._base, [[c * a for a in r] for r in self._rows], self._ncols)

    def _vector_operand(self, v, left):
        """(the matrix, the vector v) over their common field, as Sage
        multiplies them (v * self when left, else self * v): TypeError
        (unsupported operand parents) when v's entries are not as many as
        the matrix's rows (or columns) or the two fields do not meet."""
        n = len(self._rows) if left else self._ncols
        B = _vec_base(v)
        P = _vector_pushout(self._base, B) if len(v) == n else None
        if P is None:
            raise TypeError("unsupported operand parent(s) for *: '%r' and '%r'" % ((v.parent(), self.parent()) if left else (self.parent(), v.parent())))
        A = self
        if P is not self._base:
            # (a matrix over AA meets a vector over QQbar in QQbar, as two
            # matrices do: _common_field; other larger rings are not modelled)
            if _common_field(self._base, B) is not P:
                raise NotImplementedError("a matrix over %r and a vector over %r are not available together in sagebrush yet" % (self._base, B))
            A = FFMatrix(P, self._rows, self._ncols)
        return A, (v if isinstance(v, FFVector) and B is P else FFVector(P, _in_ring(P, v, B)))

    def _vecmat(self, v):
        A, v = self._vector_operand(v, True)
        return FFVector(A._base, [v._dot(c) for c in A.columns()])

    def __pow__(self, e):
        e = int(e)
        if not self.is_square():
            raise ArithmeticError("self must be a square matrix")
        if e < 0:
            return self.inverse() ** (-e)
        r = identity_matrix(self._base, self.nrows())
        b = self
        while e:
            if e & 1:
                r = r * b
            b = b * b
            e >>= 1
        return r

    def __invert__(self):
        return self.inverse()

    # ---- linear algebra
    def echelon_form(self):
        """The reduced row echelon form.

        EXAMPLES::

            sage: matrix(GF(2), [[1, 1, 0], [0, 1, 1], [1, 0, 1]]).echelon_form()
            [1 0 1]
            [0 1 1]
            [0 0 0]
        """
        m, piv, d = _echelon(self._rows, self._base, self._ncols)
        return FFMatrix(self._base, m, self._ncols)

    rref = echelon_form

    def pivots(self):
        """The pivot columns.

        EXAMPLES::

            sage: matrix(GF(2), [[1, 1, 0], [0, 1, 1], [1, 0, 1]]).pivots()
            (0, 1)
        """
        return tuple(_echelon(self._rows, self._base, self._ncols)[1])

    def rank(self):
        """The rank.

        EXAMPLES::

            sage: matrix(GF(7), [[1, 2, 3], [2, 4, 6]]).rank()
            1
        """
        if _double_field(self._base):
            import _sage_rdf
            return _sage_rdf._rank(self)
        return _sa().Integer(len(_echelon(self._rows, self._base, self._ncols)[1]))

    def __getattr__(self, name):
        # numerical matrices (RDF, CDF, RR, CC): eigenvalues, SVD, ... by numpy
        base = object.__getattribute__(self, "_base")
        if getattr(base, "_numeric", False):
            import _sage_rdf
            f = _sage_rdf.NUMERIC.get(name)
            if f is not None and not _double_field(base):
                if name == "is_symmetric":
                    # (exactly, in the field: numpy compared doubles)
                    return lambda tol=0: self.is_square() and all(
                        (self._rows[i][j] == self._rows[j][i]) if not tol else abs(self._rows[i][j] - self._rows[j][i]) <= tol
                        for i in range(self.nrows()) for j in range(i))
                def refuse(*a, **k):
                    raise NotImplementedError("%s of a matrix over %r is not available in sagebrush yet (numpy works in 53 bits)" % (name, base))
                return refuse
            if f is not None:
                return lambda *a, **k: f(self, *a, **k)
        raise AttributeError("'%s' object has no attribute '%s'" % (type(self).__name__, name))

    def diagonal(self):
        """The diagonal entries.

        EXAMPLES::

            sage: matrix(GF(7), [[1, 2], [3, 4]]).diagonal()
            [1, 4]
        """
        return [self._rows[i][i] for i in range(min(len(self._rows), self._ncols))]

    def det(self):
        """The determinant.

        EXAMPLES::

            sage: matrix(GF(7), [[1, 2], [3, 4]]).det()
            5
        """
        if _double_field(self._base):
            import _sage_rdf
            return _sage_rdf._det(self)
        if not self.is_square():
            raise ValueError("self must be a square matrix")
        m, piv, d = _echelon(self._rows, self._base, self._ncols)
        return d if len(piv) == self.nrows() else self._base.zero()

    determinant = det

    def is_invertible(self):
        """Whether invertible.

        EXAMPLES::

            sage: matrix(GF(7), [[1, 2], [3, 4]]).is_invertible(), matrix(GF(7), [[1, 2], [2, 4]]).is_invertible()
            (True, False)
        """
        return self.is_square() and bool(self.det())

    is_unit = is_invertible

    def inverse(self):
        """The inverse (ZeroDivisionError if singular).

        EXAMPLES::

            sage: ~matrix(GF(7), [[1, 2], [3, 4]])
            [5 1]
            [5 3]
        """
        n = self.nrows()
        if not self.is_square():
            raise ArithmeticError("self must be a square matrix")
        if _double_field(self._base):
            import _sage_rdf
            return _sage_rdf._inverse(self)
        _admit_size(self._base, n, n, 3)  # ([self | I] and its echelon form, n x 2n)
        one, zero = self._base.one(), self._base.zero()
        aug = [r + [one if i == j else zero for j in range(n)] for i, r in enumerate(self._rows)]
        m, piv, d = _echelon(aug, self._base, 2 * n)
        if piv[:n] != list(range(n)) if len(piv) >= n else True:
            raise ZeroDivisionError("input matrix must be nonsingular")
        return FFMatrix(self._base, [r[n:] for r in m], n)

    def _kernel_basis(self):
        """A basis of {x : self x = 0} (echelonized), as lists."""
        m, piv, d = _echelon(self._rows, self._base, self._ncols)
        free = [j for j in range(self._ncols) if j not in piv]
        # (a kernel basis can be bigger than the matrix: 1 x n has n - 1
        # vectors of n entries)
        _admit_size(self._base, len(free), self._ncols)
        one, zero = self._base.one(), self._base.zero()
        basis = []
        for f in free:
            v = [zero] * self._ncols
            v[f] = one
            for i, p in enumerate(piv):
                v[p] = -m[i][f]
            basis.append(v)
        if not basis:
            return []
        em, _, _ = _echelon(basis, self._base, self._ncols)
        return [r for r in em if any(r)]

    def right_kernel(self):
        """{x : self x = 0}, an echelonized subspace.

        EXAMPLES::

            sage: matrix(GF(7), [[1, 2, 3], [2, 4, 6]]).right_kernel()
            Vector space of degree 3 and dimension 2 over Finite Field of size 7
            Basis matrix:
            [1 0 2]
            [0 1 4]
        """
        return FFSubspace(self._base, self._ncols, self._kernel_basis())

    def right_kernel_matrix(self, basis="echelon"):
        """A matrix whose rows are an (echelon) basis of the right kernel.

        EXAMPLES::

            sage: matrix(GF(7), [[1, 2, 3], [2, 4, 6]]).right_kernel_matrix()
            [1 0 2]
            [0 1 4]
        """
        B = self._kernel_basis()
        return FFMatrix(self._base, B, self._ncols)

    def left_kernel(self):
        """{x : x self = 0} (Sage's kernel()).

        EXAMPLES::

            sage: matrix(GF(7), [[1, 2, 3], [2, 4, 6]]).left_kernel()
            Vector space of degree 2 and dimension 1 over Finite Field of size 7
            Basis matrix:
            [1 3]
        """
        return self.transpose().right_kernel()

    kernel = left_kernel

    def image(self):
        """The row space.

        EXAMPLES::

            sage: matrix(GF(2), [[1, 1, 0], [0, 1, 1], [1, 0, 1]]).row_space().dimension()
            2
        """
        return FFSubspace(self._base, self._ncols, self._rows)

    row_space = image

    def column_space(self):
        """The column space.

        EXAMPLES::

            sage: matrix(GF(2), [[1, 1], [0, 0]]).column_space()
            Vector space of degree 2 and dimension 1 over Finite Field of size 2
            Basis matrix:
            [1 0]
        """
        return self.transpose().row_space()

    def solve_right(self, b):
        """x with self x = b (a vector, or a matrix of right-hand sides).

        EXAMPLES::

            sage: A = matrix(GF(7), [[1, 2, 3], [2, 4, 6]]); A.solve_right(vector(GF(7), [1, 2]))
            (1, 0, 0)
        """
        # (the right-hand side's size first, as Sage: zip dropped equations,
        # so a short b was solved as if the missing entries did not exist)
        if isinstance(b, FFMatrix):
            if b.nrows() != self.nrows():
                raise ValueError("number of rows of self must equal number of rows of right-hand side")
        else:
            b = _rhs_entries(b, self.nrows(), "rows")
        if _double_field(self._base) and self.is_square():
            import _sage_rdf
            return _sage_rdf._solve_right(self, b)
        if isinstance(b, FFMatrix):
            _admit_size(self._base, self._ncols, b.ncols())
            cols = [self.solve_right(c) for c in b.columns()]
            return FFMatrix(self._base, [[c[i] for c in cols] for i in range(self._ncols)], len(cols))
        b = [self._base(x) for x in b]
        aug = [r + [bi] for r, bi in zip(self._rows, b)]
        m, piv, d = _echelon(aug, self._base, self._ncols + 1)
        if self._ncols in piv:
            raise ValueError("matrix equation has no solutions")
        x = [self._base.zero()] * self._ncols
        for i, p in enumerate(piv):
            x[p] = m[i][self._ncols]
        return FFVector(self._base, x)

    def solve_left(self, b):
        """x with x self = b.

        EXAMPLES::

            sage: A = matrix(GF(7), [[1, 2], [3, 4]]); A.solve_left(vector(GF(7), [1, 0])) * A
            (1, 0)
        """
        if isinstance(b, FFMatrix):
            if b.ncols() != self.ncols():
                raise ValueError("number of columns of self must equal number of columns of right-hand side")
            return self.transpose().solve_right(b.transpose()).transpose()
        return self.transpose().solve_right(_rhs_entries(b, self.ncols(), "columns"))

    def __truediv__(self, o):
        c = self._scalar(o)
        if c is None:
            p = self._numeric_op(o, "/")
            return NotImplemented if p is None else p
        return self * (1 / c)

    def charpoly(self, var="x"):
        """The characteristic polynomial (Hessenberg reduction).

        EXAMPLES::

            sage: matrix(GF(7), [[1, 2], [3, 4]]).charpoly()
            x^2 + 2*x + 5
        """
        if not self.is_square():
            raise ArithmeticError("charpoly of non-square matrix not defined")
        n = self.nrows()
        R = _ff.PolynomialRing_ff(self._base, var)
        p = _engine_prime(self._base)
        if p and n:
            # in Rust (engine/arith nmod_mat: Krylov or Hessenberg)
            from sagebrush._engine import call
            rows = ";".join(",".join(str(int(x)) for x in r) for r in self._rows)
            c = call("nmod_charpoly", m=rows, p=str(p), wire="csv").split(",")
            return R([self._base(int(t)) for t in c])
        h = _hessenberg([list(r) for r in self._rows], self._base)
        # p_k(x) = (x - h_kk) p_{k-1} - sum_i h_ik (prod h_{j+1,j}) p_{i-1}
        x = R.gen()
        p = [R(1)]
        for k in range(n):
            t = (x - h[k][k]) * p[k]
            prod = self._base.one()
            for i in range(k - 1, -1, -1):
                prod = prod * h[i + 1][i]
                t = t - h[i][k] * prod * p[i]
            p.append(t)
        return p[n]

    characteristic_polynomial = charpoly

    def minpoly(self, var="x"):
        """The minimal polynomial (the least degree monic poly killing self).

        EXAMPLES::

            sage: matrix(GF(7), [[2, 0], [0, 2]]).minpoly()
            x + 5
        """
        n = self.nrows()
        R = _ff.PolynomialRing_ff(self._base, var)
        powers = [identity_matrix(self._base, n)]
        for d in range(1, n + 1):
            powers.append(powers[-1] * self)
            vecs = [P.list() for P in powers]
            k = FFMatrix(self._base, vecs).left_kernel()
            if k.dimension() > 0:
                c = k._basis[-1]
                f = R(list(c))
                return f.monic()
        return self.charpoly(var)

    def trace(self):
        """The trace.

        EXAMPLES::

            sage: matrix(GF(7), [[1, 2], [3, 4]]).trace()
            5
        """
        if self.nrows() != self._ncols:
            # (as Sage: no trace for a nonsquare matrix)
            raise ValueError("self must be a square matrix")
        s = self._base.zero()
        for i in range(self._ncols):
            s = s + self._rows[i][i]
        return s

    def multiplicative_order(self):
        """The order of an invertible matrix (by the orders of the factors of
        its minimal polynomial).

        EXAMPLES::

            sage: matrix(GF(7), [[1, 2], [3, 4]]).multiplicative_order()
            48
        """
        if not self.is_invertible():
            raise ArithmeticError("self must be invertible")
        n = self.nrows()
        q = int(self._base.order())
        # the order divides  lcm over factors f^e of the minpoly of
        # (q^deg f - 1) p^ceil(log_p e); test the divisors of that bound
        f = self.minpoly()
        p = int(self._base.characteristic())
        bound = 1
        from math import gcd
        for g, e in f.factor():
            t = q ** g.degree() - 1
            pe = 1
            while pe < e:
                pe *= p
            v = t * pe
            bound = bound * v // gcd(bound, v)
        o = bound
        one = identity_matrix(self._base, n)
        for r, e in _ff._factor_int(bound):
            for _ in range(e):
                if self ** (o // r) == one:
                    o //= r
                else:
                    break
        return _sa().Integer(o)

    def is_zero(self):
        """Whether 0.

        EXAMPLES::

            sage: matrix(GF(7), 2, 2).is_zero()
            True
        """
        return not any(any(r) for r in self._rows)

    def augment(self, other):
        """[self | other].

        EXAMPLES::

            sage: matrix(GF(2), [[1, 0]]).augment(matrix(GF(2), [[1]]))
            [1 0 1]
        """
        if isinstance(other, FFVector):
            other = FFMatrix(self._base, [[x] for x in other])
        if other.nrows() != self.nrows():
            raise TypeError("number of rows must be the same, %d != %d" % (self.nrows(), other.nrows()))
        if isinstance(other, FFMatrix):
            self._join_field(other, "augmenting")
        _admit_size(self._base, self.nrows(), self._ncols + other.ncols())
        return FFMatrix(self._base, [r + s for r, s in zip(self._rows, other._rows)], self._ncols + other.ncols())

    def stack(self, other):
        """self on top of other.

        EXAMPLES::

            sage: matrix(GF(2), [[1, 0]]).stack(matrix(GF(2), [[0, 1]]))
            [1 0]
            [0 1]
        """
        if isinstance(other, FFVector):
            other = FFMatrix(self._base, [other._e])
        if other.ncols() != self._ncols:
            raise TypeError("number of columns must be the same, %d != %d" % (self._ncols, other.ncols()))
        if isinstance(other, FFMatrix):
            self._join_field(other, "stacking")
        _admit_size(self._base, self.nrows() + other.nrows(), self._ncols)
        return FFMatrix(self._base, self._rows + other._rows, self._ncols)

    def change_ring(self, R):
        """The matrix over R.

        EXAMPLES::

            sage: matrix(GF(7), [[1, 6]]).change_ring(ZZ)
            [1 6]
        """
        if _is_ff(R):
            _admit_size(R, len(self._rows), self._ncols)  # (before converting into R)
        return _sa().matrix(R, [[R(x.lift()) if hasattr(x, "lift") and R in (_sa().ZZ, _sa().QQ) else R(x) for x in r] for r in self._rows])

    def lift(self):
        """The matrix over ZZ of the representatives in [0, p).

        EXAMPLES::

            sage: matrix(GF(7), [[1, 6]]).lift().base_ring()
            Integer Ring
        """
        return _sa().matrix(_sa().ZZ, [[int(x) for x in r] for r in self._rows])


def _engine_prime(base):
    """p when base is the prime field GF(p) with p < 2^63 (the engine's
    word-size arithmetic), else None."""
    is_prime_field = getattr(base, "is_prime_field", None)
    if is_prime_field is None or not is_prime_field():
        return None
    p = int(base.characteristic())
    return p if p < 1 << 63 else None


def _hessenberg(a, base):
    n = len(a)
    for k in range(1, n - 1):
        piv = None
        for i in range(k, n):
            if a[i][k - 1]:
                piv = i
                break
        if piv is None:
            continue
        if piv != k:
            a[k], a[piv] = a[piv], a[k]
            for r in a:
                r[k], r[piv] = r[piv], r[k]
        inv = 1 / a[k][k - 1]
        for i in range(k + 1, n):
            u = a[i][k - 1] * inv
            if u:
                a[i] = [x - u * y for x, y in zip(a[i], a[k])]
                for r in a:
                    r[k] = r[k] + u * r[i]
    return a


# ------------------------------------------------------------------ spaces

class FFMatrixSpace:
    """The m x n matrices over a finite field.

    EXAMPLES::

        sage: M = MatrixSpace(GF(7), 2); M
        Full MatrixSpace of 2 by 2 dense matrices over Finite Field of size 7
        sage: M([1, 2, 3, 4])
        [1 2]
        [3 4]
    """

    def __init__(self, base, nrows, ncols):
        self._base, self._nrows, self._ncols = base, nrows, ncols

    def __repr__(self):
        return "Full MatrixSpace of %d by %d dense matrices over %r" % (self._nrows, self._ncols, self._base)

    def __call__(self, entries=0):
        """A matrix from entries (row by row), rows, or a scalar.

        EXAMPLES::

            sage: MatrixSpace(GF(2), 2, 3)([1, 0, 1, 1, 1, 0])
            [1 0 1]
            [1 1 0]
        """
        return matrix(self._base, self._nrows, self._ncols, entries)

    def base_ring(self):
        """The field.

        EXAMPLES::

            sage: MatrixSpace(GF(2), 2).base_ring()
            Finite Field of size 2
        """
        return self._base

    def dims(self):
        """(rows, columns).

        EXAMPLES::

            sage: MatrixSpace(GF(2), 2, 3).dims()
            (2, 3)
        """
        return (self._nrows, self._ncols)

    def nrows(self):
        """The number of rows.

        EXAMPLES::

            sage: MatrixSpace(GF(2), 2, 3).nrows()
            2
        """
        return self._nrows

    def ncols(self):
        """The number of columns.

        EXAMPLES::

            sage: MatrixSpace(GF(2), 2, 3).ncols()
            3
        """
        return self._ncols

    def identity_matrix(self):
        """The identity.

        EXAMPLES::

            sage: MatrixSpace(GF(3), 2).identity_matrix()
            [1 0]
            [0 1]
        """
        return identity_matrix(self._base, self._nrows)

    one = identity_matrix

    def zero(self):
        """The zero matrix.

        EXAMPLES::

            sage: MatrixSpace(GF(3), 1, 2).zero()
            [0 0]
        """
        return matrix(self._base, self._nrows, self._ncols, 0)

    def random_element(self, *args, **kwds):
        """A random matrix.

        EXAMPLES::

            sage: MatrixSpace(GF(2), 3, 4).random_element().parent()
            Full MatrixSpace of 3 by 4 dense matrices over Finite Field of size 2
        """
        _admit_size(self._base, self._nrows, self._ncols)
        return FFMatrix(self._base, [[self._base.random_element() for _ in range(self._ncols)] for _ in range(self._nrows)], self._ncols)

    def cardinality(self):
        """q^(m n).

        EXAMPLES::

            sage: MatrixSpace(GF(2), 2).cardinality()
            16
        """
        return _sa().Integer(int(self._base.order()) ** (self._nrows * self._ncols))

    def __eq__(self, o):
        return isinstance(o, FFMatrixSpace) and (o._base, o._nrows, o._ncols) == (self._base, self._nrows, self._ncols)

    def __hash__(self):
        return hash((repr(self._base), self._nrows, self._ncols))


def MatrixSpace(base, nrows, ncols=None, sparse=False):
    """The matrix space over a finite field (dense; sparse=True is accepted).

    EXAMPLES::

        sage: MatrixSpace(GF(2), 20, 40, sparse=True).random_element().rank() <= 20
        True
    """
    from _sage_matrix import _shape
    m, n = _shape(nrows, nrows if ncols is None else ncols)
    return FFMatrixSpace(base, m, n)


def matrix(base, *args, **kwds):
    """matrix(GF(q), rows), matrix(GF(q), m, n, entries or scalar).

    EXAMPLES::

        sage: matrix(GF(5), 2, 3, range(6))
        [0 1 2]
        [3 4 0]
    """
    from _sage_matrix import _bounded_list, _bounded_rows, _shape, _dim
    if not args:
        return FFMatrix(base, [], 0)
    if len(args) == 1:
        rows = args[0]
        if isinstance(rows, FFMatrix):
            return FFMatrix(base, rows._rows, rows.ncols())
        rows = _admitted_rows(base, rows, loose=True)
        return FFMatrix(base, rows, len(rows[0]) if rows else 0)
    if len(args) == 2 and isinstance(args[1], (list, tuple)) and args[1] and isinstance(args[1][0], (list, tuple)):
        m = _dim(args[0])
        if type(args[1]) in (list, tuple) and len(args[1]) != m:
            raise ValueError("entries do not fill a matrix with %d rows" % m)
        rows = _admitted_rows(base, args[1], loose=True)
        if len(rows) != m:
            raise ValueError("entries do not fill a matrix with %d rows" % m)
        return FFMatrix(base, rows, len(rows[0]))
    m = _dim(args[0])
    n = _dim(args[1], "columns") if len(args) > 1 and not isinstance(args[1], (list, tuple, range)) else m
    m, n = _shape(m, n)
    entries = args[2] if len(args) > 2 else (args[1] if len(args) == 2 and isinstance(args[1], (list, tuple, range)) else 0)
    if type(entries) in (list, tuple, range):
        # (the length is known without reading: Sage's errors for a wrong
        # count or ragged rows come before the heap budget, astra's
        # CORR-21A-1)
        if type(entries) is not range and entries and isinstance(entries[0], (list, tuple)):
            # (as many rows as declared, each of n entries: matrix(GF(7), 1,
            # 1, [[1], [2]]) was a 2 x 1 matrix, astra's CORR-5B6-1, and
            # too few rows were accepted before)
            if len(entries) != m:
                raise ValueError("entries do not fill a matrix with %d rows" % m)
            return FFMatrix(base, _admitted_rows(base, entries, n, loose=True), n)
        if len(entries) != m * n:
            raise ValueError("entries has the wrong length")
    if callable(entries) and not hasattr(entries, "__iter__") and not hasattr(entries, "__len__") and not hasattr(entries, "__getitem__"):
        # matrix(F, m, n, f): the entries f(i, j), as Sage, after the shape
        # is checked; each value converted as it is returned, and over QQbar
        # and AA each row charged as it is made (was a TypeError: "Illegal
        # initializer for algebraic number")
        _admit_size(base, m, n)
        charge = _AlgCharge(base) if _alg_base(base) else None
        rows = []
        for i in range(m):
            r = [base(entries(i, j)) for j in range(n)]
            rows.append(charge.row(r) if charge is not None else r)
        return FFMatrix(base, rows, n)
    if isinstance(entries, (list, tuple, range)):
        _admit_size(base, m, n)
        e = _bounded_list(entries, max(m * n, m))
        if e and isinstance(e[0], (list, tuple)):
            if len(e) != m:
                raise ValueError("entries do not fill a matrix with %d rows" % m)
            return FFMatrix(base, _bounded_rows(e, max(m * n, m)), n)
        if len(e) != m * n:
            raise ValueError("entries has the wrong length")
        return FFMatrix(base, [e[i * n:(i + 1) * n] for i in range(m)], n)
    c = base(entries)
    zero = base.zero()
    if c != zero and m != n:
        # (matrix(GF(5), 2, 3, 1) was a 2 x 3 "diagonal" matrix)
        raise TypeError("nonzero scalar matrix must be square")
    _admit_size(base, m, n)
    return FFMatrix(base, [[c if i == j else zero for j in range(n)] for i in range(m)], n)


def identity_matrix(base, n):
    """The n x n identity over base.

    EXAMPLES::

        sage: identity_matrix(GF(3), 2)
        [1 0]
        [0 1]
    """
    return matrix(base, n, n, 1)


def random_matrix(base, nrows, ncols=None, **kwds):
    """A random matrix over a finite field.

    EXAMPLES::

        sage: random_matrix(GF(2), 3, 4).parent()
        Full MatrixSpace of 3 by 4 dense matrices over Finite Field of size 2
    """
    return MatrixSpace(base, nrows, ncols).random_element()


_SPACES = {}


class FFVectorSpace:
    """The vector space F^n.

    EXAMPLES::

        sage: V = VectorSpace(GF(2), 8); V
        Vector space of dimension 8 over Finite Field of size 2
        sage: V([1, 1, 0, 0, 0, 0, 0, 0])
        (1, 1, 0, 0, 0, 0, 0, 0)
    """

    def __init__(self, base, n):
        self._base, self._n = base, n

    def __repr__(self):
        if not _field(self._base):
            return "Ambient free module of rank %d over %r" % (self._n, self._base)
        return "Vector space of dimension %d over %r" % (self._n, self._base)

    def __call__(self, x=0):
        """A vector from entries.

        EXAMPLES::

            sage: VectorSpace(GF(3), 2)([4, 5])
            (1, 2)
        """
        if x == 0 and not isinstance(x, (list, tuple, FFVector)):
            _admit_vector(self._base, self._n)
            return FFVector(self._base, [0] * self._n)
        from _sage_matrix import _bounded_list
        if hasattr(x, "__len__") and not isinstance(x, (str, bytes)):
            # (the length of anything sized is known without reading it:
            # Sage's error for a wrong one first, for a vector over QQ, a
            # range or a list subclass too, astra's CORR-4E2-1)
            if len(x) != self._n:
                raise TypeError("entries must be a list of length %d" % self._n)
            _admit_vector(self._base, self._n)
        else:
            _admit_vector(self._base, self._n, 2)
        v = FFVector(self._base, _bounded_list(x, self._n))
        if len(v) != self._n:
            raise TypeError("entries must be a list of length %d" % self._n)
        return v

    def dimension(self):
        """n.

        EXAMPLES::

            sage: VectorSpace(GF(3), 4).dimension()
            4
        """
        return _sa().Integer(self._n)

    dim = dimension

    def degree(self):
        """n.

        EXAMPLES::

            sage: VectorSpace(GF(3), 4).degree()
            4
        """
        return _sa().Integer(self._n)

    def base_ring(self):
        """The field.

        EXAMPLES::

            sage: VectorSpace(GF(3), 4).base_ring()
            Finite Field of size 3
        """
        return self._base

    base_field = base_ring

    def basis(self):
        """The standard basis.

        EXAMPLES::

            sage: VectorSpace(GF(3), 2).basis()
            [(1, 0), (0, 1)]
            sage: print(VectorSpace(GF(3), 2).basis())
            [
            (1, 0),
            (0, 1)
            ]
        """
        _admit_size(self._base, self._n, self._n)  # (VectorSpace(GF(2), 5000).basis(): 2.5 10^7 entries)
        one, zero = self._base.one(), self._base.zero()
        return _Basis([FFVector(self._base, [one if i == j else zero for j in range(self._n)]) for i in range(self._n)])

    def zero(self):
        """The zero vector.

        EXAMPLES::

            sage: VectorSpace(GF(3), 2).zero()
            (0, 0)
        """
        _admit_vector(self._base, self._n)
        return FFVector(self._base, [0] * self._n)

    def subspace(self, gens):
        """The subspace spanned by gens (echelonized basis).

        EXAMPLES::

            sage: V = VectorSpace(GF(2), 8)
            sage: S = V.subspace([V([1,1,0,0,0,0,0,0]), V([1,0,0,0,0,1,1,0])]); S
            Vector space of degree 8 and dimension 2 over Finite Field of size 2
            Basis matrix:
            [1 0 0 0 0 1 1 0]
            [0 1 0 0 0 1 1 0]
        """
        return FFSubspace(self._base, self._n, _admitted_rows(self._base, gens, loose=True, structural=False))

    span = subspace

    def random_element(self):
        """A random vector.

        EXAMPLES::

            sage: VectorSpace(GF(5), 3).random_element() in VectorSpace(GF(5), 3)
            True
        """
        _admit_vector(self._base, self._n)
        return FFVector(self._base, [self._base.random_element() for _ in range(self._n)])

    def __contains__(self, v):
        return isinstance(v, FFVector) and len(v) == self._n and v._base is self._base

    def cardinality(self):
        """q^n.

        EXAMPLES::

            sage: VectorSpace(GF(2), 3).cardinality()
            8
        """
        return _sa().Integer(int(self._base.order()) ** self._n)

    def __iter__(self):
        els = _field_elements(self._base)
        q = len(els)
        for idx in range(q ** self._n):
            c = []
            t = idx
            for _ in range(self._n):
                c.append(els[t % q])
                t //= q
            yield FFVector(self._base, c)

    def __eq__(self, o):
        return isinstance(o, FFVectorSpace) and not isinstance(o, FFSubspace) and o._base is self._base and o._n == self._n

    def __hash__(self):
        return hash((repr(self._base), self._n))


class _Basis(list):
    """A basis: a list, whose str (print) has one vector per line, as
    Sage's sequences of basis vectors, and immutable, as Sage's.

    EXAMPLES::

        sage: B = (QQ^3).basis(); B[0] = B[1]
        Traceback (most recent call last):
        ...
        ValueError: object is immutable; please change a copy instead.
        sage: C = list(B); C[0] = C[1]; C
        [(0, 1, 0), (0, 1, 0), (0, 0, 1)]
    """

    def __str__(self):
        return "[\n" + ",\n".join(repr(v) for v in self) + "\n]"

    def _immutable(self, *a, **k):
        raise ValueError("object is immutable; please change a copy instead.")

    __setitem__ = __delitem__ = __iadd__ = __imul__ = _immutable
    append = extend = insert = pop = remove = sort = reverse = clear = _immutable

    def is_immutable(self):
        return True


class FFSubspace(FFVectorSpace):
    """A subspace of F^n with an echelonized basis.

    EXAMPLES::

        sage: matrix(GF(2), [[1, 1, 0], [0, 1, 1], [1, 0, 1]]).kernel()
        Vector space of degree 3 and dimension 1 over Finite Field of size 2
        Basis matrix:
        [1 1 1]
    """

    def __init__(self, base, n, gens):
        self._base, self._n = base, n
        if gens:
            # (the generators converted, and their echelon form, before
            # either is built: daybreak2's HARD-21A-1)
            _admit_size(base, len(gens), n, 2)
            m, piv, d = _echelon([[base(x) for x in g] for g in gens], base, n)
            self._basis = [r for r in m if any(r)]
        else:
            self._basis = []

    def __repr__(self):
        s = "Vector space of degree %d and dimension %d over %r\nBasis matrix:\n" % (self._n, len(self._basis), self._base)
        if not self._basis:
            return s + "[]"
        return s + repr(FFMatrix(self._base, self._basis, self._n))

    def dimension(self):
        """The dimension.

        EXAMPLES::

            sage: matrix(GF(2), [[1, 1, 0], [0, 1, 1]]).row_space().dimension()
            2
        """
        return _sa().Integer(len(self._basis))

    dim = dimension

    def degree(self):
        """The ambient dimension.

        EXAMPLES::

            sage: matrix(GF(2), [[1, 1, 0]]).row_space().degree()
            3
        """
        return _sa().Integer(self._n)

    def basis(self):
        """The echelonized basis.

        EXAMPLES::

            sage: V = VectorSpace(GF(2), 3); V.subspace([V([1, 1, 0])]).basis()
            [(1, 1, 0)]
        """
        return _Basis([FFVector(self._base, r) for r in self._basis])

    def basis_matrix(self):
        """The basis as the rows of a matrix.

        EXAMPLES::

            sage: V = VectorSpace(GF(2), 3); V.subspace([V([1, 1, 0])]).basis_matrix()
            [1 1 0]
        """
        return FFMatrix(self._base, self._basis, self._n)

    def ambient_vector_space(self):
        """F^n.

        EXAMPLES::

            sage: V = VectorSpace(GF(2), 3); V.subspace([V([1, 1, 0])]).ambient_vector_space()
            Vector space of dimension 3 over Finite Field of size 2
        """
        return VectorSpace(self._base, self._n)

    def __contains__(self, v):
        if not isinstance(v, (FFVector, list, tuple)) or len(v) != self._n:
            return False
        rows = self._basis + [[self._base(x) for x in v]]
        return len(_echelon(rows, self._base, self._n)[1]) == len(self._basis)

    def __iter__(self):
        els = _field_elements(self._base)
        q = len(els)
        k = len(self._basis)
        zero = self._base.zero()
        for idx in range(q ** k):
            v = [zero] * self._n
            t = idx
            for r in self._basis:
                c = els[t % q]
                t //= q
                if c:
                    v = [a + c * b for a, b in zip(v, r)]
            yield FFVector(self._base, v)

    def cardinality(self):
        """q^dimension.

        EXAMPLES::

            sage: V = VectorSpace(GF(3), 3); V.subspace([V([1, 1, 0])]).cardinality()
            3
        """
        return _sa().Integer(int(self._base.order()) ** len(self._basis))

    def __eq__(self, o):
        return isinstance(o, FFSubspace) and o._base is self._base and o._n == self._n and o._basis == self._basis

    def __hash__(self):
        return hash((repr(self._base), self._n, tuple(tuple(r) for r in self._basis)))


def VectorSpace(base, n):
    """The vector space base^n over a finite field.

    EXAMPLES::

        sage: VectorSpace(GF(2), 8)
        Vector space of dimension 8 over Finite Field of size 2
    """
    from _sage_matrix import _vector_dim
    n = _vector_dim(n)
    key = (id(base), n)
    if key not in _SPACES:
        _SPACES[key] = (base, FFVectorSpace(base, n))
    return _SPACES[key][1]


def vector(base, entries):
    """vector(GF(q), entries).

    EXAMPLES::

        sage: vector(GF(5), [1, 2, 3]).parent()
        Vector space of dimension 3 over Finite Field of size 5
    """
    # (FFVector reads the entries within the heap budget)
    return FFVector(base, entries)
