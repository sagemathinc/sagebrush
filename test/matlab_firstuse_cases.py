# MATLAB mode's sparse full() and small dense solve on first use (rank-13 PR 2,
# the first-use fix, plan r3; @sagebrush's ruling B+A of Oct 29): below the
# small-need floor (_matlab_sparse.SMALL_NEED) they run the chunked code their
# admission counts, with no capacity record, no Ledger and no _matlab_lu
# import; above it, full admission.  Ledger and the one recorder live in
# _matlab_ledger.  Its own process: the cold checks come first.  Run by
# test/matlab-band.test.ts; each check prints one "ok ..." line.
import sys
import numpy as np
import _matlab_sparse as sp
import _matlab as M

COLD = ("_capacity", "_matlab_ledger", "_matlab_lu")
assert not [m for m in COLD if m in sys.modules] and sp._capacity is None, "imported before the test"


def ok(name):
    print("ok", name)


def make(n, rows, cols, vals, m=None):
    return sp.make(m or n, n, np.array(rows, dtype=np.int64), np.array(cols, dtype=np.int64), np.array(vals))


def poison(*names):
    saved = {}
    for nm in names:
        saved[nm] = getattr(sp, nm)

        def bad(*a, _nm=nm, **k):
            raise AssertionError("called " + _nm)
        setattr(sp, nm, bad)
    return saved


def unpoison(saved):
    for nm, f in saved.items():
        setattr(sp, nm, f)


def dense_need(A, k, cplx, sparse_b):
    # (the plan's predicate restated: the admitted copies plus each fill's chunk transients)
    cv = 16 if cplx else 8
    return (sp.DENSE_A_COPIES * A.m * A.n + sp.DENSE_B_COPIES * A.m * k) * cv + 3 * sp.E * 8 * (2 if sparse_b else 1)


# -- 1. cold: 2x2 full() and backslash, real and complex, dense and sparse right sides
R2 = make(2, [0, 1, 0, 1], [0, 0, 1, 1], [4.0, 1.0, 2.0, 3.0])
C2 = make(2, [0, 1, 0, 1], [0, 0, 1, 1], [4.0 + 1j, 1.0, 2.0, 3.0 - 2j])
bs = make(1, [0, 1], [0, 0], [1.0, 2.0], m=2)
saved = poison("_capacity_record", "unmeasured_reason", "_legacy_full_arr", "_legacy_mldivide")
try:
    assert np.array_equal(sp.full_arr(R2), np.array([[4.0, 1.0], [2.0, 3.0]]))
    assert np.array_equal(sp.full_arr(C2), np.array([[4.0 + 1j, 1.0], [2.0, 3.0 - 2j]]))
    for A, Ad in ((R2, np.array([[4.0, 2.0], [1.0, 3.0]])), (C2, np.array([[4.0 + 1j, 2.0], [1.0, 3.0 - 2j]]))):
        for b in (np.array([[1.0], [2.0]]), np.array([[1.0 + 1j], [2.0]])):
            x = M._mat(sp.mldivide(A, M._unmat(b)))
            assert float(np.max(np.abs(np.dot(Ad, x) - b))) <= 1e-12, x
        xs = sp.mldivide(A, bs)
        assert type(xs) is sp.Sparse, type(xs)
        assert float(np.max(np.abs(np.dot(Ad, sp.full_arr(xs).T) - np.array([[1.0], [2.0]])))) <= 1e-12
finally:
    unpoison(saved)
assert not [m for m in COLD if m in sys.modules] and sp._capacity is None, [m for m in COLD if m in sys.modules]
ok("cold: 2x2 full() and backslash (real, complex; dense and sparse right sides) read no capacity record and import "
   "neither _capacity, _matlab_ledger nor _matlab_lu")

import _matlab_ledger as LG


class Cap:
    """a capacity record measuring both JS domains with allowance g (or one without them), counting its reads"""

    def __init__(self, g, domains=("js-heap", "js-arraybuffer")):
        self.g = g
        self.rec = {"bytes": g, "domains": list(domains), "basis": [], "unknown_parts": []}
        self.reads = 0

    def capacity(self):
        self.reads += 1
        return dict(self.rec)

    def effective_guard_bytes(self, rec):
        return self.g


real_sp, real_LG, real_small = sp._capacity, LG._capacity, sp.SMALL_NEED
if real_sp is None:
    import _capacity
    real_sp = _capacity


def use(cap):
    sp._capacity = LG._capacity = cap


def restore():
    sp._capacity, LG._capacity, sp.SMALL_NEED = real_sp, real_LG, real_small
    LG._recorder = None


