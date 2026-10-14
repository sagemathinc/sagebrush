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


# ------------------------------------------------------------------ built-in functions

def _int(x, what="Sparse matrix sizes"):
    v = _m._scalar(x)
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
    if not _m._isnumlike(x) and type(x) is not Sparse:
        raise _err("Undefined function 'full' for input arguments of type '%s'." % _m.class_(x), "MATLAB:UndefinedFunction")
    return full(x)


def _size_args(args, name):
    if not args:
        return 1, 1
    if len(args) == 1:
        d = [float(x) for x in _m._arr(args[0]).reshape(-1)]
        if len(d) == 1:
            k = _int(d[0], "Size inputs")
            return k, k
        if len(d) == 2:
            return _int(d[0], "Size inputs"), _int(d[1], "Size inputs")
        raise _err("N-dimensional sparse arrays are not supported.")
    return _int(args[0], "Size inputs"), _int(args[1], "Size inputs")


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


def _no_sparse(name):
    f = _FULL.get(name)

    def g(nargout, *args):
        if _has_sparse(args):
            raise _err("Function is not defined for sparse inputs.", "MATLAB:printf:invalidInputAttribute")
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
disp display feval struct cell deal isfield whos exist clear""".split())
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
    for name in ("sprintf", "fprintf"):
        _FULL[name] = _m._B[name].f
        _NATIVE[name] = _no_sparse(name)
    for name, f in _NATIVE.items():
        if name in _m._B:
            _FULL[name] = _m._B[name].f
            _m._B[name].f = f
        else:
            _m._B[name] = _m.Builtin(f, name)


_register()
