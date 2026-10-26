# MATLAB mode's sparse LU without fixed caps (plan-matlab-nocliffs r6, PR 1):
# the internal ordering, the LU's own column permutation (both solve
# directions), admission, the work limit's categories, and the chunked and
# segmented paths.  Run under the engine by test/matlab-lu.test.ts: each
# check prints one "ok ..." line, and any failure raises.
import math
import numpy as np
import _matlab_sparse as sp
import _matlab_colamd as C
import _matlab_lu as L
import _limits

EPS = 2.0 ** -52
seed = [12345]


def rnd():
    # (a fixed linear congruential generator: the same matrices on every host)
    seed[0] = (seed[0] * 1103515245 + 12345) % 2147483648
    return seed[0] / 2147483648.0


def make(n, entries, m=None):
    rows = [e[0] for e in entries]
    cols = [e[1] for e in entries]
    vals = [e[2] for e in entries]
    return sp.make(m or n, n, np.array(rows, dtype=np.int64), np.array(cols, dtype=np.int64), np.array(vals))


def rand_matrix(n, per, cplx=False, diag=4.0):
    ent = []
    for j in range(n):
        ent.append((j, j, complex(diag, 0.2 * diag) if cplx else diag))
        for _ in range(per):
            i = int(rnd() * n)
            if i != j:
                v = rnd() * 2 - 1
                ent.append((i, j, complex(v, rnd() * 2 - 1) if cplx else v))
    return make(n, ent)


def matvec(S, X, trans=False):
    jc, ir, pr = S.jc.tolist(), S.ir.tolist(), S.pr.tolist()
    Y = np.zeros(X.shape, dtype=complex)
    for j in range(S.n):
        for t in range(jc[j], jc[j + 1]):
            i = ir[t]
            if trans:
                Y[j] = Y[j] + np.conj(pr[t]) * X[i]
            else:
                Y[i] = Y[i] + pr[t] * X[j]
    return Y


def eta(S, X, B, trans=False):
    """the backward error ||A x - b||_1 / (||A||_1 ||x||_1 + ||b||_1), per column; 0 for 0/0"""
    jc, pr = S.jc.tolist(), S.pr.tolist()
    nA = max(sum(abs(v) for v in pr[jc[j]:jc[j + 1]]) for j in range(S.n))
    R = matvec(S, X, trans) - B
    worst = 0.0
    for c in range(B.shape[1]):
        num = float(np.sum(np.abs(R[:, c])))
        den = nA * float(np.sum(np.abs(X[:, c]))) + float(np.sum(np.abs(B[:, c])))
        worst = max(worst, 0.0 if den == 0 else num / den)
    return worst


def ok(name):
    print("ok", name)


def grid(k, perm_step=None):
    n = k * k
    perm = [(i * perm_step) % n for i in range(n)] if perm_step else list(range(n))
    ent = []
    for x in range(k):
        for y in range(k):
            i = x * k + y
            for dx, dy, v in ((0, 0, 4.0), (1, 0, -1.0), (-1, 0, -1.0), (0, 1, -1.0), (0, -1, -1.0)):
                a, b = x + dx, y + dy
                if 0 <= a < k and 0 <= b < k:
                    ent.append((perm[a * k + b], perm[i], v))
    return make(n, ent)


def nnz_lu(F):
    return sum(int(v.size) for v in F.lrow) + sum(int(v.size) for v in F.ustep)


# -- the ordering (r6 section 2.1)
S = grid(12, 37)
q = C.order_columns(S.m, S.n, S.jc, S.ir)
assert sorted(q) == list(range(S.n)) and q == C.order_columns(S.m, S.n, S.jc, S.ir)
ok("ordering: a permutation, the same every time")
n = 200
ent = [(i, i, 4.0) for i in range(n)] + [(i, 7, 1.0) for i in range(n) if i != 7]
ent = [e for e in ent if e[1] != 3]          # (column 3 empty)
ent += [(i, 11, 1.0) for i in (2, 5)] + [(i, 12, 1.0) for i in (2, 5)]   # (11 and 12 alike)
ent = [e for e in ent if not (e[1] in (11, 12) and e[0] in (11, 12))] + [(11, 11, 4.0), (12, 12, 4.0)]
A = make(n, ent)
q = C.order_columns(A.m, A.n, A.jc, A.ir)
assert q[0] == 3, q[:3]                       # the empty column first
assert C.dense_threshold(n) == 142 and q[-1] == 7, q[-3:]   # the dense column (200 entries) last
assert abs(q.index(11) - q.index(12)) == 1, (q.index(11), q.index(12))   # (one supervariable: together)
ok("ordering: an empty column first, a dense one last, indistinguishable columns together")
for k, step in ((10, 7), (15, 31), (20, 61)):
    S = grid(k, step)
    fo = nnz_lu(L.factor(S, "t"))
    fi = nnz_lu(L.factor(S, "t", order=False))
    assert fo <= fi, (k, fo, fi)