# -- 1b. above the floor, measured: the Ledger, without _matlab_lu (its own chunk) or _matlab_colamd
G = make(1000, list(range(1000)), list(range(1000)), [1.0] * 1000)
D300 = make(300, list(range(300)), list(range(300)), [3.0] * 300)
try:
    cap = Cap(10 ** 12)
    use(cap)
    assert float(sp.full_arr(G)[999, 999]) == 1.0
    x = M._mat(sp.mldivide(D300, M._unmat(np.ones((300, 1)))))
    assert float(np.max(np.abs(x - 1.0 / 3.0))) <= 1e-15 and cap.reads == 2, cap.reads
finally:
    restore()
assert "_matlab_lu" not in sys.modules and "_matlab_colamd" not in sys.modules
ok("measured full() and dense solve above the floor admit through _matlab_ledger and import neither _matlab_lu nor _matlab_colamd")

import _matlab_lu as L


def refused(f, ident=None):
    try:
        f()
    except AssertionError:
        raise
    except Exception as e:
        if ident is not None:
            assert getattr(e, "identifier", "") == ident and getattr(e, "record", None) is not None, e
        return e
    raise AssertionError("no refusal")


def spy(nm):
    calls = []
    f = getattr(sp, nm)

    def counted(*a, **k):
        calls.append(1)
        return f(*a, **k)
    setattr(sp, nm, counted)
    return calls, f


assert sp.SMALL_NEED == 1 << 22
F = make(30, list(range(30)), list(range(30)), [2.0] * 30)
need = sp._full_need(F)
B1 = np.ones((30, 1))
dn = dense_need(F, 1, False, False)
dns = dense_need(F, 1, False, True)
bsp = make(1, list(range(30)), [0] * 30, [1.0] * 30, m=30)

# -- 2. the floor's boundary, full(): at the need exempt, one byte under admitted (refused, or legacy when unmeasured)
try:
    cap = Cap(0)
    use(cap)
    sp.SMALL_NEED = need
    assert np.array_equal(sp.full_arr(F), 2.0 * np.eye(30)) and cap.reads == 0
    sp.SMALL_NEED = need - 1
    refused(lambda: sp.full_arr(F), "MATLAB:array:SizeLimitExceeded")
    assert cap.reads == 1, cap.reads
    use(Cap(4 << 30, domains=("wasm-engine",)))
    calls, f = spy("_legacy_full_arr")
    try:
        assert np.array_equal(sp.full_arr(F), 2.0 * np.eye(30)) and calls == [1]
    finally:
        sp._legacy_full_arr = f
finally:
    restore()
ok("floor, full(): a need of exactly SMALL_NEED is exempt (a refusing record unread); one byte more is admitted: "
   "refused by a measured zero, master's route when unmeasured")

# -- 3. the floor's boundary, the dense solve (dense and sparse right sides: each fill's transients counted)
try:
    for b, nd in ((M._unmat(B1), dn), (bsp, dns)):
        cap = Cap(0)
        use(cap)
        sp.SMALL_NEED = nd
        x = sp.mldivide(F, b)
        assert cap.reads == 0
        sp.SMALL_NEED = nd - 1
        e = refused(lambda: sp.mldivide(F, b))
        assert isinstance(e, MemoryError) and cap.reads == 1, (e, cap.reads)
        use(Cap(4 << 30, domains=("wasm-engine",)))
        calls, f = spy("_legacy_mldivide")
        try:
            sp.mldivide(F, b)
            assert calls == [1]
        finally:
            sp._legacy_mldivide = f
    assert dns - dn == 3 * sp.E * 8
finally:
    restore()
ok("floor, dense solve: exactly SMALL_NEED (copies plus fill transients, a sparse right side's too) is exempt; "
   "one byte more is admitted: refused by a measured zero, master's route when unmeasured")

