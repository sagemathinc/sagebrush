"""MATLAB's sparse matrices, for lib/_matlab.py (see its Sparse class).

A sparse matrix is stored as MATLAB stores it, in compressed sparse column
form.  An m-by-n matrix has:
- jc: n + 1 column starts;
- ir: each nonzero's row (0-based, increasing within its column);
- pr: the nonzeros (float64, complex128 or bool).
No zero is stored.  (MATLAB's sparse matrices are double, single or
logical: pr float32 or complex64 for single.)  Values are immutable: an operation makes a new one, so a
sparse matrix is never copied.

The operations here work on that storage, so they stay fast on large
matrices: construction, queries, display, indexing, and (see below) the
arithmetic and functions that keep a matrix sparse.  Any other function sees
a sparse matrix as the full matrix it stands for (_matlab's _arr and _farr
expand it), and computes what it computes on a full one.  activate() wraps
the built-in functions for that, the first time a sparse matrix is made, so
that programs without one pay nothing.
"""

import math as _math

import numpy as np

import _matlab as _m
from _matlab import Sparse, COLON, NOVAL, _err

_I = np.int64

# the most elements a sparse matrix is expanded to as a full one (2 GB of doubles)
MAX_FULL = 1 << 28

# (class-1 runtime protection, plan-matlab-nocliffs r6 section 2.8, measured
# by M1b: the largest uninterrupted NumPy element kernel, E elements, and the
# largest single allocation, A_SAFE bytes; E = min(E_TIME, A_SAFE / 32) so
# that every block holds whole chunks of every dtype and every kernel's
# output, at most 2E elements of 16 bytes, fits one call.  _matlab_lu, the
# sparse solves, imports them)
E_TIME = 1 << 14
A_SAFE = 1 << 31
E = min(E_TIME, A_SAFE // 32)
assert A_SAFE >= 32 * E

# (the first-use fix, plan r3 section 2; @sagebrush's ruling of Oct 29: an authorized admission exemption for
# unmanaged allocations, NOT a safety guarantee) full() and the not-big dense solve whose whole peak need, counted as
# their admitted routes count it plus each fill's chunk transients, is at most SMALL_NEED bytes run the same chunked
# code with no capacity record, Ledger or _matlab_lu import (master never checked them either).  Larger needs, and
# the diagonal, band and LU routes, keep full admission.  No aggregate bound at this layer, as on master: the
# engine's heap limit is the backstop.  A test seam
SMALL_NEED = 1 << 22


# ------------------------------------------------------------------ storage

def _new(m, n, jc, ir, pr):
    S = Sparse.__new__(Sparse)
    S.m, S.n, S.jc, S.ir, S.pr = m, n, jc, ir, pr
    S.cap = 0
    activate()
    return S


def _cols(S):
    """each nonzero's column (0-based)"""
    return np.repeat(np.arange(S.n, dtype=_I), np.diff(S.jc))


def _keys(S):
    """each nonzero's column-major position (0-based): increasing"""
    return _cols(S) * S.m + S.ir


def _jc(cols, n):
    jc = np.zeros(n + 1, dtype=_I)
    if cols.size:
        jc[1:] = np.cumsum(np.bincount(cols, minlength=n))
    return jc


def _canon_vals(vals):
    k = vals.dtype.kind
    if k == "b":
        return vals
    single = vals.dtype.itemsize == (8 if k == "c" else 4)
    if k == "c":
        vals = vals.astype(np.complex64 if single else np.complex128)
        return np.array(vals.real) if not np.any(vals.imag) else vals
    return vals.astype(np.float32 if single else np.float64)


def make(m, n, rows, cols, vals, combine="sum"):
    """an m-by-n sparse matrix from coordinates (0-based) and values: values
    at the same place summed (or-ed when logical), or with combine="last" the
    last one kept; zeros dropped"""
    rows = np.asarray(rows, dtype=_I).reshape(-1)
    cols = np.asarray(cols, dtype=_I).reshape(-1)
    vals = _canon_vals(np.asarray(vals).reshape(-1))
    if rows.size:
        key = cols * m + rows
        order = np.argsort(key, kind="stable")
        key = key[order]
        vals = vals[order]
        if key.size > 1 and np.any(key[1:] == key[:-1]):
            if combine == "last":
                last = np.ones(key.size, dtype=bool)
                last[:-1] = key[1:] != key[:-1]
                key, vals = key[last], vals[last]
            else:
                uk, inv = np.unique(key, return_inverse=True)
                if vals.dtype.kind == "b":
                    vals = np.bincount(inv, weights=vals.astype(np.float64), minlength=uk.size) > 0
                elif vals.dtype.kind == "c":
                    vals = _m._cplx(np.bincount(inv, weights=vals.real, minlength=uk.size),
                                    np.bincount(inv, weights=vals.imag, minlength=uk.size))
                else:
                    vals = np.bincount(inv, weights=vals, minlength=uk.size)
                key = uk
        keep = vals != 0
        if not np.all(keep):
            key, vals = key[keep], vals[keep]
        rows, cols = key % m, key // m
    vals = _canon_vals(vals)
    return _new(m, n, _jc(cols, n), np.array(rows, dtype=_I), np.array(vals))


def from_full(v, name="sparse"):
    """a full numeric or logical matrix as a sparse one"""
    if type(v) is Sparse:
        return v
    cls = _m.class_(v)
    if cls not in ("double", "single", "logical") or not _m._isnumlike(v):
        raise _err("Undefined function '%s' for input arguments of type '%s'." % (name, cls), "MATLAB:UndefinedFunction")
    a = _m._arr(v)
    if a.ndim > 2:
        raise _err("N-dimensional sparse arrays are not supported.")
    n, m = a.shape
    if a.dtype.kind == "c" and not np.any(a.imag):
        a = np.array(a.real)
    nz = np.nonzero(a)  # (stored transposed: column by column, each column's rows in order)
    return _new(m, n, _jc(nz[0].astype(_I), n), nz[1].astype(_I), _canon_vals(np.array(a[nz])))


def zeros(m, n, like=None):
    """an all-zero m-by-n sparse matrix, of the class of like (a sparse matrix) or double"""
    dt = like.pr.dtype if type(like) is Sparse else np.float64
    return _new(m, n, np.zeros(n + 1, dtype=_I), np.zeros(0, dtype=_I), np.zeros(0, dtype=dt))


def nzmax(S):
    return max(S.cap, nnz(S), 1)


def isreal(v):
    if type(v) is Sparse:
        return v.pr.dtype.kind != "c"
    return _m._arr(v).dtype.kind != "c"


def nbytes(S):
    """MATLAB's storage of a sparse matrix: its column starts, and a row index and a value for each of nzmax places"""
    return (S.n + 1) * 8 + nzmax(S) * (8 + S.pr.dtype.itemsize)


def _too_big(m, n):
    gb = m * n * 8 / 2.0 ** 30
    return _err("Requested %dx%d (%.1fGB) array exceeds maximum array size preference. Creation of arrays greater "
                "than this limit may take a long time and cause MATLAB to become unresponsive." % (m, n, gb),
                "MATLAB:array:SizeLimitExceeded")


def _full_need(S, step=None):
    """full_arr's bytes: the result, and the fill's chunk transients (a
    chunk's column numbers: an arange, a diff and a repeat of E indices)"""
    return S.m * S.n * S.pr.dtype.itemsize + 3 * (step or E) * 8


def full_arr(S):
    """the full matrix S stands for, stored as _matlab stores arrays
    (transposed): admitted against the capacity record (r6 section 2.5), its
    copy made in chunks of at most E entries; where the record can't admit
    memory (no figure, or one without the JS domains: the browser today),
    master's MAX_FULL check and fill, verbatim (ruling d2)"""
    need = _full_need(S)
    if need <= SMALL_NEED:
        # (exempt: the chunked fill _full_need counts, unadmitted; nothing imported, no capacity read)
        return _fill_full(S)
    rec = _capacity_record()
    if unmeasured_reason(rec) is not None:
        return _legacy_full_arr(S)
    import _matlab_ledger as LG

    led = LG.Ledger("A %dx%d full matrix" % (S.m, S.n), "one array", rec=rec)
    try:
        led.reserve(need, "full")
    except MemoryError as g:
        e = _too_big(S.m, S.n)
        e.record, e.need_bytes, e.limit_bytes = g.record, g.need_bytes, g.limit_bytes
        raise e
    return _fill_full(S)


def _fill_full(S):
    """S's full array (transposed), filled by chunks of at most E columns and
    E entries (as bandwidths): no call proportional to nnz"""
    a = np.zeros((S.n, S.m), dtype=S.pr.dtype)
    n, jc, ir, pr = S.n, S.jc, S.ir, S.pr
    if not pr.size:
        return a
    c0 = 0
    while c0 < n:
        lo = int(jc[c0])
        if int(jc[c0 + 1]) - lo > E:
            hi = int(jc[c0 + 1])
            for s in range(lo, hi, E):
                t = min(hi, s + E)
                a[c0, ir[s:t]] = pr[s:t]
            c0 += 1
            continue
        p = int(np.searchsorted(jc[c0:c0 + E + 1], lo + E, "right"))
        c1 = min(n, c0 + p - 1)
        hi = int(jc[c1])
        if hi > lo:
            a[np.repeat(np.arange(c0, c1, dtype=_I), np.diff(jc[c0:c1 + 1])), ir[lo:hi]] = pr[lo:hi]
        c0 = c1
    return a


# MASTER'S full_arr, kept verbatim as an interim (ruling d2, Oct 27 2026):
# where the capacity record does not cover the js-heap and js-arraybuffer
# domains, full() keeps master's fixed cap.  Registered to D0: removed, with
# MAX_FULL, when every production browser's record covers both domains
def _legacy_full_arr(S):
    if S.m * S.n > MAX_FULL:
        raise _too_big(S.m, S.n)
    a = np.zeros((S.n, S.m), dtype=S.pr.dtype)
    if S.pr.size:
        a[_cols(S), S.ir] = S.pr
    return a


def full(v):
    """full(S) as a MATLAB value"""
    if type(v) is not Sparse:
        return _m.cp(v)
    return _m._box(full_arr(v))


def islogical(S):
    return S.pr.dtype.kind == "b"


def class_(S):
    return _m._dtclass(S.pr.dtype)


def nnz(S):
    return int(S.pr.size)


def transpose(S, conj=False):
    if not S.pr.size:
        return zeros(S.n, S.m, S)
    vals = S.pr
    if conj and vals.dtype.kind == "c":
        # (a real element's imaginary part stays 0, not -0)
        vals = _m._cplx(vals.real, np.where(vals.imag == 0, 0.0, -vals.imag)).astype(vals.dtype)
    return make(S.n, S.m, _cols(S), S.ir, vals)


# ------------------------------------------------------------------ display

def blocks(S):
    """(header blocks, body blocks) of S's display"""
    d = (S.m, S.n)
    nz = nnz(S)
    kind = class_(S) if S.pr.dtype.kind != "c" else "complex " + class_(S)
    if S.m * S.n == 0:
        return ["  %s empty sparse %s %s" % (_m._dimstr(d), kind, "array" if kind == "logical" else "matrix")], []
    if S.m == 1 and S.n == 1:
        what = "sparse %s scalar" % kind
    else:
        word = _m._shape_word(d)
        what = "%s sparse %s %s" % (_m._dimstr(d), kind, "array" if kind == "logical" and word == "matrix" else word)
    if nz == 0:
        return ["  " + what], ["   All zero"]
    head = ["  " + what if S.m == S.n == 1 else "  %s (%d nonzero%s)" % (what, nz, "" if nz == 1 else "s")]
    # (each value as a full matrix of the nonzeros would show it, after its
    # (row,col): the commas in a column, the indices in fields K wide as a
    # full matrix's integers are (less one), each value ending K + W past the
    # comma, W the width of the full matrix's columns)
    rows = S.ir + 1
    cols = _cols(S) + 1
    K = 5 if max(int(np.max(rows)), int(np.max(cols))) < 1000 else 11
    vals = S.pr
    body = []
    if vals.dtype.kind == "b":
        texts, w = ["1"] * nz, 4
    elif vals.dtype.kind == "c":
        f, scale = _m._fmt_complex_parts(vals.reshape((-1, 1)), nz == 1)
        parts = [(f(z.real + 0.0), "-" if z.imag < 0 else "+", f(abs(z.imag)) if z.imag == z.imag else "NaN")
                 for z in (complex(x) for x in vals)]
        wr = max(9 if _m._format["num"] != "long" else 19, max(len(p[0]) for p in parts) + 2)
        wi = max(max(len(p[2]) for p in parts), len(f(1.0)) + 1)
        texts = ["%s %s%si" % (p[0].rjust(wr), p[1], p[2].rjust(wi)) for p in parts]
        w = wr + wi + 3 - (_m._format["num"] == "long")
        if scale:
            body.append(("%s *" % scale).rjust(12))
    else:
        nf = _m._NumFmt(vals.reshape((-1, 1)), nz == 1, _m._format["num"] == "long")
        texts = [nf.fmt(float(x)) for x in vals]
        w = nf.width
        longest = max(len(t) for t in texts)
        if longest + 2 > w:
            w = longest + 3 if nf.kind == "int" else longest + 2
        if nf.scale is not None:
            body.append(("%s *" % nf.scale_text).rjust(12))
    lines = []
    for k in range(nz):
        r = str(int(rows[k]))
        c = str(int(cols[k]))
        t = texts[k]
        lines.append("%s(%s,%s)%s" % (" " * max(0, K - 1 - len(r)), r, c, t.rjust(max(K + w - len(c) - 1, len(t) + 1))))
    body.append("\n".join(lines))
    return head, body


# ------------------------------------------------------------------ indexing

def _vec_out(dims, idims, count):
    """the dimensions of v(k) for a linear index k (as _matlab's _positions)"""
    src_vec = dims[0] == 1 or dims[1] == 1
    ivec = len(idims) == 2 and (idims[0] == 1 or idims[1] == 1)
    if src_vec and ivec and not (dims[0] == 1 and dims[1] == 1):
        return (1, count) if dims[0] == 1 else (count, 1)
    return tuple(idims)


def index_arg(a):
    """an index that is itself sparse, as the full value it stands for"""
    return full(a) if type(a) is Sparse else a


def index(S, args):
    """S(args): always sparse, as MATLAB's (S(2,2) too)"""
    args = [index_arg(a) for a in args]
    if not args:
        return S
    if len(args) == 1:
        a = args[0]
        total = S.m * S.n
        if a is COLON:
            return reshape(S, total, 1)
        idx, idims, _ = _m._ivec(a, total, -1, False)
        out = _vec_out((S.m, S.n), idims, idx.size)
        if len(out) > 2:
            raise _err("N-dimensional sparse arrays are not supported.")
        key = _keys(S)
        p = np.searchsorted(key, idx)
        pc = np.minimum(p, max(key.size - 1, 0))
        found = (p < key.size) & (key[pc] == idx) if key.size else np.zeros(idx.size, dtype=bool)
        k = np.nonzero(found)[0].astype(_I)
        r0 = out[0]
        return make(out[0], out[1], k % r0 if r0 else k, k // r0 if r0 else k, S.pr[pc[found]])
    for k in range(2, len(args)):
        idx, _, _ = _m._ivec(args[k], 1, k, False)
    I = _m._ivec(args[0], S.m, 0, False)[0] if args[0] is not COLON else None
    J = _m._ivec(args[1], S.n, 1, False)[0]
    return _submatrix(S, I, J)


def _gather(S, J):
    """the nonzeros of the columns J, in order: (their indices in ir/pr, their column's place in J)"""
    starts = S.jc[J]
    counts = S.jc[J + 1] - starts
    total = int(np.sum(counts)) if counts.size else 0
    if total == 0:
        return np.zeros(0, dtype=_I), np.zeros(0, dtype=_I)
    offs = np.cumsum(counts) - counts
    e = np.arange(total, dtype=_I) - np.repeat(offs, counts) + np.repeat(starts, counts)
    return e, np.repeat(np.arange(J.size, dtype=_I), counts)


def _submatrix(S, I, J):
    """S(I, J) for 0-based index vectors (I None: every row)"""
    e, oc = _gather(S, J)
    vals = S.pr[e]
    rows = S.ir[e]
    if I is None:
        return make(S.m, J.size, rows, oc, vals)
    # each nonzero once for every place its row has in I
    order = np.argsort(I, kind="stable")
    Is = I[order]
    lo = np.searchsorted(Is, rows, side="left")
    hi = np.searchsorted(Is, rows, side="right")
    cnt = hi - lo
    tot = int(np.sum(cnt)) if cnt.size else 0
    if tot == 0:
        return zeros(I.size, J.size, S)
    offs = np.cumsum(cnt) - cnt
    place = np.arange(tot, dtype=_I) - np.repeat(offs, cnt) + np.repeat(lo, cnt)
    return make(I.size, J.size, order[place], np.repeat(oc, cnt), np.repeat(vals, cnt))


def reshape(S, m, n):
    if m * n != S.m * S.n:
        raise _err("Number of elements must not change. Use [] as one of the size inputs to automatically calculate the appropriate size for that dimension.", "MATLAB:getReshapeDims:notSameNumel")
    key = _keys(S)
    return make(m, n, key % m if m else key, key // m if m else key, S.pr)


def columns(S):
    """the values a for loop takes over S: its columns, each sparse"""
    J = np.zeros(1, dtype=_I)
    for j in range(S.n):
        J[0] = j
        yield _submatrix(S, None, J)


def truth(S):
    """S as the condition of if or while: nonempty, every element nonzero"""
    if S.m * S.n == 0 or nnz(S) != S.m * S.n:
        return False
    if S.pr.dtype.kind in "fc" and np.any(np.isnan(S.pr)):
        # (a NaN in either part of a complex value)
        raise _err("NaN's cannot be converted to logicals.", "MATLAB:nologicalnan")
    return True


# ------------------------------------------------------------------ assignment and concatenation

def _rhs_values(v, cls):
    """the values assigned into a sparse matrix of class cls, column-major"""
    c = _m.class_(v)
    if c in ("cell", "struct", "string", "function_handle") or not (_m._isnumlike(v) or type(v) is Sparse):
        raise _err("Conversion to %s from %s is not possible." % (cls, c), "MATLAB:invalidConversion")
    a = _m._farr(full(v) if type(v) is Sparse else v).reshape(-1)
    if cls == "logical":
        if a.dtype.kind == "c":
            a = a.real
        if np.any(np.isnan(a)):
            raise _err("NaN's cannot be converted to logicals.", "MATLAB:nologicalnan")
        return a != 0
    return a


def assign(S, args, v):
    """S(args) = v: sparse, its class kept (complex if a complex value goes in)"""
    args = [index_arg(a) for a in args]
    cls = class_(S)
    vals = _rhs_values(v, cls)
    dims = (S.m, S.n)
    try:
        nd = _m._grow_dims(dims, args, _m._dims(v))
    except _m.MatlabError as e:
        if e.identifier == "MATLAB:indexed_matrix_cannot_be_resized":
            raise _err("In an assignment  A(I) = B, a matrix A cannot be resized.", "MATLAB:indexed_matrix_cannot_be_resized")
        raise
    if len(nd) > 2:
        raise _err("N-dimensional sparse arrays are not supported.")
    m, n = nd
    if len(args) == 1:
        a = args[0]
        if a is COLON:
            tk = np.arange(m * n, dtype=_I)
        else:
            tk, _, _ = _m._ivec(a, m * n, -1, True)
    else:
        for k in range(2, len(args)):
            _m._ivec(args[k], 1, k, False)
        I = np.arange(m, dtype=_I) if args[0] is COLON else _m._ivec(args[0], m, 0, True)[0]
        J = np.arange(n, dtype=_I) if args[1] is COLON else _m._ivec(args[1], n, 1, True)[0]
        tk = (J.reshape((-1, 1)) * m + I.reshape((1, -1))).reshape(-1)
    if vals.size != 1 and vals.size != tk.size:
        raise _err("Unable to perform assignment because the indices on the left side are not compatible with the size of the right side.", "MATLAB:subsassigndimmismatch")
    # the old nonzeros, where nothing is assigned, and the assigned values (the last one at a place)
    old = _cols(S) * m + S.ir
    keep = ~np.isin(old, tk) if tk.size else np.ones(old.size, dtype=bool)
    new = np.repeat(vals, tk.size) if vals.size == 1 else vals
    ov = S.pr[keep]
    if ov.dtype.kind != new.dtype.kind or ov.dtype != new.dtype:
        if cls == "logical":
            new = new.astype(bool)
        else:
            dt = np.result_type(ov.dtype if ov.size else np.float64, new.dtype)
            if dt.kind == "b":
                dt = np.float64
            ov, new = ov.astype(dt), new.astype(dt)
    keys = np.concatenate([old[keep], tk])
    allv = np.concatenate([ov, new])
    r = make(m, n, keys % m if m else keys, keys // m if m else keys, allv, combine="last")
    r = _cast(r, cls) if cls != "logical" else r
    r.cap = max(S.cap, nnz(r))  # (spalloc's reservation lasts)
    return r


def delete(S, args):
    """S(args) = []"""
    args = [index_arg(a) for a in args]
    m, n = S.m, S.n
    key = _keys(S)
    if len(args) == 1:
        a = args[0]
        if a is COLON:
            return zeros(0, 0, S)
        R = np.unique(_m._ivec(a, m * n, -1, False)[0])
        keep = ~np.isin(key, R)
        k = key[keep] - np.searchsorted(R, key[keep])
        total = m * n - R.size
        if n == 1 and m != 1:
            return make(total, 1, k, np.zeros(k.size, dtype=_I), S.pr[keep])
        return make(1, total, np.zeros(k.size, dtype=_I), k, S.pr[keep])
    d = [m, n]
    which = [k for k in range(2) if not (args[k] is COLON or _m._covers(args[k], d[k]))]
    for k in range(2, len(args)):
        _m._ivec(args[k], 1, k, False)
    if not which:
        return zeros(0, n, S)
    if len(which) > 1:
        raise _err("A null assignment can have only one non-colon index.", "MATLAB:nullAssignmentNonColonIndex")
    k = which[0]
    R = np.unique(_m._ivec(args[k], d[k], k, False)[0])
    rows, cols = S.ir, _cols(S)
    sub = rows if k == 0 else cols
    keep = ~np.isin(sub, R)
    sub = sub[keep] - np.searchsorted(R, sub[keep])
    if k == 0:
        return make(m - R.size, n, sub, cols[keep], S.pr[keep])
    return make(m, n - R.size, rows[keep], sub, S.pr[keep])


def cat(vals, dim):
    """[...] with a sparse part: sparse; None for cells and other containers"""
    cls = _m._cat_class(vals)
    if cls in ("cell", "struct", "string", "handle"):
        return None
    if dim > 2:
        raise _err("Dimension for sparse matrix concatenation must be <= 2.", "MATLAB:catenate:sparseDimensionBad")
    if cls in _m._INTS or cls == "char":
        raise _err("The following error occurred converting from double to %s:\nAttempt to convert to unimplemented sparse type" % cls, "MATLAB:UnableToConvert")
    parts = [v for v in vals if _m._numel(v) != 0]
    if not parts:
        v = next(v for v in vals if type(v) is Sparse)
        return v
    mats = [_as_sparse(v) for v in parts]
    for A in mats[1:]:
        if (dim == 2 and A.m != mats[0].m) or (dim == 1 and A.n != mats[0].n):
            raise _err("Dimensions of arrays being concatenated are not consistent.", "MATLAB:catenate:dimensionMismatch")
    rows, cols, vs = [], [], []
    off = 0
    for A in mats:
        r, c = A.ir, _cols(A)
        rows.append(r + off if dim == 1 else r)
        cols.append(c + off if dim == 2 else c)
        vs.append(A.pr)
        off += A.m if dim == 1 else A.n
    m = off if dim == 1 else mats[0].m
    n = off if dim == 2 else mats[0].n
    allv = np.concatenate([x.astype(np.float64) if x.dtype.kind == "b" and cls != "logical" else x for x in vs]) if vs else np.zeros(0)
    r = make(m, n, np.concatenate(rows), np.concatenate(cols), allv)
    return _cast(r, cls) if cls != "logical" else r


# ------------------------------------------------------------------ arithmetic

def _is_scalar(x):
    return _m._numel(x) == 1


def _value_class(a, b, name):
    """the class of a ⊕ b with a sparse operand: double, single or logical"""
    for x in (a, b):
        if _m.class_(x) in _m._INTS:
            raise _err("Sparse integer array arithmetic operations are not supported.", "MATLAB:sparseInteger")
    return _m._arith_class(a, b, name)


def _sparse_result(name, a, b):
    """whether MATLAB keeps a ⊕ b sparse"""
    sa, sb = type(a) is Sparse, type(b) is Sparse
    if name in ("plus", "minus", "or", "xor"):
        return sa and sb
    if name == "times":
        return True
    if name in ("rdivide", "power"):
        return sa
    if name == "ldivide":
        return sb
    if name == "mtimes":
        # (with a scalar, as .*)
        return (sa and sb) or _is_scalar(a) or _is_scalar(b)
    if name == "mrdivide":
        return (sa and sb) or (sa and _is_scalar(b))
    if name == "mldivide":
        return (sa and sb) or (sb and _is_scalar(a))
    if name == "mpower":
        return sa
    return True  # comparisons, and


def _as_sparse(x):
    return x if type(x) is Sparse else from_full(x)


def _cast(S, cls):
    """S with its values in class cls (double or single; logical kept)"""
    k = S.pr.dtype.kind
    if k == "b" and cls != "logical":
        return _new(S.m, S.n, S.jc, S.ir, S.pr.astype(np.float32 if cls == "single" else np.float64))
    if cls == "single" and k in "fc" and S.pr.dtype.itemsize == (4 if k == "f" else 8) * 2:
        return _new(S.m, S.n, S.jc, S.ir, S.pr.astype(np.complex64 if k == "c" else np.float32))
    return S


def _fvals(S):
    """S's nonzeros as float64 or complex128"""
    v = S.pr
    if v.dtype.kind == "b":
        return v.astype(np.float64)
    return v.astype(np.complex128) if v.dtype.kind == "c" else v.astype(np.float64)


def _with(S, vals, cls):
    """S's pattern with new values (zeros dropped), in class cls"""
    vals = np.asarray(vals)
    if cls == "logical":
        vals = vals.astype(bool)
    elif cls == "single":
        vals = vals.astype(np.complex64 if vals.dtype.kind == "c" else np.float32)
    keep = vals != 0
    if np.all(keep):
        return _new(S.m, S.n, S.jc, S.ir, _canon_vals(np.array(vals)))
    return make(S.m, S.n, S.ir[keep], _cols(S)[keep], vals[keep])


def _scalar_value(x):
    a = _m._farr(x).reshape(-1)
    v = a[0]
    return complex(v) if a.dtype.kind == "c" else float(v)


def _finite(z):
    return z == z and abs(z) != _math.inf


def _union(A, B):
    """the union of two same-sized sparse matrices' patterns: (keys, A's values there, B's)"""
    ka, kb = _keys(A), _keys(B)
    keys = np.unique(np.concatenate([ka, kb]))
    va = np.zeros(keys.size, dtype=np.complex128 if A.pr.dtype.kind == "c" else np.float64)
    vb = np.zeros(keys.size, dtype=np.complex128 if B.pr.dtype.kind == "c" else np.float64)
    if ka.size:
        va[np.searchsorted(keys, ka)] = _fvals(A)
    if kb.size:
        vb[np.searchsorted(keys, kb)] = _fvals(B)
    return keys, va, vb


def _from_keys(m, n, keys, vals, cls):
    vals = np.asarray(vals)
    if cls == "logical":
        vals = vals.astype(bool)
    elif cls == "single":
        vals = vals.astype(np.complex64 if vals.dtype.kind == "c" else np.float32)
    keep = vals != 0
    keys, vals = keys[keep], vals[keep]
    return make(m, n, keys % m if m else keys, keys // m if m else keys, vals)


_ELEM = {
    "plus": _m._add, "minus": _m._sub, "times": _m._mul, "rdivide": _m._div,
    "ldivide": lambda A, B: _m._div(B, A), "power": _m._pow,
}
_CMP = {
    "eq": lambda x, y: x == y, "ne": lambda x, y: x != y, "lt": lambda x, y: x < y,
    "le": lambda x, y: x <= y, "gt": lambda x, y: x > y, "ge": lambda x, y: x >= y,
}


def _native(name, a, b, cls):
    """a ⊕ b on the sparse storage, when the result is sparse and that is exact; else None"""
    sa, sb = type(a) is Sparse, type(b) is Sparse
    same = _m._dims(a) == _m._dims(b)
    if name in ("plus", "minus") and sa and sb and same:
        rows = np.concatenate([a.ir, b.ir])
        cols = np.concatenate([_cols(a), _cols(b)])
        vb = _fvals(b)
        vals = np.concatenate([_fvals(a).astype(np.complex128) if vb.dtype.kind == "c" else _fvals(a),
                               -vb if name == "minus" else vb])
        r = make(a.m, a.n, rows, cols, vals)
        return _cast(r, cls)
    if name == "times" and (sa != sb) and _is_scalar(b if sa else a) and not (sa and sb):
        S, k = (a, b) if sa else (b, a)
        z = _scalar_value(k)
        if _finite(z):
            return _with(S, _m._mul(_fvals(S), np.array([z])), cls)
        return None
    if name in ("rdivide", "ldivide") and (sa if name == "rdivide" else sb):
        S, k = (a, b) if name == "rdivide" else (b, a)
        if type(k) is not Sparse and _is_scalar(k):
            z = _scalar_value(k)
            if z != 0 and z == z:
                return _with(S, _m._div(_fvals(S), np.array([z])), cls)
        return None
    if name == "times" and same:
        if sa and sb:
            keys, va, vb = _union(a, b)
            return _from_keys(a.m, a.n, keys, _m._mul(va, vb), cls)
        S, F = (a, b) if sa else (b, a)
        f = _m._farr(F).reshape(-1)
        if np.all(np.isfinite(f)):
            return _with(S, _m._mul(_fvals(S), f[_keys(S)]), cls)
        return None
    if name == "power" and sa and type(b) is not Sparse and _is_scalar(b):
        z = _scalar_value(b)
        if type(z) is float and z > 0:
            return _with(a, _m._pow(_fvals(a), np.array([z])), cls)
        return None
    if name in _CMP:
        f = _CMP[name]
        if (sa != sb) and _is_scalar(b if sa else a):
            S, k = (a, b) if sa else (b, a)
            z = _scalar_value(k)
            z = z.real if type(z) is complex and name not in ("eq", "ne") else z
            g = f if sa else (lambda x, y: f(y, x))
            if not g(0.0, z):
                vals = _fvals(S)
                if vals.dtype.kind == "c" and name not in ("eq", "ne"):
                    vals = vals.real
                return _with(S, g(vals, z), "logical")
            return None
        if sa and sb and same and not f(0.0, 0.0):
            keys, va, vb = _union(a, b)
            if name not in ("eq", "ne"):
                va, vb = va.real, vb.real
            return _from_keys(a.m, a.n, keys, f(va, vb), "logical")
        return None
    if name == "and" and same:
        if sa and sb:
            keys, va, vb = _union(a, b)
            return _from_keys(a.m, a.n, keys, (va != 0) & (vb != 0), "logical")
        S, F = (a, b) if sa else (b, a)
        f = _m._logical_arr(F, "and").reshape(-1)
        return _with(S, f[_keys(S)], "logical")
    if name in ("or", "xor") and sa and sb and same:
        keys, va, vb = _union(a, b)
        x, y = va != 0, vb != 0
        return _from_keys(a.m, a.n, keys, (x | y) if name == "or" else (x != y), "logical")
    return None


def _full_pm(name, a, b):
    """S + F, S - F, F - S with a full matrix F the same size: full, as MATLAB
    computes it (F, or -F, with S's nonzeros added: -0 where S is zero in S - F)"""
    S, F = (a, b) if type(a) is Sparse else (b, a)
    out = _m._farr(F).astype(np.complex128 if S.pr.dtype.kind == "c" else _m._farr(F).dtype)
    if S.pr.dtype.kind == "c" and out.dtype.kind != "c":
        out = out.astype(np.complex128)
    flat = np.array(out).reshape(-1)
    k = _keys(S)
    fk = flat[k]
    sv = _fvals(S)
    if name == "plus":
        flat[k] = sv + fk
    elif type(a) is Sparse:  # S - F
        flat = -flat
        flat[k] = sv - fk
    else:  # F - S
        flat[k] = fk - sv
    return _m._box(flat.reshape(out.shape))


def binop(name, a, b):
    """a ⊕ b (an operator) with a sparse operand"""
    cls = _value_class(a, b, name) if name not in _CMP and name not in ("and", "or", "xor") else "logical"
    if name in ("and", "or", "xor"):
        for x in (a, b):
            if _m.class_(x) in ("cell", "struct", "string", "function_handle"):
                raise _err("Operator '%s' is not supported for operands of type '%s'." % (_m._OPSYM.get(name, name), _m.class_(x)))
    elif name in _CMP:
        for x in (a, b):
            if _m.class_(x) in _m._INTS:
                raise _err("Sparse integer array arithmetic operations are not supported.", "MATLAB:sparseInteger")
    keep = _sparse_result(name, a, b)
    if keep:
        r = _native(name, a, b, cls)
        if r is not None:
            return r
    if name in ("mtimes", "mrdivide", "mldivide", "mpower"):
        return _matrix_op(name, a, b, cls, keep)
    if name in ("plus", "minus") and not keep and _m._dims(a) == _m._dims(b) and not (type(a) is Sparse and type(b) is Sparse):
        return _finish(_full_pm(name, a, b), cls)
    r = _dense(name, full(a), full(b))
    return _finish(from_full(r) if keep else r, cls)


def _finish(r, cls):
    if type(r) is Sparse:
        return _cast(r, cls)
    if cls == "single" and _m.class_(r) == "double":
        a = _m._farr(r)
        return _m._canon(a.astype(np.complex64 if a.dtype.kind == "c" else np.float32))
    return r


def _dense(name, a, b):
    if name == "xor":
        return _FULL["xor"](1, a, b)
    return getattr(_m, {"and": "and_", "or": "or_"}.get(name, name))(a, b)


def _matmul(A, B):
    """A * B for 2-D values with a sparse one (neither scalar): sparse if both are"""
    if _m._dims(A)[1] != _m._dims(B)[0]:
        raise _err("Incorrect dimensions for matrix multiplication. Check that the number of columns in the first matrix matches the number of rows in the second matrix. To operate on each element of the matrix individually, use TIMES (.*) for elementwise multiplication.", "MATLAB:innerdim")
    if type(A) is Sparse and type(B) is Sparse:
        # each nonzero B(k,j) times column k of A
        e, oc = _gather(A, B.ir)
        vals = _fvals(A)[e] * _fvals(B)[oc]
        return make(A.m, B.n, A.ir[e], _cols(B)[oc], vals)
    if type(A) is Sparse:
        # (each column of B: sums over A's nonzeros, row by row, in column order)
        Bf = _m._farr(B)  # stored transposed: Bf[j] is column j
        av = _fvals(A)
        ac = _cols(A)
        cplx = av.dtype.kind == "c" or Bf.dtype.kind == "c"
        out = np.zeros((Bf.shape[0], A.m), dtype=np.complex128 if cplx else np.float64)
        for j in range(Bf.shape[0]):
            prod = av * Bf[j][ac]
            if cplx:
                out[j] = _m._cplx(np.bincount(A.ir, weights=prod.real, minlength=A.m), np.bincount(A.ir, weights=prod.imag, minlength=A.m))
            else:
                out[j] = np.bincount(A.ir, weights=prod, minlength=A.m)
        return _m._box(out)
    # full * sparse: each column of B a sum over its nonzeros
    Af = _m._farr(A)  # (n, m) stored: Af[:, i] is row i of A... (stored transposed)
    M = Af.T  # m-by-k, MATLAB orientation
    bv = _fvals(B)
    bc = _cols(B)
    cplx = bv.dtype.kind == "c" or M.dtype.kind == "c"
    out = np.zeros((B.n, M.shape[0]), dtype=np.complex128 if cplx else np.float64)
    for i in range(M.shape[0]):
        prod = M[i][B.ir] * bv
        if cplx:
            out[:, i] = _m._cplx(np.bincount(bc, weights=prod.real, minlength=B.n), np.bincount(bc, weights=prod.imag, minlength=B.n))
        else:
            out[:, i] = np.bincount(bc, weights=prod, minlength=B.n)
    return _m._box(out)


def _matrix_op(name, a, b, cls, keep):
    if name == "mtimes":
        if _is_scalar(a) or _is_scalar(b):
            r = binop("times", a, b)
            return r if keep or type(r) is not Sparse else full(r)
        return _finish(_matmul(a, b), cls)
    if name == "mrdivide" and _is_scalar(b):
        return binop("rdivide", a, b)
    if name == "mldivide" and _is_scalar(a):
        return binop("ldivide", a, b)
    if name == "mldivide" and type(a) is Sparse:
        return _finish(mldivide(a, b), cls)
    if name == "mpower" and _is_scalar(b) and not _is_scalar(a):
        p = _m._scalar(b)
        if p == _math.floor(p) and p >= 0:
            if a.m != a.n:
                raise _err("Incorrect dimensions for raising a matrix to a power. Check that the matrix is square and the power is a scalar. To operate on each element of the matrix individually, use POWER (.^) for elementwise power.")
            # (by squaring from A itself, so that A^1 is A; each product is refused for Inf or
            # NaN as mtimes's is, so an Inf in A or from an overflowing square stops it)
            R = None
            A = a
            p = int(p)
            while p:
                if p & 1:
                    if R is None:
                        R = A
                    else:
                        _m._matprod_finite(R, A)
                        R = _matmul(R, A)
                p >>= 1
                if p:
                    _m._matprod_finite(A, A)
                    A = _matmul(A, A)
            if R is None:
                k = np.arange(a.n, dtype=_I)
                R = make(a.n, a.n, k, k, np.ones(a.n))
            return _cast(R, cls)
    r = getattr(_m, name)(full(a), full(b))
    return _finish(from_full(r) if keep and _m._isnumlike(r) else r, cls)


def unop(name, a):
    """-S, +S, ~S"""
    if name == "uminus":
        if islogical(a):
            return _with(a, -_fvals(a), "double")
        return _new(a.m, a.n, a.jc, a.ir, -a.pr)
    if name == "uplus":
        return _cast(a, "double") if islogical(a) else a
    # not: true where S is zero
    vals = a.pr.real if a.pr.dtype.kind == "c" else a.pr
    if vals.dtype.kind == "f" and np.any(np.isnan(vals)):
        raise _err("NaN's cannot be converted to logicals.", "MATLAB:nologicalnan")
    return from_full(np.logical_not(full_arr(a) != 0))


# ------------------------------------------------------------------ elementwise functions

# f(0) = 0: applied to the nonzeros alone
_ZERO_KEEPING = set("""abs sqrt sign round floor ceil fix real imag conj angle sin tan asin atan sinh tanh asinh
atanh expm1 log1p deg2rad rad2deg isnan isinf nthroot cbrt""".split())
# kept sparse, though most of their values are nonzero: computed on the full matrix
_SPARSE_FULL = set("""exp cos log log2 log10 cosh acos acosh sec csc cot asec acsc acot sech csch coth asech acsch
acoth gamma mod rem atan2 double logical single""".split())


def _elementwise_fn(name):
    f = _FULL[name]

    def g(nargout, *args):
        if not _has_sparse(args):
            return f(nargout, *args)
        x = args[0]
        if name in _ZERO_KEEPING and len(args) == 1 and type(x) is Sparse:
            col = _m._box(np.array(x.pr.reshape((1, -1))))
            r = f(1, col)
            vals = _m._arr(r).reshape(-1)
            if vals.dtype.kind == "c":
                # (a zero imaginary part is 0, not -0)
                vals = _m._cplx(vals.real, np.where(vals.imag == 0, 0.0, vals.imag)).astype(vals.dtype)
            out = make(x.m, x.n, x.ir, _cols(x), vals) if vals.size == x.pr.size else from_full(r)
            return out
        r = f(nargout, *[full(a) if type(a) is Sparse else a for a in args])
        if type(x) is Sparse and _m._isnumlike(r) and _m.class_(r) in ("double", "single", "logical") and len(_m._dims(r)) == 2:
            return from_full(r)
        return r
    return g


# ------------------------------------------------------------------ reductions and shape

def _dim_arg(S, args):
    """sum(S), sum(S, dim), sum(S, 'all'): 1, 2, 3+ (S itself), "all"; None for other options"""
    if not args:
        return 2 if S.m == 1 else 1
    if len(args) > 1:
        return None
    a = args[0]
    if type(a) is _m.Char or type(a) is _m.Str:
        return "all" if _m._text(a).lower() == "all" else None
    if not _is_scalar(a):
        return None
    d = _m._scalar(a)
    if d != _math.floor(d) or d < 1:
        return None
    return int(d)


def _group_sum(groups, vals, n):
    if vals.dtype.kind == "c":
        return _m._cplx(np.bincount(groups, weights=vals.real, minlength=n), np.bincount(groups, weights=vals.imag, minlength=n))
    return np.bincount(groups, weights=vals, minlength=n)


def _reduced(S, d, vals):
    """a sum along dimension d (1, 2 or "all") as a sparse matrix"""
    k = np.arange(S.n if d == 1 else S.m if d == 2 else 1, dtype=_I)
    z = np.zeros(k.size, dtype=_I)
    if d == 1:
        return make(1, S.n, z, k, vals)
    if d == 2:
        return make(S.m, 1, k, z, vals)
    return make(1, 1, z, z, vals)


def sum_(S, d):
    v = _fvals(S)
    if d == "all":
        r = _reduced(S, d, np.array([_group_sum(np.zeros(v.size, dtype=_I), v, 1)[0]]))
    else:
        r = _reduced(S, d, _group_sum(_cols(S) if d == 1 else S.ir, v, S.n if d == 1 else S.m))
    return _cast(r, "single" if class_(S) == "single" else "double")


def anyall(S, d, is_all):
    v = S.pr.real if S.pr.dtype.kind == "c" else S.pr
    if is_all:
        nz = np.ones(v.size, dtype=bool)
    else:
        nz = ~np.isnan(v) if v.dtype.kind == "f" else np.ones(v.size, dtype=bool)
    if d == "all":
        g, size, full_n = np.zeros(v.size, dtype=_I), 1, S.m * S.n
    elif d == 1:
        g, size, full_n = _cols(S), S.n, S.m
    else:
        g, size, full_n = S.ir, S.m, S.n
    cnt = np.bincount(g[nz], minlength=size) if g.size else np.zeros(size, dtype=_I)
    vals = (cnt == full_n) if is_all else (cnt > 0)
    return _reduced(S, d, vals)


def diag_(S, k=0):
    k = int(k)
    if S.m == 1 or S.n == 1:
        # a vector: the matrix with it on diagonal k
        n = S.m * S.n + abs(k)
        p = _keys(S)
        return make(n, n, p + max(-k, 0), p + max(k, 0), S.pr)
    rows, cols = S.ir, _cols(S)
    on = (cols - rows) == k
    length = max(0, min(S.m + min(k, 0), S.n - max(k, 0)))
    r = rows[on] - max(-k, 0)
    return make(length, 1, r, np.zeros(r.size, dtype=_I), S.pr[on])


def tri(S, k, lower):
    rows, cols = S.ir, _cols(S)
    keep = (cols - rows <= k) if lower else (cols - rows >= k)
    return make(S.m, S.n, rows[keep], cols[keep], S.pr[keep])


def kron_(A, B):
    A, B = _as_sparse(A), _as_sparse(B)
    na, nb = A.pr.size, B.pr.size
    ra, ca = np.repeat(A.ir, nb), np.repeat(_cols(A), nb)
    rb, cb = np.tile(B.ir, na), np.tile(_cols(B), na)
    vals = np.repeat(_fvals(A), nb) * np.tile(_fvals(B), na)
    r = make(A.m * B.m, A.n * B.n, ra * B.m + rb, ca * B.n + cb, vals)
    return r if not (islogical(A) and islogical(B)) else r


def repmat_(S, r, c):
    if r == 0 or c == 0 or not S.pr.size:
        return zeros(S.m * r, S.n * c, S)
    rows, cols = S.ir, _cols(S)
    k = S.pr.size
    br = np.repeat(np.arange(r, dtype=_I), k)
    allr = np.tile(rows, r) + br * S.m
    allc = np.tile(cols, r)
    vals = np.tile(S.pr, r)
    bc = np.repeat(np.arange(c, dtype=_I), allr.size)
    return make(S.m * r, S.n * c, np.tile(allr, c), np.tile(allc, c) + bc * S.n, np.tile(vals, c))


def flip(S, lr):
    rows, cols = S.ir, _cols(S)
    if lr:
        return make(S.m, S.n, rows, S.n - 1 - cols, S.pr)
    return make(S.m, S.n, S.m - 1 - rows, cols, S.pr)


def _size_list(args):
    """reshape's sizes: (m, n), one of them [] for 'whatever fits'"""
    if len(args) == 1:
        d = [float(x) for x in _m._arr(args[0]).reshape(-1)]
        return d
    out = []
    for a in args:
        out.append(None if _m._numel(a) == 0 else float(_m._scalar(a)))
    return out


def _reshape_b(nargout, S, *args):
    if type(S) is not Sparse:
        return _SPARSE_OUT_FN["reshape"](nargout, S, *args)
    d = _size_list(args)
    if len(d) > 2:
        if all(x == 1 for x in d[2:] if x is not None) and None not in d[2:]:
            d = d[:2]
        else:
            raise _err("N-D sparse arrays are not supported.", "MATLAB:reshape:sparseNDmatrix")
    total = S.m * S.n
    if None in d:
        known = [x for x in d if x is not None]
        other = int(known[0]) if known else 1
        d = [total // other if x is None else int(x) for x in d]
    return reshape(S, int(d[0]), int(d[1]))


def _sum_b(nargout, x, *args):
    if type(x) is Sparse:
        d = _dim_arg(x, args)
        if d is not None:
            return x if d not in (1, 2, "all") else sum_(x, d)
    return _SPARSE_OUT_FN["sum"](nargout, x, *args)


def _anyall_b(is_all):
    name = "all" if is_all else "any"

    def g(nargout, x, *args):
        if type(x) is Sparse:
            d = _dim_arg(x, args)
            if d is not None:
                if d not in (1, 2, "all"):
                    return _with(x, x.pr != 0, "logical") if not islogical(x) else x
                return anyall(x, d, is_all)
        return _SPARSE_OUT_FN[name](nargout, x, *args)
    return g


def _mean_b(nargout, x, *args):
    if type(x) is Sparse and x.m * x.n:
        d = _dim_arg(x, args)
        if d in (1, 2, "all"):
            n = x.m if d == 1 else x.n if d == 2 else x.m * x.n
            return binop("rdivide", sum_(x, d), float(n))
    return _SPARSE_OUT_FN["mean"](nargout, x, *args)


def _diag_b(nargout, x, k=0.0):
    if type(x) is Sparse:
        return diag_(x, _m._scalar(k))
    return _SPARSE_OUT_FN["diag"](nargout, x, k)


def _tri_b(lower):
    name = "tril" if lower else "triu"

    def g(nargout, x, k=0.0):
        if type(x) is Sparse:
            return tri(x, int(_m._scalar(k)), lower)
        return _SPARSE_OUT_FN[name](nargout, x, k)
    return g


def _kron_b(nargout, a, b):
    if type(a) is Sparse or type(b) is Sparse:
        for x in (a, b):
            if _m.class_(x) in _m._INTS:
                raise _err("Sparse integer array arithmetic operations are not supported.", "MATLAB:sparseInteger")
        r = kron_(a, b)
        return _cast(r, _m._arith_class(a, b, "times")) if not (islogical(r) and False) else r
    return _FULL["kron"](nargout, a, b)


def _repmat_b(nargout, x, *args):
    if type(x) is Sparse:
        if len(args) == 1:
            d = [int(float(v)) for v in _m._arr(args[0]).reshape(-1)]
            d = d * 2 if len(d) == 1 else d
        else:
            d = [int(_m._scalar(a)) for a in args]
        if len(d) == 2 or all(v == 1 for v in d[2:]):
            return repmat_(x, max(d[0], 0), max(d[1], 0))
    return _SPARSE_OUT_FN["repmat"](nargout, x, *args)


def _flip_b(lr):
    name = "fliplr" if lr else "flipud"

    def g(nargout, x):
        if type(x) is Sparse:
            return flip(x, lr)
        return _FULL[name](nargout, x)
    return g


# built-ins MATLAB keeps sparse, computed on the full matrix: which of their
# outputs are sparse (the others, such as max's indices, full)
_SPARSE_OUT = {
    "prod": (0,), "cumsum": (0,), "cumprod": (0,), "max": (0,), "min": (0,), "median": (0,), "std": (0,),
    "var": (0,), "dot": (0,), "circshift": (0,), "rot90": (0,), "permute": (0,), "squeeze": (0,),
    "blkdiag": (0,), "sort": (0,), "unique": (0,), "sum": (0,), "any": (0,), "all": (0,), "mean": (0,),
    "diag": (0,), "tril": (0,), "triu": (0,), "repmat": (0,), "reshape": (0,),
    "inv": (0,), "lu": (0, 1, 2), "chol": (0,), "qr": (0, 1),
}
_SPARSE_OUT_FN = {}


def _sparse_out(name):
    f = _FULL[name]
    which = _SPARSE_OUT[name]

    def g(nargout, *args):
        if not _has_sparse(args):
            return f(nargout, *args)
        r = f(nargout, *[full(a) if type(a) is Sparse else a for a in args])
        keep = which
        if name == "lu" and any(_m._istext(a) and _m._text(a).lower() == "vector" for a in args):
            keep = (0, 1)  # (a permutation vector is full)
        elif name == "qr" and len(args) > 1 and type(args[1]) is not Sparse and not _m._istext(args[1]) \
                and not _m._qr_econ_flag(args[1]):
            keep = (1,)  # ([C, R] = qr(S, B): C = Q'*B is full for a full B)
        multi = type(r) is list
        outs = r if multi else [r]
        outs = [from_full(o) if k in keep and _m._isnumlike(o) and _m.class_(o) in ("double", "single", "logical")
                and len(_m._dims(o)) == 2 else o for k, o in enumerate(outs)]
        return outs if multi else outs[0]
    return g


def blkdiag_b(nargout, *args):
    """blkdiag(A, B, ...): the matrices along the diagonal; sparse if one is"""
    if not args:
        return np.zeros((0, 0))
    mats = []
    for a in args:
        if not (_m._isnumlike(a) or type(a) is Sparse) or len(_m._dims(a)) > 2:
            raise _err("Inputs must be 2-D numeric or logical arrays.")
        mats.append(_as_sparse(a) if _m.class_(a) in ("double", "single", "logical") else from_full(_m._farr(a)))
    rows, cols, vals = [], [], []
    m = n = 0
    for A in mats:
        rows.append(A.ir + m)
        cols.append(_cols(A) + n)
        vals.append(_fvals(A))
        m += A.m
        n += A.n
    r = make(m, n, np.concatenate(rows), np.concatenate(cols), np.concatenate(vals))
    cls = "single" if any(_m.class_(a) == "single" for a in args) else "double"
    r = _cast(r, cls)
    return r if _has_sparse(args) else full(r)


def _fft_sizes_first(name):
    """fft2, ifft2, fftn and ifftn of a sparse X: the full transform, every argument after X
    checked as sizes before X is made full (only the inverses' text flags, such as
    'symmetric', are left to the full function), so a bad size of any class is refused at once"""
    f = _FULL[name]

    def g(nargout, *args):
        if _has_sparse(args):
            rest = list(args[1:])
            for a in rest:
                if type(a) is Sparse and a.m * a.n > 64:
                    raise _err("%s: a sparse size argument with %d elements is not supported." % (name, a.m * a.n))
            # (the whole signature, as the full function checks it: count, sizes, flag)
            _m._fft_parse(name, [full(a) if type(a) is Sparse else a for a in rest])
            args = [full(a) if type(a) is Sparse else a for a in args]
        return f(nargout, *args)
    return g


_SPECIAL = {
    "sum": _sum_b, "any": _anyall_b(False), "all": _anyall_b(True), "mean": _mean_b, "diag": _diag_b,
    "tril": _tri_b(True), "triu": _tri_b(False), "kron": _kron_b, "repmat": _repmat_b, "reshape": _reshape_b,
    "fliplr": _flip_b(True), "flipud": _flip_b(False),
}


# ------------------------------------------------------------------ linear algebra

# the largest square matrix solved through its full form (beyond, a banded one)
MAX_DENSE_SOLVE = 4000


def bandwidths(S, step=None, charge=None):
    """(lower, upper) bandwidths, scanned in chunks bounded on both axes
    (plan r6 section 2.4a, step 1): at most step (E) columns and at most E
    stored entries per chunk, a column of more than E entries alone in entry
    slices of E, so no call is proportional to n or nnz.  charge(units), if
    given, is told each chunk's work before it is read: its jc entries and
    its stored entries (columns + 1 + entries; a long column's first slice
    counts its jc entry, each slice 1 more), n + K + nnz in all for K
    chunks.  Its peak, four arrays of E indices, is the caller's to reserve"""
    step = step or E
    if not S.pr.size:
        return 0, 0
    n, jc, ir = S.n, S.jc, S.ir
    lo = hi = 0
    c0 = 0
    while c0 < n:
        a = int(jc[c0])
        if int(jc[c0 + 1]) - a > step:
            # (a long column, alone: its column index a scalar)
            b = int(jc[c0 + 1])
            extra = 1
            for s in range(a, b, step):
                t = min(b, s + step)
                if charge is not None:
                    charge((t - s) + 1 + extra)
                extra = 0
                r = ir[s:t]
                lo = max(lo, int(np.max(r)) - c0)
                hi = max(hi, c0 - int(np.min(r)))
            c0 += 1
            continue
        # (the most columns, at most step, whose entries total at most step)
        p = int(np.searchsorted(jc[c0:c0 + step + 1], a + step, "right"))
        c1 = min(n, c0 + p - 1)
        b = int(jc[c1])
        if charge is not None:
            charge((c1 - c0 + 1) + (b - a))
        if b > a:
            cols = np.repeat(np.arange(c0, c1, dtype=_I), np.diff(jc[c0:c1 + 1]))
            d = cols - ir[a:b]
            lo = max(lo, -int(np.min(d)))
            hi = max(hi, int(np.max(d)))
        c0 = c1
    return int(max(0, lo)), int(max(0, hi))


# MASTER'S band solve, kept verbatim as an interim (ruling d2): taken, with
# master's MAX_FULL and MAX_BAND_WORK route, only where the capacity record
# can't admit memory.  Registered to D0, removed with them
def _legacy_band_solve(S, B):
    """S \\ B for a square sparse S of small bandwidth: LU with partial pivoting
    in LAPACK's band storage (gbtrf, then the two triangular solves); B a
    MATLAB-oriented full matrix"""
    n = S.n
    kl, ku = bandwidths(S)
    ldab = 2 * kl + ku + 1
    cplx = S.pr.dtype.kind == "c" or B.dtype.kind == "c"
    dt = np.complex128 if cplx else np.float64
    AB = np.zeros((ldab, n), dtype=dt)
    rows, cols = S.ir, _cols(S)
    AB[kl + ku + rows - cols, cols] = _fvals(S)
    X = np.array(B, dtype=dt)
    piv = np.zeros(n, dtype=_I)
    singular = False
    for k in range(n):
        last = min(n - 1, k + kl)
        col = AB[kl + ku: kl + ku + last - k + 1, k]
        p = int(np.argmax(np.abs(col))) + k
        piv[k] = p
        if AB[kl + ku + p - k, k] == 0:
            singular = True
            continue
        hi = min(n - 1, k + kl + ku)
        cs = np.arange(k, hi + 1, dtype=_I)
        if p != k:
            a = AB[kl + ku + k - cs, cs].copy()
            AB[kl + ku + k - cs, cs] = AB[kl + ku + p - cs, cs]
            AB[kl + ku + p - cs, cs] = a
            X[[k, p]] = X[[p, k]]
        if last > k:
            rs = np.arange(k + 1, last + 1, dtype=_I)
            l = AB[kl + ku + rs - k, k] / AB[kl + ku, k]
            AB[kl + ku + rs - k, k] = l
            if hi > k:
                c2 = cs[1:]
                urow = AB[kl + ku + k - c2, c2]
                AB[kl + ku + rs.reshape((-1, 1)) - c2.reshape((1, -1)), c2.reshape((1, -1))] -= l.reshape((-1, 1)) * urow.reshape((1, -1))
            X[k + 1:last + 1] -= l.reshape((-1, 1)) * X[k].reshape((1, -1))
    if singular:
        _m.warning_("Matrix is singular to working precision.")
    with np.errstate(divide="ignore", invalid="ignore"):
        for k in range(n - 1, -1, -1):
            hi = min(n - 1, k + kl + ku)
            if hi > k:
                c2 = np.arange(k + 1, hi + 1, dtype=_I)
                X[k] -= (AB[kl + ku + k - c2, c2].reshape((-1, 1)) * X[k + 1:hi + 1]).sum(axis=0)
            X[k] /= AB[kl + ku, k]
    return X


# the most multiply-adds a band solve may take (beyond, the sparse LU)
MAX_BAND_WORK = 1 << 29


# master's band route, PR 2's routing floor (the routing amendment r1, variant (d)): _matlab_lu.solve takes band
# at once wherever master's mldivide took band, so no system master bands pays the ordering.  A route only,
# never a refusal: the band path is still admitted by the ledger, and a refused band takes the other path
def legacy_band_route(n, kl, ku):
    return (2 * kl + ku + 1) * n <= MAX_FULL and n * (kl + 1) * (kl + ku + 1) <= MAX_BAND_WORK


# MASTER'S LU, kept verbatim as an interim (@sagebrush's ruling (d) on M1b,
# Oct 26 2026): where the capacity record does not cover the js-heap and
# js-arraybuffer domains (the browser worker today), memory can't be
# admitted, so the LU path keeps master's fixed caps and behaviour (no
# column ordering, refused past MAX_LU_FILL or MAX_LU_WORK) rather than
# refuse everything.  Owner D0; removed when the browser reports a figure
# for those domains (python's D0 follow-up).
# the most a sparse LU factorization may hold (nonzeros of L and U together)
# and do (multiply-adds); a matrix whose factors fill in beyond is refused
MAX_LU_FILL = 1 << 22
MAX_LU_WORK = 1 << 24


class _LU:
    """P*A = L*U for a square sparse A, by columns: at step k row prow[k] of A is
    the pivot, L's column k (unit diagonal) is lrow[k] (A's rows; lstep[k], the
    steps they are pivoted at) with values lval[k], and U's column j is
    ustep[j] (steps before j) with values uval[j] over the diagonal udiag[j]"""

    def solve(self, B, trans=False):
        """A \\ B, or A' \\ B (the conjugate transpose); B an n-by-k full matrix"""
        n = self.n
        dt = np.complex128 if self.udiag.dtype.kind == "c" or B.dtype.kind == "c" else np.float64
        b = np.array(B, dtype=dt).reshape((n, -1))
        with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
            if not trans:
                # (L y = P b, then U x = y)
                y = np.zeros_like(b)
                for k in range(n):
                    y[k] = b[self.prow[k]]
                    if self.lrow[k].size:
                        b[self.lrow[k]] -= self.lval[k].reshape((-1, 1)) * y[k].reshape((1, -1))
                for j in range(n - 1, -1, -1):
                    y[j] /= self.udiag[j]
                    if self.ustep[j].size:
                        y[self.ustep[j]] -= self.uval[j].reshape((-1, 1)) * y[j].reshape((1, -1))
                return y
            # (A' = U' L' P: U' w = b, then L' v = w, then x = P' v)
            w = b
            for j in range(n):
                if self.ustep[j].size:
                    w[j] -= (np.conj(self.uval[j]).reshape((-1, 1)) * w[self.ustep[j]]).sum(axis=0)
                w[j] /= np.conj(self.udiag[j])
            for k in range(n - 1, -1, -1):
                if self.lstep[k].size:
                    w[k] -= (np.conj(self.lval[k]).reshape((-1, 1)) * w[self.lstep[k]]).sum(axis=0)
            x = np.zeros_like(w)
            x[self.prow] = w
            return x


def _too_much_fill(n):
    return _err("Out of memory: the LU factors of this %dx%d sparse matrix fill in too far to solve with it (Sagebrush orders no columns to reduce fill)." % (n, n), "MATLAB:nomem")


def _legacy_lu(S):
    """the LU factorization of a square sparse S, never its full form:
    left-looking, each column by a sparse triangular solve over the steps it
    reaches (as Gilbert and Peierls's; a row in L's column k is pivoted after
    step k, so the steps in increasing order are a topological one), with
    partial pivoting that keeps the diagonal while it is within a factor of 10
    of the largest candidate.  A zero pivot is kept (the solves then give Inf
    or NaN, as MATLAB's do, with its warning)"""
    n = S.n
    dt = np.complex128 if S.pr.dtype.kind == "c" else np.float64
    vals = _fvals(S).astype(dt)
    jc, ir = S.jc, S.ir
    pinv = np.full(n, -1, dtype=_I)
    reached = np.zeros(n, dtype=bool)
    prow = [0] * n
    lrow, lval = [None] * n, [None] * n
    ustep, uval = [None] * n, [None] * n
    udiag = np.zeros(n, dtype=dt)
    x = np.zeros(n, dtype=dt)
    free = 0  # (no row before it is unpivoted)
    fill = work = 0
    for j in range(n):
        a0, a1 = int(jc[j]), int(jc[j + 1])
        rows = ir[a0:a1]
        x[rows] = vals[a0:a1]
        # (the steps this column reaches through L, level by level)
        levels = []
        f = pinv[rows]
        f = f[f >= 0]
        while f.size:
            f = np.unique(f[~reached[f]])
            if not f.size:
                break
            reached[f] = True
            levels.append(f)
            nxt = [lrow[k] for k in f.tolist() if lrow[k].size]
            if not nxt:
                break
            f = pinv[np.concatenate(nxt)]
            f = f[f >= 0]
        order = np.sort(np.concatenate(levels)).tolist() if levels else []
        if levels:
            reached[order] = False
        touched = [rows]
        uv = np.zeros(len(order), dtype=dt)
        for t, k in enumerate(order):
            xk = x[prow[k]]
            uv[t] = xk
            if xk != 0 and lrow[k].size:
                x[lrow[k]] -= lval[k] * xk
            touched.append(lrow[k])
            work += lrow[k].size
        if work > MAX_LU_WORK:
            raise _too_much_fill(n)
        ustep[j] = np.array(order, dtype=_I)
        uval[j] = uv
        allr = np.unique(np.concatenate(touched)) if len(touched) > 1 else np.unique(rows)
        cand = allr[pinv[allr] < 0]
        cv = x[cand]
        amax = float(np.max(np.abs(cv))) if cand.size else 0.0
        if amax > 0:
            if pinv[j] < 0 and abs(x[j]) >= 0.1 * amax:
                p = j
            else:
                p = int(cand[int(np.argmax(np.abs(cv)))])
        else:
            while pinv[free] >= 0:
                free += 1
            p = j if pinv[j] < 0 else int(free)
        pinv[p] = j
        prow[j] = p
        udiag[j] = x[p]
        keep = (cand != p) & (cv != 0)
        lrow[j] = cand[keep]
        lval[j] = cv[keep] / x[p] if amax > 0 else cv[keep]
        x[allr] = 0
        fill += lrow[j].size + len(order) + 1
        if fill > MAX_LU_FILL:
            raise _too_much_fill(n)
    F = _LU()
    F.n = n
    F.prow = np.array(prow, dtype=_I)
    F.lrow, F.lval, F.ustep, F.uval, F.udiag = lrow, lval, ustep, uval, udiag
    F.lstep = [pinv[r] for r in lrow]
    F.singular = bool(np.any(udiag == 0))
    return F


# the capacity module, imported by unmeasured_reason when it first needs it
# (a test seam: a stand-in may be put here)
_capacity = None


def _capacity_record():
    """a fresh capacity record (_capacity imported at the first need)"""
    global _capacity
    if _capacity is None:
        import _capacity
    return _capacity.capacity()


def unmeasured_reason(rec=None):
    """why this host's capacity record can't admit the LU's memory, or None:
    no figure, or one that doesn't cover the js-heap and js-arraybuffer
    domains (Ledger's refusal; _matlab_sparse._sparse_lu then keeps master's
    LU, @sagebrush's interim ruling (d))"""
    global _capacity
    if rec is None and _capacity is None:
        # (imported at the first solve, not at MATLAB mode's start)
        import _capacity
    rec = rec if rec is not None else _capacity.capacity()
    if rec.get("bytes") is None:
        return "no memory figure"
    missing = [d for d in ("js-heap", "js-arraybuffer") if d not in (rec.get("domains") or [])]
    return "the figure doesn't cover %s" % " or ".join(missing) if missing else None


def _sparse_lu(S, q=None):
    """the LU factorization of a square sparse S, never its full form:
    left-looking, each column by a sparse triangular solve over the steps it
    reaches (as Gilbert and Peierls's), its columns in a fill-reducing order
    (an approximate minimum degree ordering of S'*S, internal), with partial
    pivoting that keeps the diagonal while it is within a factor of 10 of
    the largest candidate.  No size or work cap: it reserves its memory
    before each step, Stop interrupts it, and the opt-in limit
    matlab.lu_work bounds its work (lib/_matlab_lu.py).  A zero pivot is
    kept (the solves then give Inf or NaN, as MATLAB's do, with its
    warning).  q: a column order to use instead (a test seam)"""
    if q is None and unmeasured_reason() is not None:
        # (no figure for the JS memory here: master's LU and its caps, _legacy_lu;
        # checked before _matlab_lu is imported, so the browser doesn't fetch
        # its chunk, matlab-lu, for a solve that doesn't use it)
        return _legacy_lu(S)
    import _matlab_lu

    return _matlab_lu.factor(S, "Solving with this %d-by-%d sparse matrix" % (S.n, S.n), q=q)


# the dense route's simultaneous copies, per element of A and of B (full(a),
# full(b), and _matlab's solve's own: its transposed copies, the factored copy,
# the result): A's from M2 (r6 section 2.2: VmHWM - VmRSS over A's bytes, 6.05
# copies at most, real and complex, n = 2000-4000, times 1.25, rounded up); B's
# still PROVISIONAL (M2 measured A's copies with k = 1)
DENSE_A_COPIES = 8
DENSE_B_COPIES = 4


def mldivide(a, b):
    """a \\ b with a sparse a (not scalar): through the full matrix when small;
    beyond, by its diagonal, its band, or its sparse LU factorization, the
    band and the LU chosen by their estimated cost and admitted memory
    (plan-matlab-nocliffs r6 sections 2.4, 2.4a).  Where the capacity record
    can't admit memory (the browser today), master's route and caps, verbatim
    (ruling d2)"""
    A = a
    if A.m != _m._dims(b)[0]:
        raise _err("Matrix dimensions must agree.", "MATLAB:dimagree")
    big = A.m == A.n and A.n > MAX_DENSE_SOLVE
    k = _m._dims(b)[1] if len(_m._dims(b)) > 1 else 1
    cv = 16 if A.pr.dtype.kind == "c" or not isreal(b) else 8
    dense_need = (DENSE_A_COPIES * A.m * A.n + DENSE_B_COPIES * A.m * k) * cv
    if not big and dense_need + 3 * E * 8 * (2 if type(b) is Sparse else 1) <= SMALL_NEED:
        # (exempt: the dense route below, unadmitted; its fills' chunk transients counted; no capacity read)
        return _dense_solve(a, b)
    rec = _capacity_record()
    if unmeasured_reason(rec) is not None:
        return _legacy_mldivide(a, b)
    import _matlab_ledger as LG

    if not big:
        # (the dense route: every simultaneous copy admitted before the first)
        led = LG.Ledger("Solving this %dx%d system" % (A.m, A.n), "this solve", rec=rec)
        led.reserve(dense_need, "dense")
        return _dense_solve(a, b)
    import _matlab_lu as L

    Bm = _m._mat(full(b) if type(b) is Sparse else b)
    what = "Solving this %dx%d sparse system" % (A.n, A.n)
    out = L.solve(A, Bm, what, rec=rec)
    if out is None:
        # (diagonal: each row divided by its element; its arrays admitted)
        led = LG.Ledger(what, rec=rec)
        led.reserve(A.n * cv + 2 * A.n * Bm.shape[1] * cv, "diagonal")
        dvals = np.zeros(A.n, dtype=np.complex128 if A.pr.dtype.kind == "c" else np.float64)
        dvals[A.ir] = _fvals(A)
        if np.any(dvals == 0):
            _m.warning_("Matrix is singular to working precision.")
        with np.errstate(divide="ignore", invalid="ignore"):
            X = Bm / dvals.reshape((-1, 1))
    else:
        X, singular = out
        if singular:
            _m.warning_("Matrix is singular to working precision.")
    r = _m._unmat(X)
    return from_full(r) if type(b) is Sparse else r


def _dense_solve(a, b):
    """the dense route of mldivide: a's and a sparse b's chunked fills, then _matlab's solve"""
    r = _m.mldivide(_m._box(_fill_full(a)), _m._box(_fill_full(b)) if type(b) is Sparse else b)
    return from_full(r) if type(b) is Sparse and _m._isnumlike(r) else r


# MASTER'S mldivide, kept verbatim as an interim (ruling d2, Oct 27 2026):
# its route by MAX_FULL and MAX_BAND_WORK, its band solve and the dense
# route, where the capacity record can't admit memory.  Registered to D0,
# removed with the caps
def _legacy_mldivide(a, b):
    A = a
    if A.m == A.n and A.n > MAX_DENSE_SOLVE and bandwidths(A) == (0, 0):
        # (diagonal: each row divided by its element)
        dvals = np.zeros(A.n, dtype=np.complex128 if A.pr.dtype.kind == "c" else np.float64)
        dvals[A.ir] = _fvals(A)
        if np.any(dvals == 0):
            _m.warning_("Matrix is singular to working precision.")
        Bm = _m._mat(full(b) if type(b) is Sparse else b)
        with np.errstate(divide="ignore", invalid="ignore"):
            X = Bm / dvals.reshape((-1, 1))
        r = _m._unmat(X)
        return from_full(r) if type(b) is Sparse else r
    if A.m == A.n and A.n > MAX_DENSE_SOLVE:
        kl, ku = bandwidths(A)
        Bm = _m._mat(full(b) if type(b) is Sparse else b)
        if (2 * kl + ku + 1) * A.n <= MAX_FULL and A.n * (kl + 1) * (kl + ku + 1) <= MAX_BAND_WORK:
            X = _legacy_band_solve(A, Bm)
        else:
            F = _sparse_lu(A)
            if F.singular:
                _m.warning_("Matrix is singular to working precision.")
            X = F.solve(Bm)
        r = _m._unmat(X)
        return from_full(r) if type(b) is Sparse else r
    r = _m.mldivide(full(a), full(b))
    return from_full(r) if type(b) is Sparse and _m._isnumlike(r) else r


def _eig_b(nargout, x, *args):
    if type(x) is Sparse:
        if x.pr.dtype.kind == "c" or x.m != x.n or nnz(binop("ne", x, transpose(x))) != 0:
            raise _err("Input matrix must be real and symmetric when matrix is sparse. Use eigs to compute a subset of eigenvectors and eigenvalues of a sparse matrix.", "MATLAB:eig:useEigsForSparseStandard")
    return _FULL["eig"](nargout, *[full(a) if type(a) is Sparse else a for a in (x,) + args])


def _svd_b(nargout, x, *args):
    if type(x) is Sparse:
        raise _err("SVD does not support sparse matrices. Use SVDS to compute a subset of the singular values and vectors of a sparse matrix.", "MATLAB:svd:noSVDsparse")
    return _FULL["svd"](nargout, x, *args)


def _norm_b(nargout, x, p=None):
    if type(x) is Sparse:
        vec = x.m == 1 or x.n == 1
        two = p is None or (not _m._istext(p) and _m._scalar(p) == 2)
        if two and not vec:
            raise _err("Sparse norm(S,2) is not available.", "MATLAB:norm:spNorm2notAvailable")
        if not vec and p is not None and not _m._istext(p) and _m._scalar(p) in (1.0, _math.inf):
            # (on the nonzeros: column or row sums of magnitudes)
            d = 1 if _m._scalar(p) == 1 else 2
            v = np.abs(_fvals(x))
            sums = _group_sum(_cols(x) if d == 1 else x.ir, v, x.n if d == 1 else x.m)
            return float(np.max(sums)) if sums.size else 0.0
        if not vec and p is not None and _m._istext(p) and _m._text(p) == "fro":
            v = np.abs(_fvals(x))
            sc = float(np.max(v)) if v.size else 0.0
            return 0.0 if sc == 0 else float(sc * np.sqrt(np.sum((v / sc) ** 2)))
    args = [full(x)] + ([] if p is None else [full(p)])
    return _FULL["norm"](nargout, *args)


def _normest_b(nargout, S, tol=None):
    """[nrm, count] = normest(S, tol): the 2-norm by the power method for
    the p-norm (Higham, "Accuracy and Stability of Numerical Algorithms",
    2nd ed., section 15.2, with p = 2): for a unit vector x, the estimate is
    gamma = ||S x||, and the next x is S'(S x) normalized.  The stopping
    rule is the one MATLAB documents rather than Higham's: the iteration
    ends when two successive estimates agree to within the relative
    tolerance tol (1e-6), the first being compared with 0.  The start is
    the unit vector along ones (or, should S annihilate that, along the
    column of S with the largest norm); MATLAB documents no start, so the
    count can differ from MATLAB's"""
    tol = 1e-6 if tol is None else float(_m._scalar(tol))
    d = _m._dims(S)
    n = d[1] if len(d) == 2 else int(np.prod(d[1:]))
    if n == 0 or (type(S) is Sparse and not S.pr.size):
        return [0.0, 0.0] if nargout > 1 else 0.0
    St = _m.ctranspose(S)

    def mul(M, v):
        r = np.asarray(_m._mat(_m.mtimes(M, _m._unmat(v))))
        return r if r.dtype.kind == "c" else r.astype(np.float64)

    def norm2(v):
        a = np.abs(v)
        top = float(np.max(a)) if a.size else 0.0
        return 0.0 if top == 0 else top * float(np.sqrt(np.sum((a / top) ** 2)))
    x = np.ones((n, 1))
    if norm2(mul(S, x)) == 0:
        cn = (_group_sum(_cols(S), np.abs(_fvals(S)) ** 2, S.n) if type(S) is Sparse
              else np.sum(np.abs(_m._mat(S)) ** 2, axis=0))
        x = np.zeros((n, 1))
        x[int(np.argmax(np.asarray(cn).reshape(-1)))] = 1.0
    x = x / norm2(x)
    previous, count = 0.0, 0
    while True:
        y = mul(S, x)
        gamma = norm2(y)
        count += 1
        if abs(gamma - previous) <= tol * gamma or gamma == 0:
            break
        previous = gamma
        z = mul(St, y)
        nz = norm2(z)
        if nz == 0:
            break
        x = z / nz
        if count >= 1000:
            _m.warning_("normest: no convergence within 1000 iterations to the tolerance %g." % tol)
            break
    return [gamma, float(count)] if nargout > 1 else gamma


def _condest_b(nargout, A, *args):
    """the 1-norm condition number, estimated: norm(A, 1) times Hager's estimate
    of norm(inv(A), 1), which takes a few solves with A and A' (never inv(A);
    a large sparse A by its sparse LU factorization)"""
    d = _m._dims(A)
    if len(d) != 2 or d[0] != d[1]:
        raise _err("Matrix must be square.")
    n = d[0]
    if n == 0:
        return 0.0
    At = _m.ctranspose(A)
    if type(A) is Sparse:
        norm1 = float(np.max(_group_sum(_cols(A), np.abs(_fvals(A)), A.n))) if A.pr.size else 0.0
    else:
        norm1 = float(np.max(np.sum(np.abs(_m._mat(A)), axis=0)))

    if type(A) is Sparse and n > MAX_DENSE_SOLVE:
        # (one factorization, for the solves with A and with A')
        F = _sparse_lu(A)

        def solve(M, v):
            return F.solve(v.reshape((-1, 1)), trans=M is At).reshape(-1)
    else:
        def solve(M, v):
            with np.errstate(all="ignore"):
                r = _m.mldivide(M, _m._unmat(v.reshape((-1, 1))))
            return _m._mat(full(r) if type(r) is Sparse else r).reshape(-1)
    warn = _m.warning_
    _m.warning_ = lambda *a, **k: None  # (the solves' own warnings: the estimate says it)
    try:
        x = np.full(n, 1.0 / n)
        est = 0.0
        for k in range(5):
            y = solve(A, x)
            new = float(np.sum(np.abs(y)))
            if not np.isfinite(new):
                return _math.inf
            if k > 0 and new <= est:
                break
            est = new
            xi = np.where(np.real(y) < 0, -1.0, 1.0)
            z = np.abs(solve(At, xi))
            j = int(np.argmax(z))
            if k > 0 and z[j] <= float(np.real(np.dot(z, x))):
                break
            x = np.zeros(n)
            x[j] = 1.0
    finally:
        _m.warning_ = warn
    return norm1 * est


# ------------------------------------------------------------------ the sparse functions

def _spfun_b(nargout, f, S):
    S = _as_sparse(S)
    r = _m._call(f, [_m._box(np.array(_fvals(S).reshape((1, -1))))])
    vals = _m._arr(r).reshape(-1)
    if vals.size != S.pr.size:
        raise _err("SPFUN: the function must return as many values as it is given.")
    return make(S.m, S.n, S.ir, _cols(S), vals)


def _diag_index(m, n, d):
    """the rows and columns of diagonal d, and each one's row of spdiags's B
    (B's rows go with A's columns when m >= n, else with its rows)"""
    i0, j0 = max(0, -d), max(0, d)
    length = max(0, min(m - i0, n - j0))
    i = np.arange(i0, i0 + length, dtype=_I)
    j = np.arange(j0, j0 + length, dtype=_I)
    return i, j, (j if m >= n else i)


def _spdiags_b(nargout, *args):
    if len(args) <= 2:
        # B = spdiags(A), [B, d] = spdiags(A), B = spdiags(A, d)
        A = _as_sparse(args[0])
        m, n = A.m, A.n
        if len(args) == 2:
            ds = [int(float(x)) for x in _m._arr(args[1]).reshape(-1)]
        else:
            ds = sorted(set(int(x) for x in (_cols(A) - A.ir)[_fvals(A) != 0]))
        k = min(m, n)
        single = class_(A) == "single"
        cplx = A.pr.dtype.kind == "c"
        out = np.zeros((len(ds), k), dtype=(np.complex64 if single else np.complex128) if cplx else (np.float32 if single else np.float64))
        key = _keys(A)
        vals = _fvals(A)
        for c, d in enumerate(ds):
            i, j, b = _diag_index(m, n, d)
            p = j * m + i
            pos = np.searchsorted(key, p)
            pc = np.minimum(pos, max(key.size - 1, 0))
            found = (pos < key.size) & (key[pc] == p) if key.size else np.zeros(p.size, dtype=bool)
            out[c, b[found]] = vals[pc[found]]
        B = _m._box(out) if not single else _m._canon(out)
        if nargout >= 2:
            return [B, _m._box(np.array([[float(d) for d in ds]]))]
        return B
    B = _m._mat(full(args[0]) if type(args[0]) is Sparse else args[0])
    ds = [int(float(x)) for x in _m._arr(args[1]).reshape(-1)]
    if len(args) == 3:
        # S = spdiags(B, d, A): A with diagonals d replaced
        A = _as_sparse(args[2])
        m, n = A.m, A.n
        drop = np.isin(_cols(A) - A.ir, np.array(ds, dtype=_I))
        rows, cols, vals = [A.ir[~drop]], [_cols(A)[~drop]], [_fvals(A)[~drop]]
    else:
        m, n = int(_m._scalar(args[2])), int(_m._scalar(args[3]))
        rows, cols, vals = [], [], []
    if B.ndim == 1:
        B = B.reshape((-1, len(ds)))
    if B.shape[0] == 1 and B.shape[1] in (1, len(ds)):
        # (a scalar or a row, one element per diagonal: each diagonal constant, as spdiags's page
        # allows Bin to be a scalar or vector, only a column or matrix needing min(m, n) rows)
        B = np.repeat(B, max(m, n), axis=0)
    for c, d in enumerate(ds):
        i, j, b = _diag_index(m, n, d)
        ok = b < B.shape[0]
        rows.append(i[ok])
        cols.append(j[ok])
        vals.append(B[b[ok], c if B.shape[1] > 1 else 0])
    return make(m, n, np.concatenate(rows) if rows else np.zeros(0, dtype=_I), np.concatenate(cols) if cols else np.zeros(0, dtype=_I),
                np.concatenate(vals) if vals else np.zeros(0))


def _rand_values(name, k):
    return _m._arr(_m._B[name].f(1, float(k), 1.0)).reshape(-1)


def _sprand(name, args):
    if len(args) == 1:
        S = _as_sparse(args[0])
        return make(S.m, S.n, S.ir, _cols(S), _rand_values(name, S.pr.size) if S.pr.size else np.zeros(0))
    m, n = int(_m._scalar(args[0])), int(_m._scalar(args[1]))
    density = _density(args[2])
    want = int(round(m * n * density)) if m * n else 0
    if want == 0:
        return zeros(m, n)
    # (places drawn with replacement, a repeated one kept once, then their
    # values: consistent with the documented "approximately density*m*n
    # uniformly distributed nonzero entries" and "significantly fewer ... if
    # m*n is small or density is large", and with the published
    # nnz(sprand(500, 1000, 0.1)) of 47663.  The exact places and values are
    # not claimed to be MATLAB's)
    i = _m._arr(_m._B["randi"].f(1, float(m), float(want), 1.0)).reshape(-1).astype(_I) - 1
    j = _m._arr(_m._B["randi"].f(1, float(n), float(want), 1.0)).reshape(-1).astype(_I) - 1
    key = np.unique(i * n + j)
    vals = _rand_values(name, key.size)
    return make(m, n, key // n, key % n, vals)


def _density(d):
    v = _m._scalar(d)
    if not (0.0 <= v <= 1.0):
        raise _err("Density must be between 0 and 1.")
    return v


def _sprand_b(nargout, *args):
    return _sprand("rand", args)


def _sprandn_b(nargout, *args):
    return _sprand("randn", args)


def _sprandsym_b(nargout, n, density=None, *rest):
    if density is None:
        S = _as_sparse(n)
        L = tri(S, 0, True)
        R = make(S.m, S.n, L.ir, _cols(L), _rand_values("randn", L.pr.size))
    else:
        # (distinct places on and below the diagonal, until the matrix and its
        # mirror image have density * n^2 nonzeros)
        n = int(_m._scalar(n))
        want = int(round(_density(density) * n * n))
        keys = np.zeros(0, dtype=_I)
        count = 0
        places = n * (n + 1) // 2
        while count < want:
            if 2 * keys.size >= places:
                # (most places taken: the rest from the ones still free, in a
                # random order, rather than sampling until they turn up)
                free = np.setdiff1d(_lower_keys(n), keys, assume_unique=True)
                order = _m._arr(_m._B["randperm"].f(1, float(free.size))).reshape(-1).astype(_I) - 1
                keys = np.concatenate([keys, free[order]])
                weight = np.where(keys // n == keys % n, 1, 2)
                keys = keys[:int(np.searchsorted(np.cumsum(weight), want)) + 1]
                break
            k = max(16, want - count)
            i = _m._arr(_m._B["randi"].f(1, float(n), float(k), 1.0)).reshape(-1).astype(_I) - 1
            j = _m._arr(_m._B["randi"].f(1, float(n), float(k), 1.0)).reshape(-1).astype(_I) - 1
            lo, hi = np.minimum(i, j), np.maximum(i, j)
            new = hi * n + lo  # (row hi, column lo: on or below the diagonal)
            allk = np.concatenate([keys, new])
            _, first = np.unique(allk, return_index=True)
            keys = allk[np.sort(first)]
            weight = np.where(keys // n == keys % n, 1, 2)
            total = np.cumsum(weight)
            if total.size and total[-1] >= want:
                keys = keys[:int(np.searchsorted(total, want)) + 1]
            count = int(np.sum(np.where(keys // n == keys % n, 1, 2))) if keys.size else 0
            if keys.size >= n * (n + 1) // 2:
                break
        keys = np.sort(keys)
        R = make(n, n, keys // n, keys % n, _rand_values("randn", keys.size) if keys.size else np.zeros(0))
    return binop("plus", R, transpose(tri(R, -1, True)))


def _lower_keys(n):
    """row * n + column of each place on or below the diagonal of an n-by-n matrix"""
    k = np.arange(n * n, dtype=_I)  # (already in order)
    return k[k // n >= k % n]


def _like_proto(args):
    if len(args) >= 2 and _m._istext(args[-2]) and _m._text(args[-2]).lower() == "like":
        return args[-1]
    return None


def _like_fn(name, ok):
    f = _FULL[name]

    def g(nargout, *args):
        proto = _like_proto(args)
        if type(proto) is Sparse:
            if not ok:
                raise _err('Sparse input following "like" is not supported.', "MATLAB:%s:sparsePrototype" % name)
            if name in ("true", "false"):
                # (a logical result, from a logical prototype only, as the pages say: never
                # the prototype's class or complexity)
                if class_(proto) != "logical":
                    raise _err("%s: the prototype following \"like\" must be logical." % name)
                return from_full(f(nargout, *args[:-2]))
            # (the prototype's class and complexity, from its storage)
            r = from_full(f(nargout, *(args[:-2] + (_m.Char(class_(proto)),))))
            if proto.pr.dtype.kind == "c":
                r = _new(r.m, r.n, r.jc, r.ir, r.pr.astype(np.complex64 if class_(proto) == "single" else np.complex128))
            return r
        return f(nargout, *args)
    return g


def _cast_b(nargout, x, *args):
    """cast(x, class), cast(x, 'like', p): p's class, sparsity and complexity"""
    if len(args) == 2 and _m._istext(args[0]) and _m._text(args[0]).lower() == "like":
        p = args[1]
        cls = _m.class_(p)
        pc = (p.pr.dtype.kind == "c") if type(p) is Sparse else (_m._isnumlike(p) and _m._arr(p).dtype.kind == "c")
        if type(x) is Sparse and (type(p) is Sparse or cls in ("double", "single", "logical")):
            # (on the stored values: neither matrix expanded)
            v = x.pr
            if cls == "logical":
                if v.dtype.kind in "fc" and np.any(np.isnan(v)):
                    raise _err("NaN's cannot be converted to logicals.", "MATLAB:nologicalnan")
                v = v != 0
            else:
                single = cls == "single"
                if pc or v.dtype.kind == "c":
                    v = v.astype(np.complex64 if single else np.complex128)
                else:
                    v = v.astype(np.float32 if single else np.float64)
            r = make(x.m, x.n, x.ir, _cols(x), v)
            if pc and r.pr.dtype.kind != "c":
                r = _new(r.m, r.n, r.jc, r.ir, r.pr.astype(np.complex64 if cls == "single" else np.complex128))
            return r if type(p) is Sparse else full(r)
        r = _m._B[cls].f(1, full(x) if type(x) is Sparse else x) if cls in _m._B else x
        if type(p) is Sparse:
            r = from_full(r)
        if pc:
            if type(r) is Sparse:
                r = _new(r.m, r.n, r.jc, r.ir, r.pr.astype(np.complex64 if cls == "single" else np.complex128))
            else:
                a = _m._arr(r)
                r = _m._canon(a.astype(np.complex64 if cls == "single" else np.complex128))
        return r
    if len(args) != 1 or not _m._istext(args[0]):
        raise _err("Unsupported data type for conversion.")
    cls = _m._text(args[0])
    if cls not in _m._B:
        raise _err("Unsupported data type for conversion: '%s'." % cls)
    return _m._B[cls].f(1, x)


def _accumarray_b(nargout, *args):
    sparse_ = len(args) >= 6 and _m._numel(args[5]) == 1 and _m.cond(args[5])
    r = _FULL["accumarray"](nargout, *[full(a) if type(a) is Sparse else a for a in args])
    return from_full(r) if sparse_ else r


# matrix structure: for full matrices too
def _structure(S):
    S = _as_sparse(S)
    return S, S.ir, _cols(S)


def _skew_arg(args, name):
    """issymmetric's and ishermitian's mode: 'nonskew' (the default) or 'skew'"""
    if not args:
        return False
    mode = _m._text(args[0]).lower() if _m._istext(args[0]) else None
    if mode not in ("skew", "nonskew"):
        raise _err("Second input must be 'skew' or 'nonskew'.")
    return mode == "skew"


def _issymmetric_b(nargout, x, *args):
    if not (_m._isnumlike(x) or type(x) is Sparse) or len(_m._dims(x)) > 2:
        return False
    S = _as_sparse(x)
    if S.m != S.n:
        return False
    skew = _skew_arg(args, "issymmetric")
    T = transpose(S)
    return nnz(binop("ne", S, unop("uminus", T) if skew else T)) == 0


def _ishermitian_b(nargout, x, *args):
    if not (_m._isnumlike(x) or type(x) is Sparse) or len(_m._dims(x)) > 2:
        return False
    S = _as_sparse(x)
    if S.m != S.n:
        return False
    skew = _skew_arg(args, "ishermitian")
    T = transpose(S, conj=True)
    return nnz(binop("ne", S, unop("uminus", T) if skew else T)) == 0


def _bandwidth_b(nargout, x, which=None):
    kl, ku = bandwidths(_as_sparse(x))
    if which is not None:
        w = _m._text(which).lower()
        return float(kl if w == "lower" else ku)
    return [float(kl), float(ku)] if nargout > 1 else float(kl)


def _isbanded_b(nargout, x, lower, upper):
    kl, ku = bandwidths(_as_sparse(x))
    return kl <= _m._scalar(lower) and ku <= _m._scalar(upper)


def _istril_b(nargout, x):
    return bandwidths(_as_sparse(x))[1] == 0


def _istriu_b(nargout, x):
    return bandwidths(_as_sparse(x))[0] == 0


def _isdiag_b(nargout, x):
    return bandwidths(_as_sparse(x)) == (0, 0)


# ------------------------------------------------------------------ built-in functions

def _int(x, what="Sparse matrix sizes", clip=False):
    v = _m._scalar(x)
    if clip and v < 0:
        return 0
    if v != v or v != _math.floor(v) or v < 0 or v == _math.inf:
        raise _err("%s must be nonnegative integers." % what)
    return int(v)


def _ijv(x):
    a = _m._arr(index_arg(x))
    return a.reshape(-1)


def sparse_(nargout, *args):
    n = len(args)
    if n == 1:
        return from_full(args[0])
    if n == 2:
        return zeros(_int(args[0]), _int(args[1]))
    if n not in (3, 5, 6):
        raise _err("Too many input arguments." if n > 6 else "Not enough input arguments.")
    iv, jv, vv = (_ijv(a) for a in args[:3])
    if _m.class_(args[2]) not in ("double", "logical"):
        raise _err("Undefined function 'sparse' for input arguments of type '%s'." % _m.class_(args[2]), "MATLAB:UndefinedFunction")
    for v in (iv, jv):
        if v.dtype.kind == "c" or (v.size and (np.any(v != np.floor(v)) or np.any(v < 1))):
            raise _err("Index into matrix must be positive.", "MATLAB:sparsfcn:nonPosIndex") if v.size and np.all(v == np.floor(v)) else \
                _err("Sparse matrix indices must be positive integers.", "MATLAB:sparsfcn:nonIntegerIndex")
    sizes = [v.size for v in (iv, jv, vv)]
    if 0 in sizes and max(sizes) <= 1:
        # (a scalar with an empty: no entries; the scalar indices still give the size)
        k = 0
    else:
        k = max(sizes)
    parts = []
    for v in (iv, jv, vv):
        if v.size not in (1, k) and not (k == 0 and v.size == 1):
            raise _err("Vectors must be the same length.", "MATLAB:samelen")
        parts.append(np.repeat(v, k) if v.size == 1 and k != 1 else v)
    if k == 0:
        m0 = int(np.max(iv)) if iv.size else 0
        n0 = int(np.max(jv)) if jv.size else 0
        iv, jv, vv = (np.zeros(0) for _ in range(3))
    else:
        iv, jv, vv = parts
    if n >= 5:
        m, nn = _int(args[3]), _int(args[4])
        if iv.size and (int(np.max(iv)) > m or int(np.max(jv)) > nn):
            raise _err("Index exceeds array bounds.", "MATLAB:sparsfcn:indexOutOfRange")
    elif k == 0:
        m, nn = m0, n0
    else:
        m = int(np.max(iv)) if iv.size else 0
        nn = int(np.max(jv)) if jv.size else 0
    if m * nn > 2 ** 48 - 1:
        raise _err("Requested %dx%d sparse matrix exceeds the maximum allowed size." % (m, nn))
    if vv.dtype.kind == "c" and not np.any(vv.imag):
        vv = np.array(vv.real)
    S = make(m, nn, iv.astype(_I) - 1, jv.astype(_I) - 1, vv)
    if n == 6:
        S.cap = _int(args[5], "nzmax")
    return S


def full_b(nargout, x):
    return full(x)


def _size_args(args, name):
    if not args:
        return 1, 1
    if len(args) == 1:
        d = [float(x) for x in _m._arr(args[0]).reshape(-1)]
        if len(d) == 1:
            k = _int(d[0], "Size inputs", True)
            return k, k
        if len(d) == 2:
            return _int(d[0], "Size inputs", True), _int(d[1], "Size inputs", True)
        raise _err("N-dimensional sparse arrays are not supported.")
    return _int(args[0], "Size inputs", True), _int(args[1], "Size inputs", True)


def speye_(nargout, *args):
    m, n = _size_args(args, "speye")
    k = np.arange(min(m, n), dtype=_I)
    return make(m, n, k, k, np.ones(k.size))


def spalloc_(nargout, m, n, nzmax=None):
    S = zeros(_int(m), _int(n))
    if nzmax is not None:
        S.cap = _int(nzmax, "nzmax")
    return S


def spones_(nargout, S):
    S = from_full(S, "spones")
    return _new(S.m, S.n, S.jc.copy(), S.ir.copy(), np.ones(S.pr.size))


def issparse_(nargout, x):
    return type(x) is Sparse


def nnz_(nargout, x):
    if type(x) is Sparse:
        return float(nnz(x))
    return _m.nnz_(x)


def nzmax_(nargout, x):
    if type(x) is Sparse:
        return float(nzmax(x))
    return float(_m._numel(x))


def nonzeros_(nargout, x):
    if type(x) is not Sparse:
        a = _m._arr(x).reshape(-1)
        v = a[a != 0]
        return _m._box(np.array(v.reshape((1, -1))))
    return _m._box(np.array(S_vals(x).reshape((1, -1))))


def S_vals(S):
    return S.pr.astype(np.float64) if S.pr.dtype.kind == "b" else S.pr


def find_(nargout, x, k=None, direction=None):
    if type(x) is not Sparse:
        return _FULL["find"](nargout, x, *[a for a in (k, direction) if a is not None])
    S = x
    key = _keys(S)
    vals = S.pr
    sel = np.arange(key.size, dtype=_I)
    if k is not None:
        kk = _int(k, "Second argument")
        d = "first" if direction is None else _m._text(direction, "direction").lower()
        if d not in ("first", "last"):
            raise _err('Invalid search direction. Use "first" or "last".', "MATLAB:find:InvalidDirection")
        last = d == "last"
        sel = sel[-kk:] if last and kk else sel[:kk] if not last else sel[:0]
    key, vals = key[sel], vals[sel]
    row = S.m == 1 and S.n != 1

    def shaped(a):
        a = np.array(a, dtype=np.float64)
        return _m._box(a.reshape((a.size, 1)) if row else a.reshape((1, a.size)))
    if nargout <= 1:
        return shaped(key + 1)
    out = [shaped(key % S.m + 1 if S.m else key), shaped(key // S.m + 1 if S.m else key)]
    if nargout >= 3:
        v = vals
        out.append(_m._box(np.array(v.reshape((v.size, 1)) if row else v.reshape((1, v.size)))))
    return out


def _operator_fn(name):
    f = _FULL[name]
    op = getattr(_m, name)

    def g(nargout, *args):
        if len(args) == 2 and _has_sparse(args):
            return op(*args)
        return f(nargout, *args)
    return g


def _xor(nargout, a, b):
    if type(a) is Sparse or type(b) is Sparse:
        return binop("xor", a, b)
    return _FULL["xor"](nargout, a, b)


def _refusing(name, msg, ident):
    """a built-in MATLAB does not take sparse arguments to"""
    f = _FULL[name]

    def g(nargout, *args):
        if _has_sparse(args):
            raise _err(msg, ident)
        return f(nargout, *args)
    return g


def isreal_(nargout, x):
    if type(x) is Sparse:
        return x.pr.dtype.kind != "c"
    return _FULL["isreal"](nargout, x)


_NATIVE = {
    "sparse": sparse_, "full": full_b, "speye": speye_, "spalloc": spalloc_, "spones": spones_,
    "issparse": issparse_, "nnz": nnz_, "nzmax": nzmax_, "nonzeros": nonzeros_, "find": find_,
    "isreal": isreal_,
}
# built-ins that take a sparse matrix as it is: they ask only its size and
# class, or pass it on
_PASS = set("""size numel length ndims isempty isscalar isvector ismatrix isrow iscolumn issquare class isa
isnumeric isfloat islogical isinteger ischar iscell isstruct isstring iscellstr isobject is_function_handle
disp display feval struct cell deal isfield whos exist clear
plus minus times rdivide ldivide power mtimes mrdivide mldivide mpower eq ne lt le gt ge and or not uminus uplus
transpose ctranspose cat horzcat vertcat""".split())
_FULL = {}  # the built-ins as they were, for full arguments
_active = [False]


def _has_sparse(args):
    for a in args:
        if type(a) is Sparse:
            return True
    return False


def _expanding(b):
    """a built-in that sees sparse arguments as the full matrices they stand for"""
    f = b.f

    def g(nargout, *args):
        if _has_sparse(args):
            args = [full(a) if type(a) is Sparse else a for a in args]
        return f(nargout, *args)
    return g


def activate():
    """(once) make the built-ins take sparse matrices"""
    if _active[0]:
        return
    _active[0] = True
    for name, b in list(_m._B.items()):
        if name in _NATIVE or name in _PASS:
            continue
        _FULL[name] = b.f
        b.f = _expanding(b)


def _register():
    _m._B["blkdiag"] = _m.Builtin(blkdiag_b, "blkdiag")
    for name, f in (("spfun", _spfun_b), ("spdiags", _spdiags_b), ("sprand", _sprand_b), ("sprandn", _sprandn_b),
                    ("sprandsym", _sprandsym_b), ("normest", _normest_b), ("condest", _condest_b), ("cast", _cast_b),
                    ("issymmetric", _issymmetric_b), ("ishermitian", _ishermitian_b), ("bandwidth", _bandwidth_b),
                    ("isbanded", _isbanded_b), ("istril", _istril_b), ("istriu", _istriu_b), ("isdiag", _isdiag_b)):
        if name not in _m._B:
            _m._B[name] = _m.Builtin(f, name)
            _PASS.add(name)
    for name, f in (("eig", _eig_b), ("svd", _svd_b), ("norm", _norm_b), ("accumarray", _accumarray_b)):
        _FULL[name] = _m._B[name].f
        _NATIVE[name] = f
    for name, ok in (("zeros", True), ("ones", True), ("eye", True), ("true", True), ("false", True), ("rand", False), ("randn", False), ("randi", False),
                     ("eps", True), ("realmax", True), ("realmin", True), ("flintmax", True)):
        _FULL[name] = _m._B[name].f
        _NATIVE[name] = _like_fn(name, ok)
    for name in sorted(_ZERO_KEEPING | _SPARSE_FULL):
        if name in _m._B:
            _FULL[name] = _m._B[name].f
            _NATIVE[name] = _elementwise_fn(name)
    for name in _SPARSE_OUT:
        if name in _m._B:
            _FULL[name] = _m._B[name].f
            _SPARSE_OUT_FN[name] = _sparse_out(name)
            _NATIVE[name] = _SPARSE_OUT_FN[name]
    for name in ("fft2", "ifft2", "fftn", "ifftn"):
        _FULL[name] = _m._B[name].f
        _NATIVE[name] = _fft_sizes_first(name)
    for name, f in _SPECIAL.items():
        if name in _m._B:
            _FULL.setdefault(name, _m._B[name].f)
            _NATIVE[name] = f
    for name in ("plus", "minus", "times", "rdivide", "power"):
        _FULL[name] = _m._B[name].f
        _NATIVE[name] = _operator_fn(name)
    for name in list(_m._INTS) + ["char"]:
        _FULL[name] = _m._B[name].f
        _NATIVE[name] = _refusing(name, "Attempt to convert to unimplemented sparse type", "MATLAB:unimplementedSparseType")
    _FULL["arrayfun"] = _m._B["arrayfun"].f
    _NATIVE["arrayfun"] = _refusing("arrayfun", "Sparse inputs are not supported by ARRAYFUN.", "MATLAB:arrayfun:SparseInputNotSupported")
    _NATIVE["xor"] = _xor
    _FULL["xor"] = _m._B["xor"].f
    for name in ("sprintf", "fprintf"):
        _FULL[name] = _m._B[name].f
        _NATIVE[name] = _refusing(name, "Function is not defined for sparse inputs.", "MATLAB:printf:invalidInputAttribute")
    for name, f in _NATIVE.items():
        if name in _m._B:
            _FULL[name] = _m._B[name].f
            _m._B[name].f = f
        else:
            _m._B[name] = _m.Builtin(f, name)


_register()