ok("ordering: fill no worse than the given order on permuted grid Laplacians")

# -- the permutation algebra (r6 section 2.1, A2): forced orders, real and complex, row pivoting, several right-hand sides
for cplx in (False, True):
    for n in (30, 120):
        S = rand_matrix(n, 3, cplx, diag=0.05)   # (a small diagonal: rows are pivoted away from it)
        B = np.array([[rnd() * 2 - 1 for _ in range(3)] for _ in range(n)])
        for q in (None, list(range(1, n)) + [0], [(i * 7) % n for i in range(n)] if n % 7 else None):
            F = L.factor(S, "t", q=q) if q is not None else L.factor(S, "t")
            if q is not None:
                assert q != [q.index(i) for i in range(n)]   # (not its own inverse)
            for k in (1, 3):
                Bk = B[:, :k]
                assert eta(S, F.solve(Bk), Bk) <= 64 * n * EPS
                assert eta(S, F.solve(Bk, trans=True), Bk, True) <= 64 * n * EPS
            assert any(int(F.prow[j]) != int(F.q[j]) for j in range(n)), "no row pivoting"
ok("permutation: A\\b and A'\\b within 64 n eps, forced orders, real and complex, 1 and 3 right-hand sides, row pivoting")
S = rand_matrix(50, 3)
F = L.factor(S, "t")
X = F.solve(np.zeros((50, 2)))
assert not np.any(X) and eta(S, X, np.zeros((50, 2))) == 0.0
ok("a zero right-hand side gives exactly x = 0 (the backward error 0 by the 0/0 convention)")
Z = make(4, [(0, 0, 1.0), (1, 1, 1.0), (2, 2, 1.0), (0, 3, 1.0)])
F = L.factor(Z, "t")
assert F.singular
X = F.solve(np.ones((4, 1)))
assert not np.all(np.isfinite(X))
ok("a singular matrix: a zero pivot kept, the solve gives Inf or NaN (the caller warns)")
# (condest's transposed solves through the LU: a symmetric permutation P A P'
# keeps the estimate; a nonsymmetric tridiagonal with random values, so no ties)
n = 4500
perm = [(i * 1999) % n for i in range(n)]
ent = []
for j in range(n):
    ent.append((j, j, 3.0 + rnd()))
    if j:
        ent.append((j - 1, j, rnd() - 0.5))
    if j < n - 1:
        ent.append((j + 1, j, rnd() * 2 - 1))
S1 = make(n, ent)
S2 = make(n, [(perm[i], perm[j], v) for i, j, v in ent])
c1 = sp._condest_b(1, S1)
c2 = sp._condest_b(1, S2)
assert abs(c1 / c2 - 1) < 1e-9, (c1, c2)
ok("condest of n = 4500, natural and permuted: the same estimate through A and A' solves")

# -- the work limit's categories (r6 section 2.3), exact on the duplicate-frontier family (astra2)
m = 20
ent = []
for j in range(m):
    ent.append((j, j, 1.0))
    ent += [(m + i, j, 0.1) for i in range(m)]
ent += [(i, m, 1.0) for i in range(m)] + [(m, m, 5.0)]
ent += [(j, j, 1.0) for j in range(m + 1, 2 * m)]
D = make(2 * m, ent)
lg = lambda r: max(0, (r - 1).bit_length())
expect = {
    "input": m * (1 + m) + (m + 1) + (m - 1),
    "reach": m * (1 + m) + (m + 1) + m * m + (m - 1),
    "union": m * (1 + m) + (m + 1) + m * m + (m - 1),
    "numeric": m * m,
    "sort": m * lg(m),
    "pivot": m * (1 + m) + 2 * m + (m - 1),
}
for e_small in (None, 8):
    saved = (L.E, L.A_SAFE)
    if e_small:
        L.E, L.A_SAFE = e_small, 32 * e_small
    try:
        L._categories = {}
        W = L.Work("t")
        F = L.factor(D, "t", q=list(range(2 * m)), work=W)
        got = dict(L._categories)
    finally:
        L._categories = None
        L.E, L.A_SAFE = saved
    assert got == expect, (e_small, got, expect)
    assert W.used == sum(expect.values())
