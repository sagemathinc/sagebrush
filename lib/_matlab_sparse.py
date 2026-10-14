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


# ------------------------------------------------------------------ storage

def _new(m, n, jc, ir, pr):
    S = Sparse.__new__(Sparse)
    S.m, S.n, S.jc, S.ir, S.pr = m, n, jc, ir, pr
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


def zeros(m, n, logical=False):
    return _new(m, n, np.zeros(n + 1, dtype=_I), np.zeros(0, dtype=_I), np.zeros(0, dtype=bool if logical else np.float64))


def _too_big(m, n):
    gb = m * n * 8 / 2.0 ** 30
    return _err("Requested %dx%d (%.1fGB) array exceeds maximum array size preference. Creation of arrays greater "
                "than this limit may take a long time and cause MATLAB to become unresponsive." % (m, n, gb),
                "MATLAB:array:SizeLimitExceeded")


def full_arr(S):
    """the full matrix S stands for, stored as _matlab stores arrays (transposed)"""
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
        return zeros(S.n, S.m, islogical(S))
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
        wr = max(9 if _m._format["num"] != "long" else 20, max(len(p[0]) for p in parts) + 2)
        wi = max(max(len(p[2]) for p in parts), len(f(1.0)) + 1)
        texts = ["%s %s%si" % (p[0].rjust(wr), p[1], p[2].rjust(wi)) for p in parts]
        w = wr + wi + 3 - (_m._format["num"] == "long")
        if scale:
            body.append("   %s *" % scale)
    else:
        nf = _m._NumFmt(vals.reshape((-1, 1)), nz == 1, _m._format["num"] == "long")
        texts = [nf.fmt(float(x)) for x in vals]
        w = nf.width
        longest = max(len(t) for t in texts)
        if longest + 2 > w:
            w = longest + 3 if nf.kind == "int" else longest + 2
        if nf.scale is not None:
            body.append("   %s *" % nf.scale_text)
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
        return zeros(I.size, J.size, islogical(S))
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
    vals = S.pr.real if S.pr.dtype.kind == "c" else S.pr
    if vals.dtype.kind == "f" and np.any(np.isnan(vals)):
        raise _err("NaN's cannot be converted to logicals.", "MATLAB:nologicalnan")
    return True


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
        return (sa and sb) or (sa and _is_scalar(b)) or (sb and _is_scalar(a))
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
    if name == "mpower" and _is_scalar(b) and not _is_scalar(a):
        p = _m._scalar(b)
        if p == _math.floor(p) and p >= 0:
            if a.m != a.n:
                raise _err("Incorrect dimensions for raising a matrix to a power. Check that the matrix is square and the power is a scalar. To operate on each element of the matrix individually, use POWER (.^) for elementwise power.")
            k = np.arange(a.n, dtype=_I)
            R = make(a.n, a.n, k, k, np.ones(a.n))
            A = a
            p = int(p)
            while p:
                if p & 1:
                    R = _matmul(R, A)
                A = _matmul(A, A)
                p >>= 1
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
    k = max(iv.size, jv.size, vv.size)
    parts = []
    for v in (iv, jv, vv):
        if v.size not in (1, k):
            raise _err("Vectors must be the same length.", "MATLAB:samelen")
        parts.append(np.repeat(v, k) if v.size == 1 and k != 1 else v)
    iv, jv, vv = parts
    if n >= 5:
        m, nn = _int(args[3]), _int(args[4])
        if iv.size and (int(np.max(iv)) > m or int(np.max(jv)) > nn):
            raise _err("Index exceeds array bounds.", "MATLAB:sparsfcn:indexOutOfRange")
    else:
        m = int(np.max(iv)) if iv.size else 0
        nn = int(np.max(jv)) if jv.size else 0
    if m * nn > 2 ** 48 - 1:
        raise _err("Requested %dx%d sparse matrix exceeds the maximum allowed size." % (m, nn))
    if vv.dtype.kind == "c" and not np.any(vv.imag):
        vv = np.array(vv.real)
    return make(m, nn, iv.astype(_I) - 1, jv.astype(_I) - 1, vv)


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
    return zeros(_int(m), _int(n))


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
        return float(max(nnz(x), 1))
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
        last = direction is not None and _m._text(direction, "direction").lower() == "last"
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
transpose ctranspose""".split())
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
    for name in sorted(_ZERO_KEEPING | _SPARSE_FULL):
        if name in _m._B:
            _FULL[name] = _m._B[name].f
            _NATIVE[name] = _elementwise_fn(name)
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
