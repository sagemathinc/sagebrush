"""MATLAB mode's sparse LU without fixed caps (plan-matlab-nocliffs r6,
sections 2.1-2.3 and 2.8): the fill-reducing column ordering
(_matlab_colamd), memory admission before every growth, the opt-in work
limit matlab.lu_work, and bounded uninterrupted host calls.

- Admission: one fresh capacity() record per operation (Ledger).  The
  record must have a finite figure that covers the js-heap and
  js-arraybuffer domains, else the operation refuses before it allocates
  (memory_guard's unmeasured path).  Every growth reserves its peak live
  bytes against the allowance G before allocating, in one cumulative
  ledger; the transients are released and the kept arrays reconciled at
  their actual sizes.
- Work: matlab.lu_work (unlimited by default) is charged before each chunk
  of work, by category (Work), and refuses before the work is done.
- Host calls: no NumPy element kernel here takes more than E elements (a
  chunk), and no array larger than A_SAFE bytes is allocated in one call
  (alloc: larger ones are segmented, Seg).  Between chunks the Python loops'
  back-edges check for Stop.  The engine's own garbage collection under
  memory pressure is the one exception (William, Oct 25 2026: "with
  several GB of arrays in memory, Stop can lag about 0.1 s per GB").

The constants below are provisional until M1b measures them on both hosts
(r6 section 4): the bytes per entry are each type's worst observed peak
times 1.25, rounded up.
"""

import numpy as np

import _capacity
import _limits
from _memguard import memory_guard
from _matlab import _err
# (the one definition is _matlab_sparse's, which checks it before importing
# this module: the browser then fetches this group only when it runs)
from _matlab_sparse import unmeasured_reason

# (class-1 runtime protection, r6 section 2.8: E_TIME, A_SAFE and E are
# defined once, in _matlab_sparse, whose bandwidth scan uses E too; these
# copies are this module's, which the tests lower)
from _matlab_sparse import E_TIME, A_SAFE, E
# (the first-use fix, plan r3 section 3: Ledger and the one recorder are _matlab_ledger's, so the full and dense
# routes need not import this module; both re-exported here, as before)
from _matlab_ledger import Ledger, _record

# bytes per entry (r6 section 2.2's c_idx, c_bool, c_val, c_re, c_ptr,
# c_pyint, and the per-array and per-list objects): the typed arrays' are
# their itemsizes; the JS-heap objects' are the worst measured on the CLI
# (sys._sagebrush_heap_used after a full collection; provisional: the
# project's host, until M1b's VM run) times 1.25, rounded up: an ndarray
# 427 bytes, a list pointer 9.62 (Node 24), a large Python int 10.4
C_IDX, C_BOOL, C_RE, C_CPLX, C_PTR, C_PYINT = 8, 1, 8, 16, 13, 14
C_HDR, C_LIST = 534, 53
# (Python lists' entries, float 34.6 and complex 50.6 bytes, and a 2-tuple 114)
C_ENT, C_TUPLE = 64, 143

_I = np.int64

# test seams: the phase hook (PHASE markers for the interrupt matrix), the
# work categories, and a recorder of every allocation and kernel size
_phase_hook = None
_categories = None


def _phase(name):
    if _phase_hook is not None:
        _phase_hook(name)


def _cval(dt):
    return C_CPLX if np.dtype(dt).kind == "c" else C_RE


class Work:
    """matlab.lu_work's counter: charge(units) before the work, which refuses
    first when it would pass the limit"""

    def __init__(self, what):
        self.what = what
        self.limit = _limits.finalize()["matlab.lu_work"]
        self.used = 0

    def charge(self, units, cat=None):
        units = int(units)
        if self.used + units > self.limit:
            raise _err("%s is beyond the limit matlab.lu_work (work %d > %d)." % (self.what, self.used + units, self.limit),
                       "sagebrush:lu_work")
        self.used += units
        if _categories is not None and cat is not None:
            _categories[cat] = _categories.get(cat, 0) + units




def chunks(n, step=None):
    """[a, b) slices of range(n), each at most step (E) long"""
    step = step or E
    a = 0
    while a < n:
        b = min(n, a + step)
        yield a, b
        a = b