ok("work: every category exact on the duplicate frontier (reach m + m^2 for its column), small and chunked")
# (dropping one category's charge is caught: the same counts without it differ)
for cat in expect:
    assert sum(v for k2, v in expect.items() if k2 != cat) != W.used
ok("work: a mutant dropping any one category fails the exact sum")
total = W.used
W = L.Work("t")
W.limit = total
L.factor(D, "t", q=list(range(2 * m)), work=W)
W = L.Work("t")
W.limit = total - 1
try:
    L.factor(D, "t", q=list(range(2 * m)), work=W)
    raise AssertionError("no refusal")
except Exception as e:
    assert type(e).__name__ == "MatlabError" and "beyond the limit matlab.lu_work" in str(e) and W.used <= total - 1, e
    assert getattr(e, "identifier", "") == "sagebrush:lu_work"
assert _limits.TABLE["matlab.lu_work"][0] == _limits.UNLIMITED and _limits.finalize()["matlab.lu_work"] == _limits.UNLIMITED
ok("work: matlab.lu_work unlimited by default; a limit of exactly the work runs, one less refuses before the work")


# -- admission (r6 section 2.2)
class FakeCap:
    def __init__(self, nbytes, domains, guard):
        self.rec = {"bytes": nbytes, "domains": domains, "basis": [], "unknown_parts": []}
        self.guard = guard

    def capacity(self):
        return dict(self.rec)

    def effective_guard_bytes(self, rec):
        return self.guard


