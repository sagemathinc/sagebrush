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

# (class-1 runtime protection, r6 section 2.8: the largest uninterrupted
# NumPy element kernel and the largest single allocation; E = min(E_TIME,
# A_SAFE / 32) so that every block holds whole chunks of every dtype and
# every kernel's output, at most 2E elements of 16 bytes, fits one call)
E_TIME = 1 << 16
A_SAFE = 1 << 31
E = min(E_TIME, A_SAFE // 32)
assert A_SAFE >= 32 * E

# bytes per entry (provisional; r6 section 2.2's c_idx, c_bool, c_val, c_re,
# c_ptr, c_pyint, and the per-array and per-list objects)
C_IDX, C_BOOL, C_RE, C_CPLX, C_PTR, C_PYINT = 8, 1, 8, 16, 8, 16
C_HDR, C_LIST = 256, 64
# (the ordering's Python lists: an entry, a list object, a heap tuple)
C_ENT, C_TUPLE = 16, 64

_I = np.int64

# test seams: the phase hook (PHASE markers for the interrupt matrix), the
# work categories, and a recorder of every allocation and kernel size
_phase_hook = None
_categories = None
_recorder = None


def _phase(name):
    if _phase_hook is not None:
        _phase_hook(name)


def _cval(dt):
    return C_CPLX if np.dtype(dt).kind == "c" else C_RE


class Ledger:
    """one operation's memory: the fresh capacity record, the allowance G,
    and the bytes it owns (reserve before each growth, release after)"""

    def __init__(self, what, allowance_for="this sparse solve"):
        self.what, self.allowance_for = what, allowance_for
        rec = _capacity.capacity()
        self.rec = rec
        missing = [d for d in ("js-heap", "js-arraybuffer") if d not in (rec.get("domains") or [])]
        if rec.get("bytes") is None:
            self.unmeasured = "no memory figure"
        elif missing:
            self.unmeasured = "the figure doesn't cover %s" % " or ".join(missing)
        else:
            self.unmeasured = None
        g = None if self.unmeasured else _capacity.effective_guard_bytes(rec)
        self.G = int(g) if g is not None else 0
        self.owned = 0
        self.peak = 0

    def reserve(self, nbytes, tag=None, parts=None):
        nbytes = max(0, int(nbytes))
        need = self.owned + nbytes
        _record("reserve", need, nbytes, tag, parts)
        if self.unmeasured is not None:
            raise memory_guard(self.what, need, 0, self.allowance_for, record=self.rec, unmeasured=self.unmeasured)
        if need > self.G:
            raise memory_guard(self.what, need, self.G, self.allowance_for, record=self.rec)
        self.owned = need
        self.peak = max(self.peak, need)

    def release(self, nbytes):
        self.owned = max(0, self.owned - max(0, int(nbytes)))


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


def _record(kind, n, nbytes=0, tag=None, extra=None):
    if _recorder is not None:
        _recorder.append((kind, int(n), int(nbytes), tag, extra))


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
        C' x = b[q])"""
        n = self.n
        Bm = np.asarray(B)
        Bm = Bm.reshape((n, -1))
        k = Bm.shape[1]
        dt = np.complex128 if self.udiag.dtype.kind == "c" or Bm.dtype.kind == "c" else np.float64
        led, work = self.ledger, self.work
        rows = max(1, E // max(1, k))
        cv = _cval(dt)
        # (b, y or w, and x: n-by-k each; the step transients, at most E values three times)
        need = 3 * n * k * cv + 3 * E * cv + 2 * E * C_IDX
        led.reserve(need)
        try:
            b = alloc((n, k), dt)
            q = self.q
            if trans:
                # (A' = Q C': C' x = Q' b, so b is gathered by q)
                for a, c in chunks(n, rows):
                    b[a:c] = Bm[np.asarray(q[a:c])]
            else:
                for a, c in chunks(n, rows):
                    b[a:c] = Bm[a:c]
            with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
                if k == 1 and self.flat:
                    return _solve1(self, b, trans, dt)
                flat = self.flat and not isinstance(b, Seg)
                if not trans:
                    y = alloc((n, k), dt)
                    flat = flat and not isinstance(y, Seg)
                    prow = self.prow_l if flat else None
                    for s in range(n):
                        ys = b[prow[s]] if flat else b[int(self.prow[s])]
                        y[s] = ys
                        lr, lv = self.lrow[s], self.lval[s]
                        sz = lr.size
                        if sz:
                            work.charge(sz * k, "solve")
                            if flat and sz <= rows:
                                b[lr] -= lv.reshape((-1, 1)) * ys
                            else:
                                ys = np.asarray(ys).reshape((1, -1))
                                for a, c in chunks(sz, rows):
                                    b[lr[a:c]] = b[lr[a:c]] - lv[a:c].reshape((-1, 1)) * ys
                    for j in range(n - 1, -1, -1):
                        yj = y[j] / self.udiag[j]
                        y[j] = yj
                        us, uv = self.ustep[j], self.uval[j]
                        sz = us.size
                        if sz:
                            work.charge(sz * k, "solve")
                            if flat and sz <= rows:
                                y[us] -= uv.reshape((-1, 1)) * yj
                            else:
                                yj = np.asarray(yj).reshape((1, -1))
                                for a, c in chunks(sz, rows):
                                    y[us[a:c]] = y[us[a:c]] - uv[a:c].reshape((-1, 1)) * yj
                    # (the result is MATLAB's full matrix: one array, admitted
                    # by the caller with the rest of the solve)
                    x = np.zeros((n, k), dtype=dt)
                    for a, c in chunks(n, rows):
                        x[np.asarray(q[a:c])] = y[a:c]
                    return x
                w = b
                for j in range(n):
                    us, uv = self.ustep[j], self.uval[j]
                    sz = us.size
                    if sz:
                        work.charge(sz * k, "solve")
                        if flat and sz <= rows:
                            w[j] -= (np.conj(uv).reshape((-1, 1)) * w[us]).sum(axis=0)
                        else:
                            acc = np.zeros(k, dtype=dt)
                            for a, c in chunks(sz, rows):
                                acc = acc + (np.conj(uv[a:c]).reshape((-1, 1)) * w[us[a:c]]).sum(axis=0)
                            w[j] = w[j] - acc
                    w[j] = w[j] / np.conj(self.udiag[j])
                for s in range(n - 1, -1, -1):
                    ls, lv = self.lstep[s], self.lval[s]
                    sz = ls.size
                    if sz:
                        work.charge(sz * k, "solve")
                        if flat and sz <= rows:
                            w[s] -= (np.conj(lv).reshape((-1, 1)) * w[ls]).sum(axis=0)
                        else:
                            acc = np.zeros(k, dtype=dt)
                            for a, c in chunks(sz, rows):
                                acc = acc + (np.conj(lv[a:c]).reshape((-1, 1)) * w[ls[a:c]]).sum(axis=0)
                            w[s] = w[s] - acc
                x = np.zeros((n, k), dtype=dt)
                for a, c in chunks(n, rows):
                    x[np.asarray(self.prow[a:c])] = w[a:c]
                return x
        finally:
            led.release(need)


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
                work.charge(lk.size, "solve")
                for a, c in chunks(lk.size):
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
                work.charge(uk.size, "solve")
                for a, c in chunks(uk.size):
                    y[uk[a:c]] = y[uk[a:c]] - uv[a:c] * yj
            elif us:
                work.charge(len(us), "solve")
                for i, v in zip(us, F.uval_l[j]):
                    y[i] = y[i] - v * yj
        x = np.zeros((n, 1), dtype=dt)
        q = F.q
        for a, c in chunks(n):
            x[np.asarray(q[a:c]), 0] = y[a:c]
        return x
    # (A' = Q C', C' = U' L' P: U' w = b[q], then L' v = w, then x = P' v)
    w = b1
    for j in range(n):
        us = F.ustep_l[j]
        if us is _BIG:
            uk, uv = F.ustep[j], F.uval[j]
            work.charge(uk.size, "solve")
            acc = 0
            for a, c in chunks(uk.size):
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
            work.charge(lk.size, "solve")
            acc = 0
            for a, c in chunks(lk.size):
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
        x[np.asarray(pr[a:c]), 0] = w[a:c]
    return x


def factor(S, what, q=None, ledger=None, work=None, order=True):
    """the LU of the square sparse S (an LU, with its ledger and work
    counter): its columns ordered by _matlab_colamd unless q is given (a
    test seam) or order is False (the identity)"""
    import _matlab_colamd

    n = S.n
    led = ledger or Ledger(what)
    work = work or Work(what)
    jc, ir, pr = S.jc, S.ir, S.pr
    nnz = int(jc[n])
    dt = np.complex128 if pr.dtype.kind == "c" else np.float64
    cv = _cval(dt)
    if q is None and order:
        _phase("ordering")
        m = S.m
        Nn = n + m
        ord_bytes = C_ENT * (3 * nnz + 10 * Nn + 6 * n) + C_LIST * (m + 3 * n) + C_TUPLE * (2 * n + 16)
        led.reserve(ord_bytes)
        try:
            q = _matlab_colamd.order_columns(m, n, jc, ir, lambda u: work.charge(u, "ordering"))
        finally:
            led.release(ord_bytes)
    elif q is None:
        q = list(range(n))
    led.reserve(n * C_IDX + C_HDR)
    qa = _seg_from_list(q)
    _phase("lu")
    # the workspace and the kept state, before the first column (r6 section 2.2's B_0)
    kpeak = _kpeak(cv)
    B0 = 3 * n * C_IDX + n * C_BOOL + 2 * n * cv + 5 * n * C_PTR + n * C_PYINT + 2 * E * C_IDX + kpeak + 5 * C_HDR
    led.reserve(B0, "workspace")
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
    prow = [0] * n
    lrow, lval = [None] * n, [None] * n
    # (L's columns also as Python lists, for the small columns' scalar path;
    # empty lists past SMALL entries, which that path never scans)
    lrow_l, lval_l = [None] * n, [None] * n
    ustep, uval = [None] * n, [None] * n
    ustep_l, uval_l = [None] * n, [None] * n
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
            budget = SMALL - na
            while h < len(steps):
                lk = lrow_l[steps[h]]
                if len(lk) > budget:
                    break
                budget -= len(lk)
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