# -- 4. many-entry separators: the exempt routes run the chunked fill (_fill_full), never nnz-sized _cols or legacy
N = 680
k = np.arange(N * N, dtype=np.int64)
S680 = sp.make(N, N, k % N, k // N, np.arange(N * N, dtype=np.float64) + 1.0)
assert sp._full_need(S680) == 4092416 <= sp.SMALL_NEED and int(S680.pr.size) > sp.E
n = 240
k = np.arange(n * n, dtype=np.int64)
v = (k % 7).astype(np.float64) - 3.0 + np.where(k % n == k // n, 4.0 * n, 0.0)
A240 = sp.make(n, n, k % n, k // n, v)
assert dense_need(A240, 1, False, False) == 4087296 <= sp.SMALL_NEED and int(A240.pr.size) > sp.E
saved = poison("_cols", "_capacity_record", "unmeasured_reason", "_legacy_full_arr", "_legacy_mldivide")
fills, real_fill = spy("_fill_full")
try:
    a = sp.full_arr(S680)
    assert fills == [1] and np.array_equal(a.reshape(-1), np.arange(N * N, dtype=np.float64) + 1.0)
    b = np.array([[float(i % 5) - 2.0] for i in range(n)])
    x = M._mat(sp.mldivide(A240, M._unmat(b)))
    assert fills == [1, 1]
    Ad = sp.full_arr(A240).T
    assert float(np.max(np.abs(np.dot(Ad, x) - b))) <= 1e-9
finally:
    sp._fill_full = real_fill
    unpoison(saved)
ok("separators: a 680x680 full-density full() (4,092,416 bytes) and a 240x240 full-density dense solve "
   "(4,087,296) are exempt and run the chunked fill, with _cols, the record and the legacy routes poisoned")

# -- 5. above the floor: a measured record exactly the need admits, one byte less refuses
gneed = sp._full_need(G)
dneed = (sp.DENSE_A_COPIES * 300 * 300 + sp.DENSE_B_COPIES * 300) * 8
assert gneed > sp.SMALL_NEED and dense_need(D300, 1, False, False) > sp.SMALL_NEED
try:
    cap = Cap(gneed)
    use(cap)
    assert float(sp.full_arr(G)[999, 999]) == 1.0 and cap.reads == 1
    cap = Cap(gneed - 1)
    use(cap)
    refused(lambda: sp.full_arr(G), "MATLAB:array:SizeLimitExceeded")
    assert cap.reads == 1
    cap = Cap(dneed)
    use(cap)
    x = M._mat(sp.mldivide(D300, M._unmat(np.ones((300, 1)))))
    assert float(np.max(np.abs(x - 1.0 / 3.0))) <= 1e-15 and cap.reads == 1
    cap = Cap(dneed - 1)
    use(cap)
    assert isinstance(refused(lambda: sp.mldivide(D300, M._unmat(np.ones((300, 1))))), MemoryError) and cap.reads == 1
finally:
    restore()
ok("above the floor: full() and the dense solve read one record; a guard of exactly the need admits, one less refuses")

# -- 6. a Ledger without a record reads _matlab_ledger's _capacity once
try:
    cap = Cap(1000)
    use(cap)
    led = LG.Ledger("t")
    assert cap.reads == 1 and led.G == 1000 and led.unmeasured is None
    led.reserve(1000)
    assert isinstance(refused(lambda: led.reserve(1)), MemoryError)
    use(Cap(4 << 30, domains=("wasm-engine",)))
    e = refused(lambda: LG.Ledger("t").reserve(0))
    assert isinstance(e, MemoryError) and e.unmeasured == "the figure doesn't cover js-heap or js-arraybuffer", e.unmeasured
finally:
    restore()
ok("no-record Ledger: one read of _matlab_ledger._capacity; admits to its guard and refuses past it, or fails closed unmeasured")

# -- 7. one recorder: _matlab_lu's records and the Ledger's reach the same list
assert L.Ledger is LG.Ledger and L._record is LG._record and not hasattr(L, "_recorder")
try:
    use(Cap(10 ** 12))
    LG._recorder = []
    n = 60
    ent = [(j, j, 4.0) for j in range(n)] + [((j * 7 + 3) % n, j, 0.5) for j in range(n) if (j * 7 + 3) % n != j]
    S60 = make(n, [e[0] for e in ent], [e[1] for e in ent], [e[2] for e in ent])
    L.factor(S60, "t")
    sp.full_arr(G)
    kinds = set(e[0] for e in LG._recorder)
    # (alloc: _matlab_lu's own records, through the imported _record; reserve: the Ledger's)
    assert {"reserve", "alloc"} <= kinds, kinds
    assert any(e[0] == "reserve" and e[3] == "full" for e in LG._recorder)
finally:
    restore()
ok("one recorder: _matlab_lu's allocation records and the Ledger's reservations (full's too) in _matlab_ledger._recorder")

# -- 8. the n > 4000 route is never exempt, whatever the floor
T = make(4001, list(range(4001)), list(range(4001)), [2.0] * 4001)
try:
    cap = Cap(0)
    use(cap)
    sp.SMALL_NEED = 1 << 62
    saved = poison("_dense_solve")
    try:
        refused(lambda: sp.mldivide(T, M._unmat(np.ones((4001, 1)))))
    finally:
        unpoison(saved)
    assert cap.reads >= 1, cap.reads
finally:
    restore()
ok("the n > 4000 route is admitted even with an unbounded floor: a measured zero refuses it, the dense route unreached")