real = L._capacity
S = rand_matrix(60, 3)
try:
    for cap, reason in ((FakeCap(None, [], None), "no memory figure"),
                        (FakeCap(10 ** 9, ["js-heap"], 10 ** 8), "the figure doesn't cover js-arraybuffer")):
        L._capacity = cap
        try:
            L.factor(S, "Solving with this 60-by-60 sparse matrix")
            raise AssertionError("no refusal")
        except MemoryError as e:
            assert e.unmeasured == reason and e.limit_bytes == 0 and e.record == cap.rec, (e.unmeasured, e.record)
            assert "can't measure the memory available here (%s)" % reason in str(e), str(e)
    L._capacity = FakeCap(10 ** 9, ["js-heap", "js-arraybuffer"], 0)
    try:
        L.factor(S, "t")
        raise AssertionError("no refusal")
    except MemoryError as e:
        assert e.unmeasured is None and "allows almost no memory" in str(e)
    ok("admission: no figure, or one without js-arraybuffer, refuses as unmeasured with the record; zero, as almost no memory")
    # (the interim, @sagebrush's ruling (d): where the record lacks the JS domains, as the
    # browser worker's does today, _sparse_lu keeps master's LU and its caps)
    L._capacity = FakeCap(4 << 30, ["wasm-engine"], 3 << 30)
    F = sp._sparse_lu(S)
    assert isinstance(F, sp._LU) and not isinstance(F, L.LU)
    B = np.ones((60, 1))
    assert eta(S, F.solve(B), B) <= 64 * 60 * EPS
    keep = sp.MAX_LU_FILL
    sp.MAX_LU_FILL = 10
    try:
        sp._sparse_lu(S)
        raise AssertionError("no refusal")
    except Exception as e:
        assert getattr(e, "identifier", "") == "MATLAB:nomem" and "fill in too far" in str(e), e
    finally:
        sp.MAX_LU_FILL = keep
    L._capacity = FakeCap(10 ** 12, ["js-heap", "js-arraybuffer"], 10 ** 12)
    assert isinstance(sp._sparse_lu(S), L.LU)
    ok("interim: a browser-like record (wasm-engine only) keeps master's LU, its solves and its refusal; a measured one gets the new LU")
    big = FakeCap(10 ** 12, ["js-heap", "js-arraybuffer"], 10 ** 12)
    L._capacity = big
    F = L.factor(S, "t")
    peak = F.ledger.peak
    L._capacity = FakeCap(10 ** 12, ["js-heap", "js-arraybuffer"], peak)
    L.factor(S, "t")
    L._capacity = FakeCap(10 ** 12, ["js-heap", "js-arraybuffer"], peak - 1)
    try:
        L.factor(S, "t")
        raise AssertionError("no refusal")
    except MemoryError as e:
        assert e.need_bytes == peak and e.limit_bytes == peak - 1
    ok("admission: an allowance of exactly the peak runs, one byte less refuses at that peak")
    # (each column's peak is reserved before anything of that column is allocated:
    # in the segmented mode every allocation is seen)
    L.E, L.A_SAFE = 8, 256
    L._capacity = big
    L._recorder = []
    F = L.factor(D, "t", q=list(range(2 * m)))
    ev = L._recorder
    L._recorder = None
    cols = 0
    state = "free"
    last = max(i for i, e in enumerate(ev) if e[0] == "reserve" and e[3] == "retain")
    for e in ev[:last + 1]:
        if e[0] == "reserve" and e[3] == "column":
            state, cols = "column", cols + 1
        elif e[0] == "reserve" and e[3] == "retain":
            state = "free"
        elif e[0] == "alloc" and e[3] is None:
            assert state != "free" or cols == 0, "an allocation outside a reserved column"
    assert cols == 2 * m
    kern = [e[1] for e in ev if e[0] == "kernel"]
    allocs = [e[2] for e in ev if e[0] == "alloc"]
    assert kern and max(kern) <= L.E and max(allocs) <= L.A_SAFE, (max(kern), max(allocs))
    ok("admission: every column reserves its peak before its arrays; segmented, no access over E nor allocation over A_SAFE")
    # (a byte formula with a term dropped or shrunk no longer covers the
    # allocations it reserves for: each column's arrays, by type, against
    # that type's part of its reservation; the values' part also covers np.abs's reals)
    def covered():
        L._recorder = []
        L.factor(D, "t", q=list(range(2 * m)))
        ev = L._recorder
        L._recorder = None
        parts, used, bad = None, {}, 0
        for e in ev:
            if e[0] == "reserve" and e[3] == "column":
                parts, used = e[4], {}
            elif e[0] == "alloc" and parts is not None:
                used[e[4]] = used.get(e[4], 0) + e[2]
                if used[e[4]] > parts[e[4]]:
                    bad += 1
            elif e[0] == "reserve" and e[3] == "retain":
                parts = None
        return bad == 0
    assert covered()
    for name in ("C_IDX", "C_RE", "C_BOOL"):
        keep = getattr(L, name)
        setattr(L, name, 0)
        try:
            assert not covered(), "the mutant (%s = 0) still covered" % name
        finally:
            setattr(L, name, keep)
    ok("admission: each column's arrays fit their type's part of its reservation; mutants dropping c_idx, c_val or c_bool do not")
finally:
    L._capacity = real
    L._recorder = None
    L.E, L.A_SAFE = min(L.E_TIME, (1 << 31) // 32), 1 << 31

# -- segmented and chunked results agree with the default path
S = rand_matrix(90, 3, True)
B = np.array([[complex(rnd(), rnd())] for _ in range(90)])
X0, Xt0 = L.factor(S, "t").solve(B), L.factor(S, "t").solve(B, trans=True)
L.E, L.A_SAFE = 16, 512
try:
    F = L.factor(S, "t")
    assert isinstance(F.udiag, L.Seg)
    X1, Xt1 = F.solve(B), F.solve(B, trans=True)
finally:
    L.E, L.A_SAFE = min(L.E_TIME, (1 << 31) // 32), 1 << 31
assert eta(S, X1, B) <= 64 * 90 * EPS and eta(S, Xt1, B, True) <= 64 * 90 * EPS
assert float(np.max(np.abs(X1 - X0))) <= 1e-12 * float(np.max(np.abs(X0))), "segmented and default differ"
ok("segmented (A_SAFE 512, E 16): the same solution as the default path, both directions")
assert L.A_SAFE >= 32 * L.E and L.E <= L.E_TIME
ok("E = min(E_TIME, A_SAFE / 32), A_SAFE >= 32 E")