class Seg:
    """an array larger than one allocation call may take (A_SAFE bytes), as
    blocks of whole rows: indexed like an ndarray by an int, a slice or an
    index array of at most E entries along its first axis, each access split
    by block (r6 section 2.8)"""

    def __init__(self, shape, dtype):
        shape = tuple(shape) if isinstance(shape, (tuple, list)) else (shape,)
        self.shape, self.dtype = shape, np.dtype(dtype)
        self.ndim = len(shape)
        row = self.dtype.itemsize * (shape[1] if len(shape) > 1 else 1)
        self.L = max(1, A_SAFE // max(1, row))
        n = shape[0]
        self.blocks = []
        for a in range(0, n, self.L):
            m = min(self.L, n - a)
            _record("alloc", m * row // self.dtype.itemsize, m * row, None, _kind(self.dtype))
            self.blocks.append(np.zeros((m,) + shape[1:], dtype=self.dtype))

    @property
    def size(self):
        s = 1
        for d in self.shape:
            s *= d
        return s

    def _rows(self, k):
        if isinstance(k, slice):
            a, b, st = k.indices(self.shape[0])
            return np.arange(a, b, st, dtype=_I)
        return np.asarray(k, dtype=_I).reshape(-1)

    def __getitem__(self, k):
        if isinstance(k, (int, np.integer)):
            k = int(k)
            return self.blocks[k // self.L][k % self.L]
        idx = self._rows(k)
        _record("kernel", idx.size)
        out = np.zeros((idx.size,) + self.shape[1:], dtype=self.dtype)
        if idx.size:
            blk = idx // self.L
            for b in np.unique(blk).tolist():
                sel = blk == b
                out[sel] = self.blocks[b][idx[sel] - b * self.L]
        return out

    def __setitem__(self, k, v):
        if isinstance(k, (int, np.integer)):
            k = int(k)
            self.blocks[k // self.L][k % self.L] = v
            return
        idx = self._rows(k)
        _record("kernel", idx.size)
        if not idx.size:
            return
        va = np.asarray(v)
        # (one value per index, or one broadcast to all)
        per = va.ndim == len(self.shape) and va.shape[0] == idx.size
        blk = idx // self.L
        for b in np.unique(blk).tolist():
            sel = blk == b
            self.blocks[b][idx[sel] - b * self.L] = va[sel] if per else v


def alloc(shape, dtype):
    """a zeroed array (pyjs's np.empty is np.zeros: one typed-array
    allocation, zero-filled): one call when it is at most A_SAFE bytes, else
    segmented (Seg)"""
    shape = tuple(shape) if isinstance(shape, (tuple, list)) else (int(shape),)
    count = 1
    for d in shape:
        count *= int(d)
    nbytes = count * np.dtype(dtype).itemsize
    if nbytes > A_SAFE:
        return Seg(shape, dtype)
    _record("alloc", count, nbytes, None, _kind(dtype))
    return np.zeros(shape, dtype=dtype)


def _kind(dt):
    """an allocation's type, as the column formula's parts name them"""
    k = np.dtype(dt).kind
    return "bool" if k == "b" else "idx" if k in "iu" else "val"


def _sort_into(src, r, out, mbuf):
    """src[:r] (distinct step numbers), sorted into out[:r]: runs of at most E
    sorted in place in src, then merged pairwise through windows of at most E
    of each run into mbuf (r6 section 2.8); src and out swap roles each
    pass, so the result is copied into out at the end if it ends in src"""
    for a, b in chunks(r):
        if isinstance(src, Seg):
            run = src[a:b]
            run.sort(kind="quicksort")
            src[a:b] = run
        else:
            src[a:b].sort(kind="quicksort")
    width = E
    cur, nxt = src, out
    while width < r:
        for a in range(0, r, 2 * width):
            m, b = min(r, a + width), min(r, a + 2 * width)
            i, k, o = a, m, a
            while i < m and k < b:
                wa = cur[i:min(i + E, m)]
                wb = cur[k:min(k + E, b)]
                v = min(int(wa[-1]), int(wb[-1]))
                pa = int(np.searchsorted(wa, v, side="right"))
                pb = int(np.searchsorted(wb, v, side="right"))
                w = pa + pb
                np.concatenate((wa[:pa], wb[:pb]), out=mbuf[:w])
                mbuf[:w].sort(kind="quicksort")
                nxt[o:o + w] = mbuf[:w]
                o += w
                i += pa
                k += pb
            for s, t in ((i, m), (k, b)):
                for c, d in chunks(t - s):
                    nxt[o:o + d - c] = cur[s + c:s + d]
                    o += d - c
        cur, nxt = nxt, cur
        width *= 2
    if cur is not out:
        for a, b in chunks(r):
            out[a:b] = cur[a:b]


class LU:
    """P*C = L*U with C = A(:, q), by columns (Gilbert and Peierls's
    left-looking LU with partial pivoting): at step k row prow[k] of A is the
    pivot, L's column k (unit diagonal) is lrow[k] (A's rows; lstep[k], the
    steps they are pivoted at) with values lval[k], and U's column j is
    ustep[j] (steps before j) with values uval[j] over the diagonal
    udiag[j].  q is owned here: solve takes and gives A's own rows and
    columns."""

    def solve(self, B, trans=False):
        """A \\ B, or A' \\ B (the conjugate transpose); B an n-by-k full
        matrix (r6 section 2.1: forward, C y = b then x[q] = y; transposed,
        C' x = b[q]), in blocks of at most E columns, each with row chunks
        of at most E // kc rows, so no kernel takes more than E elements"""
        n = self.n
        Bm = np.asarray(B)
        Bm = Bm.reshape((n, -1))
        k = Bm.shape[1]
        dt = np.complex128 if self.udiag.dtype.kind == "c" or Bm.dtype.kind == "c" else np.float64
        led = self.ledger
        kc = _col_block(k)
        cv = _cval(dt)
        # (x: n-by-k; b and y (or w): n-by-kc each; the step transients, at most E values three times)
        need = (n * k + 2 * n * kc) * cv + 3 * E * cv + 2 * E * C_IDX
        led.reserve(need)
        try:
            with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
                if k == 1:
                    b = alloc((n, 1), dt)
                    self._gather(b, Bm, 0, 1, trans)
                    if _scalar_ok(self, b):
                        return _solve1(self, b, trans, dt)
                    x = np.zeros((n, 1), dtype=dt)
                    self._block(b, x, 0, 1, trans, dt)
                    return x
                # (the result is MATLAB's full matrix: one array, admitted
                # by the caller with the rest of the solve)
                x = np.zeros((n, k), dtype=dt)
                for c0, c1 in chunks(k, kc):
                    b = alloc((n, c1 - c0), dt)
                    self._gather(b, Bm, c0, c1, trans)
                    self._block(b, x, c0, c1, trans, dt)
                    del b
                return x
        finally:
            led.release(need)

    def _gather(self, b, Bm, c0, c1, trans):
        """b = B(:, c0:c1), its rows gathered by q when transposed (A' = Q C':
        C' x = Q' b), in chunks of at most E elements"""
        n, kc, whole = self.n, c1 - c0, c1 - c0 == Bm.shape[1]
        # (a block of a wider B is taken a row at a time: its kc <= E elements)
        rows = max(1, E // kc) if whole else 1
        q = self.q
        for a, c in chunks(n, rows):
            self.work.charge((c - a) * kc, "solve")
            _record("kernel", (c - a) * kc)
            if whole:
                b[a:c] = Bm[np.asarray(q[a:c])] if trans else Bm[a:c]
            else:
                b[a] = Bm[int(q[a]) if trans else a, c0:c1]

    def _block(self, b, x, c0, c1, trans, dt):
        """x(:, c0:c1) from the gathered block b (overwritten), at most E
        columns: every copy, update, reduction and scatter in chunks of at
        most rows = E // kc rows, and charged per chunk"""
        n, work = self.n, self.work
        kc = c1 - c0
        whole = kc == x.shape[1]
        rows = max(1, E // kc)
        flat = self.flat and not isinstance(b, Seg)
        if not trans:
            y = alloc((n, kc), dt)
            flat = flat and not isinstance(y, Seg)
            prow = self.prow_l if flat else None
            for s in range(n):
                ys = b[prow[s]] if flat else b[int(self.prow[s])]
                y[s] = ys
                lr, lv = self.lrow[s], self.lval[s]
                sz = lr.size
                if sz:
                    if flat and sz <= rows:
                        work.charge(sz * kc, "solve")
                        _record("kernel", sz * kc)
                        b[lr] -= lv.reshape((-1, 1)) * ys
                    else:
                        ys = np.asarray(ys).reshape((1, -1))
                        for a, c in chunks(sz, rows):
                            work.charge((c - a) * kc, "solve")
                            _record("kernel", (c - a) * kc)
                            b[lr[a:c]] = b[lr[a:c]] - lv[a:c].reshape((-1, 1)) * ys
            for j in range(n - 1, -1, -1):
                yj = y[j] / self.udiag[j]
                y[j] = yj
                us, uv = self.ustep[j], self.uval[j]
                sz = us.size
                if sz:
                    if flat and sz <= rows:
                        work.charge(sz * kc, "solve")
                        _record("kernel", sz * kc)
                        y[us] -= uv.reshape((-1, 1)) * yj
                    else:
                        yj = np.asarray(yj).reshape((1, -1))
                        for a, c in chunks(sz, rows):
                            work.charge((c - a) * kc, "solve")
                            _record("kernel", (c - a) * kc)
                            y[us[a:c]] = y[us[a:c]] - uv[a:c].reshape((-1, 1)) * yj
            dst, src = self.q, y
        else:
            w = b
            for j in range(n):
                us, uv = self.ustep[j], self.uval[j]
                sz = us.size
                if sz:
                    if flat and sz <= rows:
                        work.charge(sz * kc, "solve")
                        _record("kernel", sz * kc)
                        w[j] -= (np.conj(uv).reshape((-1, 1)) * w[us]).sum(axis=0)
                    else:
                        acc = np.zeros(kc, dtype=dt)
                        for a, c in chunks(sz, rows):
                            work.charge((c - a) * kc, "solve")
                            _record("kernel", (c - a) * kc)
                            acc = acc + (np.conj(uv[a:c]).reshape((-1, 1)) * w[us[a:c]]).sum(axis=0)
                        w[j] = w[j] - acc
                w[j] = w[j] / np.conj(self.udiag[j])
            for s in range(n - 1, -1, -1):
                ls, lv = self.lstep[s], self.lval[s]
                sz = ls.size
                if sz:
                    if flat and sz <= rows:
                        work.charge(sz * kc, "solve")
                        _record("kernel", sz * kc)
                        w[s] -= (np.conj(lv).reshape((-1, 1)) * w[ls]).sum(axis=0)
                    else:
                        acc = np.zeros(kc, dtype=dt)
                        for a, c in chunks(sz, rows):
                            work.charge((c - a) * kc, "solve")
                            _record("kernel", (c - a) * kc)
                            acc = acc + (np.conj(lv[a:c]).reshape((-1, 1)) * w[ls[a:c]]).sum(axis=0)
                        w[s] = w[s] - acc
            dst, src = self.prow, w
        # (the scatter: x[q] = y forward, x[prow] = w transposed; a row at a
        # time into a wider x, as _gather)
        for a, c in chunks(n, rows if whole else 1):
            work.charge((c - a) * kc, "solve")
            _record("kernel", (c - a) * kc)
            if whole:
                x[np.asarray(dst[a:c])] = src[a:c]
            else:
                x[int(dst[a]), c0:c1] = src[a]


def _col_block(k):
    """the solve's column block: at most E columns (a test seam)"""
    return min(k, E)


def _scalar_ok(F, b):
    """whether _solve1's scalar path may take b: a flat factor, and b itself
    one array (a real factor with a complex right-hand side can segment b)"""
    return F.flat and not isinstance(b, Seg)


def _conj(v):
    return v.conjugate() if isinstance(v, complex) else v


def _solve1(F, b, trans, dt):
    """one right-hand side, b an n-by-1 array (overwritten): the short
    columns in Python scalars, the long ones by NumPy in chunks of E (the same
    operations, in the same order, as solve's)"""
    n, work = F.n, F.work
    b1 = b.reshape(n)
    ud = F.udiag
    if not trans:
        y = np.zeros(n, dtype=dt)
        for s in range(n):
            ys = b1[F.prow_l[s]]
            y[s] = ys
            lr = F.lrow_l[s]
            if lr is _BIG:
                lk, lv = F.lrow[s], F.lval[s]
                for a, c in chunks(lk.size):
                    work.charge(c - a, "solve")
                    b1[lk[a:c]] = b1[lk[a:c]] - lv[a:c] * ys
            elif lr:
                work.charge(len(lr), "solve")
                for i, v in zip(lr, F.lval_l[s]):
                    b1[i] = b1[i] - v * ys
        for j in range(n - 1, -1, -1):
            yj = y[j] / ud[j]
            y[j] = yj
            us = F.ustep_l[j]
            if us is _BIG:
                uk, uv = F.ustep[j], F.uval[j]
                for a, c in chunks(uk.size):
                    work.charge(c - a, "solve")
                    y[uk[a:c]] = y[uk[a:c]] - uv[a:c] * yj
            elif us:
                work.charge(len(us), "solve")
                for i, v in zip(us, F.uval_l[j]):
                    y[i] = y[i] - v * yj
        x = np.zeros((n, 1), dtype=dt)
        q = F.q
        for a, c in chunks(n):
            work.charge(c - a, "solve")
            x[np.asarray(q[a:c]), 0] = y[a:c]
        return x
    # (A' = Q C', C' = U' L' P: U' w = b[q], then L' v = w, then x = P' v)
    w = b1
    for j in range(n):
        us = F.ustep_l[j]
        if us is _BIG:
            uk, uv = F.ustep[j], F.uval[j]
            acc = 0
            for a, c in chunks(uk.size):
                work.charge(c - a, "solve")
                acc = acc + (np.conj(uv[a:c]) * w[uk[a:c]]).sum()
            w[j] = w[j] - acc
        elif us:
            work.charge(len(us), "solve")
            acc = 0
            for i, v in zip(us, F.uval_l[j]):
                acc = acc + _conj(v) * w[i]
            w[j] = w[j] - acc
        w[j] = w[j] / _conj(ud[j]) if dt == np.complex128 else w[j] / ud[j]
    for s in range(n - 1, -1, -1):
        ls = F.lstep_l[s]
        if ls is _BIG:
            lk, lv = F.lstep[s], F.lval[s]
            acc = 0
            for a, c in chunks(lk.size):
                work.charge(c - a, "solve")
                acc = acc + (np.conj(lv[a:c]) * w[lk[a:c]]).sum()
            w[s] = w[s] - acc
        elif ls:
            work.charge(len(ls), "solve")
            acc = 0
            for i, v in zip(ls, F.lval_l[s]):
                acc = acc + _conj(v) * w[i]
            w[s] = w[s] - acc
    x = np.zeros((n, 1), dtype=dt)
    pr = F.prow
    for a, c in chunks(n):
        work.charge(c - a, "solve")
        x[np.asarray(pr[a:c]), 0] = w[a:c]
    return x


def ordering(S, led, work, stats=None):
    """the fill-reducing column order of the square sparse S (_matlab_colamd's,
    a Python list), its workspace reserved before it runs and released when it
    returns; q itself stays reserved (its bytes returned with it: the caller
    releases them when q is dropped or replaced, factor's qheld).  stats gets
    the ordering's fill estimate (order_columns)"""
    import _matlab_colamd

    _phase("ordering")
    n, m = S.n, S.m
    nnz = int(S.jc[n])
    Nn = n + m
    ord_bytes = C_ENT * (3 * nnz + 10 * Nn + 6 * n) + C_LIST * (m + 3 * n) + C_TUPLE * (2 * n + 16)
    # (the ordering's result, a Python list: held from before the ordering
    # until its typed copy qa replaces it)
    qheld = C_LIST + n * C_ENT
    led.reserve(ord_bytes + qheld, "ordering")
    try:
        q = _matlab_colamd.order_columns(m, n, S.jc, S.ir, lambda u: work.charge(u, "ordering"), stats)
    except BaseException:
        led.release(qheld)
        raise
    finally:
        led.release(ord_bytes)
    _record("list", n, led.owned, "q")
    return q, qheld


def factor(S, what, q=None, ledger=None, work=None, order=True, qheld=0):
    """the LU of the square sparse S (an LU, with its ledger and work
    counter): its columns ordered by _matlab_colamd unless q is given (a
    test seam, or the router's order, then with its reserved bytes qheld) or
    order is False (the identity)"""
    n = S.n
    led = ledger or Ledger(what)
    work = work or Work(what)
    jc, ir, pr = S.jc, S.ir, S.pr
    dt = np.complex128 if pr.dtype.kind == "c" else np.float64
    cv = _cval(dt)
    if q is None and order:
        q, qheld = ordering(S, led, work)
    led.reserve(n * C_IDX + C_HDR)
    if q is None:
        qa = alloc(n, _I)
        for a, b in chunks(n):
            qa[a:b] = np.arange(a, b, dtype=_I)
    else:
        qa = _seg_from_list(q)
    _record("held", n, led.owned, "q")
    q = None
    led.release(qheld)
    _phase("lu")
    # the workspace and the kept state, before the first column (r6 section 2.2's B_0)
    kpeak = _kpeak(cv)
    # (pinv, queue, rbuf; mark; udiag, x; the _OUTER lists of n pointers; prow's ints; mbuf)
    parts = {"idx": 3 * n * C_IDX + 2 * E * C_IDX, "bool": n * C_BOOL, "val": 2 * n * cv, "ptr": _OUTER * n * C_PTR,
             "pyint": n * C_PYINT, "kpeak": kpeak, "hdr": 5 * C_HDR}
    led.reserve(sum(parts.values()), "workspace", parts)
    pinv = alloc(n, _I)
    for a, b in chunks(n):
        pinv[a:b] = -1
    mark = alloc(n, bool)
    queue = alloc(n, _I)
    rbuf = alloc(n, _I)
    udiag = alloc(n, dt)
    x = alloc(n, dt)
    mbuf = np.zeros(2 * E, dtype=_I)
    # (whole-array fast paths when nothing is segmented and a piece fits E)
    flat = not isinstance(pinv, Seg)
    prow = _plist(n, 0)
    lrow, lval = _plist(n), _plist(n)
    # (L's and U's columns also as Python lists, for the small columns' scalar
    # path; _BIG past SMALL entries, which that path never scans)
    lrow_l, lval_l = _plist(n), _plist(n)
    ustep, uval = _plist(n), _plist(n)
    ustep_l, uval_l = _plist(n), _plist(n)
    free = 0
    for j in range(n):
        c = int(qa[j])
        a0, a1 = int(jc[c]), int(jc[c + 1])
        na = a1 - a0
        # (the column into x)
        work.charge(na, "input")
        for a, b in chunks(na):
            x[ir[a0 + a:a0 + b]] = pr[a0 + a:a0 + b]
        # a and b. the reach and the touched rows' union, in one pass: a row
        # touched for the first time (marked, into rbuf) is the one event that
        # reaches a new step, its pivot step (into queue, unsorted); the lists
        # are scanned in batches of at most E entries (one list, or several
        # concatenated and made distinct)
        work.charge(na, "reach")
        work.charge(na, "union")
        r = t = h = 0
        if flat and na <= SMALL:
            # (a small column, first in Python scalars, which cost about a
            # tenth of a NumPy call each in pyjs: the same reach, while the
            # lists scanned total at most SMALL entries)
            touched = ir[a0:a1].tolist()
            seen = set(touched)
            steps = [v for v in (int(pinv[i]) for i in touched) if v >= 0]
            room = SMALL - na
            while h < len(steps):
                lk = lrow_l[steps[h]]
                if len(lk) > room:
                    break
                room -= len(lk)
                h += 1
                if lk:
                    work.charge(len(lk), "reach")
                    work.charge(len(lk), "union")
                    for i in lk:
                        if i not in seen:
                            seen.add(i)
                            touched.append(i)
                            v = int(pinv[i])
                            if v >= 0:
                                steps.append(v)
            if h == len(steps):
                free = _small_column(j, c, steps, touched, x, pinv, prow, udiag, lrow, lval, lrow_l, lval_l, ustep, uval,
                                     ustep_l, uval_l, dt, cv, led, work, free)
                continue
            # (past SMALL: the state so far into the arrays, and on with NumPy)
            r, t = len(steps), len(touched)
            ta = np.array(touched, dtype=_I)
            mark[ta] = True
            rbuf[:t] = ta
            queue[:r] = np.array(steps, dtype=_I)
        else:
            for a, b in chunks(na):
                r, t = _visit(ir[a0 + a:a0 + b], pinv, mark, rbuf, t, queue, r)
        while h < r:
            parts, tot = [], 0
            while h < r:
                lk = lrow[int(queue[h])]
                s = lk.size
                if not s:
                    h += 1
                elif s > E:
                    if parts:
                        break
                    h += 1
                    work.charge(s, "reach")
                    work.charge(s, "union")
                    for a, b in chunks(s):
                        rc = lk[a:b]
                        r, t = _visit(rc, pinv, mark, rbuf, t, queue, r)
                elif tot + s > E and parts:
                    break
                else:
                    parts.append(lk)
                    tot += s
                    h += 1
            if parts:
                work.charge(tot, "reach")
                work.charge(tot, "union")
                u = parts[0] if len(parts) == 1 else np.unique(np.concatenate(parts))
                r, t = _visit(u, pinv, mark, rbuf, t, queue, r)
        # c. the column's peak, reserved before anything of it is built
        parts = {"idx": C_IDX * (3 * r + 3 * t), "val": cv * (r + 2 * t), "re": C_RE * t, "bool": C_BOOL * t,
                 "ptr": C_PTR * r, "hdr": 6 * C_HDR}
        Bj = sum(parts.values())
        try:
            led.reserve(Bj, "column", parts)
        except BaseException:
            for a, b in chunks(t):
                mark[rbuf[a:b]] = False
                x[rbuf[a:b]] = 0
            raise
        # d. the order: increasing step numbers (topological, as each row of
        # L's column k is pivoted after step k)
        work.charge(r * max(0, (r - 1).bit_length()), "sort")
        if flat and r <= E:
            us = np.sort(queue[:r])
        else:
            srt = alloc(r, _I)
            for a, b in chunks(r):
                srt[a:b] = queue[a:b]
            us = alloc(r, _I)
            _sort_into(srt, r, us, mbuf)
            del srt
        # e. the numeric updates, in that order
        uv = alloc(r, dt)
        steps = us.tolist() if flat else None
        for s in range(r):
            k = steps[s] if flat else int(us[s])
            xk = x[prow[k]]
            uv[s] = xk
            if xk != 0:
                lk = lrow[k]
                sz = lk.size
                if sz:
                    work.charge(sz, "numeric")
                    if sz <= E and flat:
                        x[lk] -= lval[k] * xk
                    else:
                        lv = lval[k]
                        for a, b in chunks(sz):
                            x[lk[a:b]] = x[lk[a:b]] - lv[a:b] * xk
        ustep[j], uval[j] = us, uv
        if flat and r <= SMALL:
            ustep_l[j], uval_l[j] = steps, uv.tolist()
        else:
            ustep_l[j], uval_l[j] = _BIG, _BIG
        # the candidates (the touched rows not yet pivoted), and the pivot:
        # row q[j], A's diagonal, while within a factor of 10 of the largest;
        # else the largest, the smallest row among equals
        work.charge(t, "pivot")
        if flat and t <= E:
            allr = rbuf[:t]
            cand = allr[pinv[allr] < 0]
            nc = cand.size
            cvals = x[cand]
            av = np.abs(cvals)
            pmag = float(np.max(av)) if nc else 0.0
            best = int(np.min(cand[av == pmag])) if pmag > 0 else -1
        else:
            cand = alloc(t, _I)
            nc = 0
            for a, b in chunks(t):
                rc = rbuf[a:b]
                cc = rc[pinv[rc] < 0]
                if cc.size:
                    cand[nc:nc + cc.size] = cc
                    nc += cc.size
            cvals = alloc(nc, dt)
            pmag, best = 0.0, -1
            for a, b in chunks(nc):
                cc = cand[a:b]
                vv = x[cc]
                cvals[a:b] = vv
                av = np.abs(vv)
                mx = float(np.max(av)) if av.size else 0.0
                if mx > 0:
                    rmin = int(np.min(cc[av == mx]))
                    if mx > pmag:
                        pmag, best = mx, rmin
                    elif mx == pmag and rmin < best:
                        best = rmin
        if pmag > 0:
            p = c if int(pinv[c]) < 0 and abs(x[c]) >= 0.1 * pmag else best
        else:
            while int(pinv[free]) >= 0:
                free += 1
            p = c if int(pinv[c]) < 0 else int(free)
        pinv[p] = j
        prow[j] = p
        xp = x[p]
        udiag[j] = xp
        # L's column: the other candidates with a nonzero, over the pivot
        if flat and t <= E:
            keep = (cand != p) & (cvals != 0)
            lr = cand[keep]
            lvj = cvals[keep] / xp if pmag > 0 else cvals[keep]
            cnt = lr.size
        else:
            keep = alloc(nc, bool)
            cnt = 0
            for a, b in chunks(nc):
                kk = (cand[a:b] != p) & (cvals[a:b] != 0)
                keep[a:b] = kk
                cnt += int(np.count_nonzero(kk))
            lr = alloc(cnt, _I)
            lvj = alloc(cnt, dt)
            o = 0
            for a, b in chunks(nc):
                kk = keep[a:b]
                cc = cand[a:b][kk]
                if cc.size:
                    lr[o:o + cc.size] = cc
                    lvj[o:o + cc.size] = cvals[a:b][kk] / xp if pmag > 0 else cvals[a:b][kk]
                    o += cc.size
        lrow[j], lval[j] = lr, lvj
        if flat and cnt <= SMALL:
            lrow_l[j], lval_l[j] = lr.tolist(), lvj.tolist()
        else:
            lrow_l[j], lval_l[j] = _BIG, _BIG
        del cand, cvals, keep
        # f. reset the workspace; the column's transients leave the ledger
        if flat and t <= E:
            mark[allr] = False
            x[allr] = 0
        else:
            for a, b in chunks(t):
                mark[rbuf[a:b]] = False
                x[rbuf[a:b]] = 0
        x[p] = 0
        led.release(Bj)
        led.reserve(C_IDX * (r + cnt) + cv * (r + cnt) + 4 * C_HDR + (2 * C_ENT * cnt if cnt <= SMALL else 0)
                    + (2 * C_ENT * r if r <= SMALL else 0), "retain")
    # lstep: the steps L's rows are pivoted at, for the transposed solve
    nl = sum(int(v.size) for v in lrow)
    led.reserve(C_IDX * nl + n * C_PTR + n * C_HDR)
    lstep = [None] * n
    for k in range(n):
        lk = lrow[k]
        if flat and lk.size <= E:
            lstep[k] = pinv[lk]
            continue
        out = alloc(lk.size, _I)
        for a, b in chunks(lk.size):
            out[a:b] = pinv[lk[a:b]]
        lstep[k] = out
    F = LU()
    F.n = n
    F.q = qa
    led.reserve(n * C_IDX + C_HDR)
    F.prow = _seg_from_list(prow)
    F.lrow, F.lval, F.ustep, F.uval, F.udiag, F.lstep = lrow, lval, ustep, uval, udiag, lstep
    # (the scalar solves' lists: the short columns', _BIG for the others)
    F.flat = flat
    if flat:
        led.reserve(C_ENT * (2 * n + nl))
        F.prow_l = prow
        F.lrow_l, F.lval_l, F.ustep_l, F.uval_l = lrow_l, lval_l, ustep_l, uval_l
        F.lstep_l = [v if v is _BIG else [int(pinv[i]) for i in v] for v in lrow_l]
    sing = False
    for a, b in chunks(n):
        if bool(np.any(np.asarray(udiag[a:b]) == 0)):
            sing = True
            break
    F.singular = sing
    F.ledger, F.work = led, work
    return F


# a small column's scanned entries (the scalar path) and the marker of an L
# column too long for it
SMALL = 64
_BIG = [0] * (SMALL + 1)


def _small_column(j, c, steps, touched, x, pinv, prow, udiag, lrow, lval, lrow_l, lval_l, ustep, uval, ustep_l, uval_l, dt, cv,
                  led, work, free):
    """column j's steps c to f in Python scalars (its reach and touched rows
    already found, at most SMALL entries scanned): the same order, updates and
    pivot rule as the NumPy path; returns the free-row pointer"""
    r, t = len(steps), len(touched)
    Bj = C_IDX * (3 * r + 3 * t) + cv * (r + 2 * t) + C_RE * t + C_BOOL * t + C_PTR * r + 6 * C_HDR + 4 * C_ENT * (r + t)
    try:
        led.reserve(Bj, "column")
    except BaseException:
        for i in touched:
            x[i] = 0
        raise
    work.charge(r * max(0, (r - 1).bit_length()), "sort")
    steps.sort()
    uvl = []
    for k in steps:
        xk = x[prow[k]]
        uvl.append(xk)
        if xk != 0:
            lk = lrow_l[k]
            if lk:
                work.charge(len(lk), "numeric")
                for i, v in zip(lk, lval_l[k]):
                    x[i] = x[i] - v * xk
    work.charge(t, "pivot")
    cand = [i for i in touched if int(pinv[i]) < 0]
    cvals = [x[i] for i in cand]
    mags = [abs(v) for v in cvals]
    pmag = float(max(mags)) if mags else 0.0
    if pmag > 0:
        if int(pinv[c]) < 0 and abs(x[c]) >= 0.1 * pmag:
            p = c
        else:
            p = min(i for i, m in zip(cand, mags) if m == pmag)
    else:
        while int(pinv[free]) >= 0:
            free += 1
        p = c if int(pinv[c]) < 0 else int(free)
    pinv[p] = j
    prow[j] = p
    xp = x[p]
    udiag[j] = xp
    lr = [i for i, v in zip(cand, cvals) if i != p and v != 0]
    lv = [v / xp if pmag > 0 else v for i, v in zip(cand, cvals) if i != p and v != 0]
    lrow[j] = np.array(lr, dtype=_I)
    lval[j] = np.array(lv, dtype=dt)
    lrow_l[j], lval_l[j] = lr, lv
    ustep[j] = np.array(steps, dtype=_I)
    uval[j] = np.array(uvl, dtype=dt)
    ustep_l[j], uval_l[j] = steps, uvl
    for i in touched:
        x[i] = 0
    x[p] = 0
    cnt = len(lr)
    led.release(Bj)
    led.reserve(C_IDX * (r + cnt) + cv * (r + cnt) + 4 * C_HDR + 2 * C_ENT * (cnt + r), "retain")
    return free


# the outer lists of n pointers factor keeps (B_0's ptr part): prow, lrow,
# lval, ustep, uval and the scalar path's lrow_l, lval_l, ustep_l, uval_l
_OUTER = 9


def _plist(n, fill=None):
    """one of factor's outer lists of n pointers (reserved in B_0's ptr part)"""
    _record("list", n, 0, "outer")
    return [fill] * n


def _kpeak(cv):
    """the per-chunk allowance, in bytes: the largest simultaneous mix of a
    column's kernels at E entries (r6 section 2.2's K_max; the reach and the
    union include their batch's concatenation and np.unique's sort copy)"""
    # (a batch: its concatenation and np.unique's sort copy and result, the
    # mark gather, its negation, the new rows, their steps, the mask, the
    # pivoted steps)
    reach = 7 * E * C_IDX + 3 * E * C_BOOL
    union = 0
    numeric = 3 * E * cv + E * C_IDX
    merge = 0
    route = (5 * E * C_IDX + E * C_BOOL + E * cv) if A_SAFE < (1 << 62) else 0
    return max(reach, union, numeric, merge) + route


def _visit(rows, pinv, mark, rbuf, t, queue, r):
    """distinct rows (at most E): those not marked yet are marked and appended
    to rbuf, and the steps of the pivoted ones among them to queue (a step's
    row is touched at most once, so each step is queued at most once)"""
    new = rows[~mark[rows]]
    if new.size:
        mark[new] = True
        rbuf[t:t + new.size] = new
        t += new.size
        g = pinv[new]
        g = g[g >= 0]
        if g.size:
            queue[r:r + g.size] = g
            r += g.size
    return r, t


def _seg_from_list(v):
    s = alloc(len(v), _I)
    for a, b in chunks(len(v)):
        s[a:b] = np.asarray(v[a:b], dtype=_I)
    return s


# ------------------------------------------------------------------ the band path

def _get2(T, r, c):
    """T[r, c], r and c index arrays of one shape (at most E entries), T an
    ndarray or a Seg of row blocks (each block's entries in one call)"""
    _record("kernel", r.size)
    if not isinstance(T, Seg):
        return T[r, c]
    rf, cf = r.reshape(-1), c.reshape(-1)
    if not rf.size:
        return np.zeros(r.shape, dtype=T.dtype)
    b0, b1 = int(np.min(rf)) // T.L, int(np.max(rf)) // T.L
    if b0 == b1:
        # (the usual case: the chunk's rows in one block)
        return T.blocks[b0][rf - b0 * T.L, cf].reshape(r.shape)
    out = np.zeros(rf.size, dtype=T.dtype)
    if bool(np.all(rf[1:] >= rf[:-1])):
        # (rows in order, as every band chunk's are: one slice per block)
        cut = np.searchsorted(rf, np.arange(b0 + 1, b1 + 1, dtype=_I) * T.L).tolist()
        for i, (a, z) in enumerate(zip([0] + cut, cut + [rf.size])):
            if z > a:
                b = b0 + i
                out[a:z] = T.blocks[b][rf[a:z] - b * T.L, cf[a:z]]
        return out.reshape(r.shape)
    blk = rf // T.L
    for b in np.unique(blk).tolist():
        sel = blk == b
        out[sel] = T.blocks[b][rf[sel] - b * T.L, cf[sel]]
    return out.reshape(r.shape)


def _set2(T, r, c, v):
    """T[r, c] = v (v of r's shape), as _get2"""
    _record("kernel", r.size)
    if not isinstance(T, Seg):
        T[r, c] = v
        return
    rf, cf, vf = r.reshape(-1), c.reshape(-1), np.asarray(v).reshape(-1)
    if not rf.size:
        return
    b0, b1 = int(np.min(rf)) // T.L, int(np.max(rf)) // T.L
    if b0 == b1:
        T.blocks[b0][rf - b0 * T.L, cf] = vf
        return
    if bool(np.all(rf[1:] >= rf[:-1])):
        cut = np.searchsorted(rf, np.arange(b0 + 1, b1 + 1, dtype=_I) * T.L).tolist()
        for i, (a, z) in enumerate(zip([0] + cut, cut + [rf.size])):
            if z > a:
                b = b0 + i
                T.blocks[b][rf[a:z] - b * T.L, cf[a:z]] = vf[a:z]
        return
    blk = rf // T.L
    for b in np.unique(blk).tolist():
        sel = blk == b
        T.blocks[b][rf[sel] - b * T.L, cf[sel]] = vf[sel]


def _band_kpeak(cv, seg):
    """the band path's per-step allowance, in bytes: the largest simultaneous
    mix of one step's chunked kernels (r6 section 2.2's band rows, each
    capped at E entries by section 2.8): the factor update's row and column
    index matrices and its column range (3E indices) with its gather, outer
    product, difference and the U row (4E values); a Seg's block routing
    (the block numbers, a mask, the selected indices and values) besides"""
    route = (3 * E * C_IDX + E * C_BOOL + E * cv) if seg else 0
    return 3 * E * C_IDX + 4 * E * cv + route


def band_need(n, kl, ku, k, cplx):
    """M_band, the band path's bytes (r6 section 2.2's band phases), with its
    parts: the persistent arrays (AB, n by 2 kl + ku + 1; X, n by min(k, E)
    columns at a time, and the n by k result when k > E or X is segmented;
    piv), setup's chunked peak, the step allowance; segmented storage's block
    descriptors when an array passes A_SAFE.  None when one band column, the
    storage's row, would pass A_SAFE alone (segmented storage splits by rows):
    the band path isn't available, a route, not a refusal (LU remains)"""
    cv = C_CPLX if cplx else C_RE
    ldab = 2 * kl + ku + 1
    if ldab * cv > A_SAFE:
        return None
    kc = min(k, E)
    ab, xb = n * ldab * cv, n * kc * cv
    seg = ab > A_SAFE or xb > A_SAFE

    def s0(nbytes):
        nb = -(-nbytes // A_SAFE) if nbytes > A_SAFE else 0
        return C_LIST + nb * (C_PTR + C_HDR) if nb else 0

    result = n * k * cv if (k > E or xb > A_SAFE) else 0
    persistent = ab + xb + result + n * C_IDX + s0(ab) + s0(xb) + 4 * C_HDR
    setup = 5 * E * C_IDX + E * cv + ((3 * E * C_IDX + E * C_BOOL + E * cv) if seg else 0)
    step = _band_kpeak(cv, seg)
    return {"persistent": persistent, "setup": setup, "step": step}


def band_solve(S, B, kl, ku, ledger, work):
    """S \\ B for a square sparse S of bandwidths (kl, ku): LU with partial
    pivoting in LAPACK's band storage (gbtrf, then the two triangular solves,
    the same operations in the same order as master's _band_solve), B an
    n-by-k full matrix.  The band is stored by columns, AB[c, kl+ku+i-c]
    holding A(i, c) (2 kl + ku + 1 per column, room for the pivoting's fill),
    so each step's rows and columns are contiguous rows of AB.  Every kernel
    takes at most E elements: setup by entry chunks (as bandwidths), the
    factor update by blocks of rows and columns, the right-hand sides in
    blocks of at most E columns; the multiply-adds charged to matlab.lu_work
    per chunk, before it; the memory reserved by phase (band_need).  Returns
    the n-by-k solution and whether a zero pivot was met"""
    n = S.n
    led, work = ledger, work
    Bm = np.asarray(B).reshape((n, -1))
    k = Bm.shape[1]
    cplx = S.pr.dtype.kind == "c" or Bm.dtype.kind == "c"
    dt = np.complex128 if cplx else np.float64
    cv = _cval(dt)
    need = band_need(n, kl, ku, k, cplx)
    assert need is not None, "a band column past A_SAFE: the route takes LU"
    dg = kl + ku
    ldab = 2 * kl + ku + 1
    _phase("band")
    led.reserve(need["persistent"] + need["setup"], "band")
    T = alloc((n, ldab), dt)
    piv = alloc(n, _I)
    # setup: A's entries into AB, by chunks of at most E columns and E entries
    jc, ir, pr = S.jc, S.ir, S.pr
    c0 = 0
    while c0 < n:
        a = int(jc[c0])
        if int(jc[c0 + 1]) - a > E:
            b = int(jc[c0 + 1])
            for s in range(a, b, E):
                t = min(b, s + E)
                rows = ir[s:t]
                cols = np.zeros(t - s, dtype=_I) + c0
                _set2(T, cols, dg + rows - cols, pr[s:t].astype(dt))
            c0 += 1
            continue
        p = int(np.searchsorted(jc[c0:c0 + E + 1], a + E, "right"))
        c1 = min(n, c0 + p - 1)
        b = int(jc[c1])
        if b > a:
            cols = np.repeat(np.arange(c0, c1, dtype=_I), np.diff(jc[c0:c1 + 1]))
            _set2(T, cols, dg + ir[a:b] - cols, pr[a:b].astype(dt))
        c0 = c1
    led.release(need["setup"])
    led.reserve(need["step"], "band-step")
    try:
        singular = _band_factor(T, piv, n, kl, ku, work)
        X = _band_rhs(T, piv, Bm, n, kl, ku, k, dt, work)
    finally:
        led.release(need["step"])
    return X, singular


def _band_factor(T, piv, n, kl, ku, work):
    """gbtrf on the column-stored band T (in place), piv[k] the pivot row of
    step k, or -1 where the column was zero (the step skipped, as master's):
    whether such a zero pivot was met"""
    dg = kl + ku
    singular = False
    for k in range(n):
        last = min(n - 1, k + kl)
        hi = min(n - 1, k + kl + ku)
        rowk = T[k]
        # the pivot: the first largest magnitude of the column, from the diagonal down
        m = last - k + 1
        if m <= E:
            p = int(np.argmax(np.abs(rowk[dg:dg + m]))) + k
        else:
            p, best = k, -1.0
            for a, b in chunks(m):
                av = np.abs(rowk[dg + a:dg + b])
                i = int(np.argmax(av))
                if float(av[i]) > best:
                    p, best = k + a + i, float(av[i])
        if rowk[dg + p - k] == 0:
            piv[k] = -1
            singular = True
            continue
        piv[k] = p
        if p != k:
            # rows k and p swapped over columns k..hi: A(r, c) is T[c, dg + r - c]
            for a, b in chunks(hi - k + 1):
                cs = np.arange(k + a, k + b, dtype=_I)
                u = _get2(T, cs, dg + k - cs)
                v = _get2(T, cs, dg + p - cs)
                _set2(T, cs, dg + k - cs, v)
                _set2(T, cs, dg + p - cs, u)
            rowk = T[k]
        if last > k:
            nl = last - k
            d = rowk[dg]
            for a, b in chunks(nl):
                rowk[dg + 1 + a:dg + 1 + b] = rowk[dg + 1 + a:dg + 1 + b] / d
            if hi > k:
                # A(i, c) -= l_i A(k, c) for i in k+1..last, c in k+1..hi, by
                # blocks of at most E entries (rows of L by E, columns by E // rows)
                for a, b in chunks(nl):
                    li = rowk[dg + 1 + a:dg + 1 + b]
                    ni = b - a
                    ri = np.arange(k + 1 + a, k + 1 + b, dtype=_I).reshape((1, -1))
                    for c0, c1 in chunks(hi - k, max(1, E // ni)):
                        cs = np.arange(k + 1 + c0, k + 1 + c1, dtype=_I)
                        work.charge(cs.size * ni, "band")
                        urow = _get2(T, cs, dg + k - cs)
                        R = cs.reshape((-1, 1)) + np.zeros((1, ni), dtype=_I)
                        C = dg + ri - cs.reshape((-1, 1))
                        g = _get2(T, R, C)
                        _set2(T, R, C, g - urow.reshape((-1, 1)) * li.reshape((1, -1)))
    return singular


def _band_rhs(T, piv, Bm, n, kl, ku, k, dt, work):
    """the factored band's two triangular solves on B (n by k): the pivots
    and L's multipliers applied in step order, then U backwards; in blocks of
    at most E columns, each with row chunks of at most E // kc rows"""
    dg = kl + ku
    kc = min(k, E)
    whole = kc == k
    out = None
    for q0, q1 in chunks(k, kc):
        w = q1 - q0
        rows = max(1, E // w)
        # (the block's work array, at most n by kc: band_need's X)
        X = alloc((n, w), dt)
        if out is None:
            out = X if whole and not isinstance(X, Seg) else np.zeros((n, k), dtype=dt)
        for a, b in chunks(n, rows if whole else 1):
            if whole:
                X[a:b] = Bm[a:b]
            else:
                X[a] = Bm[a, q0:q1]
        for s in range(n):
            p = int(piv[s])
            if p < 0:
                continue
            if p != s:
                t = np.array(X[s])
                X[s] = X[p]
                X[p] = t
            last = min(n - 1, s + kl)
            if last > s:
                rowk = T[s]
                xs = np.asarray(X[s]).reshape((1, -1))
                for a, b in chunks(last - s, rows):
                    work.charge((b - a) * w, "band")
                    l = rowk[dg + 1 + a:dg + 1 + b].reshape((-1, 1))
                    X[s + 1 + a:s + 1 + b] = X[s + 1 + a:s + 1 + b] - l * xs
        with np.errstate(divide="ignore", invalid="ignore"):
            for s in range(n - 1, -1, -1):
                hi = min(n - 1, s + kl + ku)
                if hi > s:
                    acc = np.zeros(w, dtype=dt)
                    for a, b in chunks(hi - s, rows):
                        work.charge((b - a) * w, "band")
                        cs = np.arange(s + 1 + a, s + 1 + b, dtype=_I)
                        u = _get2(T, cs, dg + s - cs).reshape((-1, 1))
                        acc = acc + (u * X[s + 1 + a:s + 1 + b]).sum(axis=0)
                    X[s] = X[s] - acc
                X[s] = X[s] / T[s][dg]
        if out is not X:
            for a, b in chunks(n, rows if whole else 1):
                if whole:
                    out[a:b] = X[a:b]
                else:
                    out[a, q0:q1] = X[a]
    return out


# ------------------------------------------------------------------ the route (r6 sections 2.4, 2.4a)

# the routing estimate's timing constants per host (seconds per unit; r6
# section 2.4 with M2's delta 1): T_band = step n + band n (kl+1)(kl+ku+1),
# T_lu = ord nnz + lu s_hat.
# PROVISIONAL until M2 fits them on the benchmark VM (least squares through
# the origin, both hosts); a heuristic: it never changes the problem solved,
# and admission doesn't rely on it
COSTS = {
    "cli": {"step": 1e-4, "band": 1.8e-7, "ord": 9.2e-6, "lu": 8.4e-6},
    "browser": {"step": 1e-4, "band": 1.8e-7, "ord": 9.2e-6, "lu": 8.4e-6},
}

# test seam: the path each solve took ("band" or "lu"), appended
_routes = None


def _costs():
    import _memguard

    return COSTS.get(_memguard.where(), COSTS["cli"])


def _route(path):
    if _routes is not None:
        _routes.append(path)


# the slow-LU warning (William, Oct 28 2026, on the n = 4000/4001 boundary:
# decision A, a known cost, "but ... we should output a warning"): an LU
# estimated (t_lu, the route's own estimate) to take at least SLOW_LU_WARN_S
# seconds warns before its factorization starts, through MATLAB's warning
# machinery: shown once per session per n (no flood in a loop), silenced by
# warning('off', SLOW_LU_ID), recorded by lastwarn, re-armed by
# warning('on', SLOW_LU_ID) or warning('on', 'all').  It changes no result
# and no route; the browser's interim (master's route) never reaches it
SLOW_LU_WARN_S = 10.0
SLOW_LU_ID = "sagebrush:mldivide:slowSparseLU"


def _warn_slow(n, t_lu):
    if t_lu < SLOW_LU_WARN_S:
        return
    import _matlab as _m
    import _matlab_sparse as _sp

    _m.warning_once("Solving this %dx%d sparse system by its sparse LU, whose factors fill in heavily: it may take "
                    "minutes, and Stop works throughout.  (A banded system, or one of order %d or less, is solved "
                    "faster.)" % (n, n, _sp.MAX_DENSE_SOLVE), SLOW_LU_ID, n)


def solve(S, Bm, what, bands=None, rec=None):
    """S \\ Bm for a square sparse S, n > MAX_DENSE_SOLVE, by its band or its
    sparse LU (r6 section 2.4a): the bandwidths found in chunks (their
    workspace reserved first; refused, the band path is unknown, not
    impossible); the band path's need M_band; band at once when it is
    admitted and master's route takes band (the amendment r1 floor) or it is
    cheaper than LU's lower bound c_ord nnz; else the ordering
    (admitted, or band if band fits), then band if admitted and cheaper than
    the LU estimated from the ordering's fill (q dropped first), else the
    LU, which, refused part way, leaves the ledger as before it and falls
    back to band if band fits.  Refused only when no path can be admitted,
    once, with both needs.  Returns (X, singular), or None for a diagonal S
    (the caller's shortcut); bands, a seam, gives (kl, ku) instead; rec, the
    operation's capacity record when the caller has read it (one per operation)"""
    n = S.n
    led = Ledger(what, rec=rec)
    work = Work(what)
    k = Bm.shape[1]
    cplx = S.pr.dtype.kind == "c" or Bm.dtype.kind == "c"
    nnz = int(S.jc[n])
    c = _costs()
    import _matlab_sparse as _sp

    # 1. the bandwidths, then the band path's need
    kl = ku = None
    m_band = None
    band_ok = False
    disc = 4 * E * C_IDX
    try:
        led.reserve(disc, "discovery")
    except MemoryError:
        pass
    else:
        kl, ku = bands if bands is not None else _sp.bandwidths(S, E, lambda u: work.charge(u, "discovery"))
        led.release(disc)
        if (kl, ku) == (0, 0):
            return None
        nb = band_need(n, kl, ku, k, cplx)
        if nb is not None:
            m_band = nb["persistent"] + max(nb["setup"], nb["step"])
            band_ok = led.owned + m_band <= led.G
    t_band = c["step"] * n + c["band"] * n * (kl + 1) * (kl + ku + 1) if kl is not None else None

    def band():
        _route("band")
        return band_solve(S, Bm, kl, ku, led, work)

    def refuse(lu_need):
        needs = [v for v in (m_band, lu_need) if v is not None]
        raise memory_guard("Solving this %dx%d sparse system (its band path needs %s bytes, its LU at least %s)"
                           % (n, n, "an unknown number of" if m_band is None else m_band,
                              "an unknown number of bytes" if lu_need is None else "%d bytes" % lu_need),
                           min(needs) if needs else 0, led.G, led.allowance_for, record=led.rec)

    # 2. band without the ordering: where master's route takes band (the
    # amendment r1 floor: no sunk ordering), or where it beats LU's lower bound
    if band_ok and (_sp.legacy_band_route(n, kl, ku) or t_band <= c["ord"] * nnz):
        return band()
    # 3. and 4. the ordering, admitted, then the estimate
    stats = {}
    try:
        q, qheld = ordering(S, led, work, stats)
    except MemoryError as e:
        if band_ok:
            return band()
        refuse(getattr(e, "need_bytes", None))
    t_lu = c["ord"] * nnz + c["lu"] * stats.get("fill", 0)
    if band_ok and t_band < t_lu:
        q = None
        led.release(qheld)
        return band()
    # 5. the LU, falling back to band if it can't be admitted part way; a
    # slow one warns first, before its factorization starts
    _warn_slow(n, t_lu)
    before = led.owned - qheld
    try:
        F = factor(S, what, q=q, ledger=led, work=work, qheld=qheld)
    except MemoryError as e:
        q = F = None
        led.owned = before
        if band_ok and led.owned + m_band <= led.G:
            return band()
        refuse(getattr(e, "need_bytes", None))
    _route("lu")
    return F.solve(Bm), F.singular
