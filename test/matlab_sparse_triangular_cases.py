# The sparse triangular route of mldivide (A \ b for a lower or upper triangular sparse A, by substitution): the route
# each system takes, the meter it charges against the band route it replaces, its memory admitted as one need before
# anything is made (exact need: the triangular route; one byte short: the old route, unchanged), and its kernels'
# bounds. Run by test/matlab-sparse-triangular.test.ts; each check prints one "ok ..." line.
import sys
import types

import numpy as np

import _matlab as M
import _matlab_ledger as LG
import _matlab_lu as L
import _matlab_numeric as N
import _matlab_sparse as sp


def ok(name):
    print("ok", name)


class Cap:
    """a measured host whose guard allows g bytes (the band tests' stand-in)"""

    def __init__(self, g):
        self.g = g
        self.rec = {"bytes": g, "domains": ["js-heap", "js-arraybuffer"], "basis": [], "unknown_parts": []}

    def capacity(self):
        return dict(self.rec)

    def effective_guard_bytes(self, rec):
        return self.g


def stand_in(guard):
    cap = Cap(guard)
    L._capacity = sp._capacity = LG._capacity = cap


B = M._B
col = lambda v: M._unmat(np.asarray(v, dtype=float).reshape(-1, 1))


def bidiagonal(n, lower=True, cplx=False):
    e = col(np.ones(n))
    D = B["horzcat"].call(1, [B["uminus"].call(1, [e]), B["times"].call(1, [4.0, e])])
    S = B["spdiags"].call(1, [D, M._unmat(np.array([[-1.0 if lower else 1.0, 0.0]])), float(n), float(n)])
    if cplx:
        S = B["plus"].call(1, [S, B["times"].call(1, [0.5j, B["speye"].call(1, [float(n)])])])
    return S


def solve(S, b):
    """S \\ b, with the routes the sparse solver took"""
    L._routes = []
    try:
        r = B["mldivide"].call(1, [S, b])
    finally:
        routes, L._routes = L._routes, None
    return r, routes


def nomem(f):
    try:
        f()
    except MemoryError as e:
        return M._identifier(e) == "MATLAB:nomem"
    return False


# 1. routes: a triangular system of either order takes the triangular route; a tridiagonal one the old routes
stand_in(1 << 40)
for n in (50, 4000, 4001, 6000):
    for lower in (True, False):
        S = bidiagonal(n, lower)
        x, routes = solve(S, col(np.arange(1.0, n + 1)))
        assert routes == ["triangular"], (n, lower, routes)
        r = M._farr(B["minus"].call(1, [B["mtimes"].call(1, [S, x]), col(np.arange(1.0, n + 1))]))
        assert float(np.max(np.abs(r))) < 1e-10 * n, (n, lower)
# (a complex A with a real b above n = 4000: b's copy promoted to complex before the solve)
Sc = bidiagonal(6000, cplx=True)
bc = col(np.arange(1.0, 6001))
x, routes = solve(Sc, bc)
assert routes == ["triangular"], routes
r = M._farr(B["minus"].call(1, [B["mtimes"].call(1, [Sc, x]), bc]))
assert np.iscomplexobj(M._farr(x)) and float(np.max(np.abs(r))) < 1e-9, float(np.max(np.abs(r)))
T = B["plus"].call(1, [bidiagonal(6000), bidiagonal(6000, False)])
x, routes = solve(T, col(np.ones(6000)))
assert routes == ["band"], routes
x, routes = solve(B["plus"].call(1, [bidiagonal(300), bidiagonal(300, False)]), col(np.ones(300)))
assert routes == [], routes
ok("routes: triangular systems at n = 50, 4000, 4001 and 6000 (and a complex one above 4000, b real) take the triangular route; tridiagonal ones band or dense")

# 2. the meter: the triangular route charges k units per stored off-diagonal entry, against the band route's own
# charges on the same matrix (the band functions called on it directly): never more, equal for a full upper band
pins = []
for n, lower, k in ((5000, False, 1), (5000, True, 1), (5000, True, 3), (4001, False, 2)):
    S = bidiagonal(n, lower)
    kl, ku = sp.bandwidths(S)
    Bm = np.ones((n, k))
    wt = L.Work("tri")
    sp.triangular_solve(S, Bm.copy(), lower, wt)

    class _Led:
        owned = 0

        def reserve(self, *a, **kw):
            pass

        def release(self, *a, **kw):
            pass
    wb = L.Work("band")
    L.band_solve(S, Bm.copy(), kl, ku, _Led(), wb)
    offdiag = int(S.jc[n]) - n
    assert wt.used == k * offdiag, (n, lower, k, wt.used)
    assert wt.used <= wb.used, (n, lower, k, wt.used, wb.used)
    pins.append((n, "lower" if lower else "upper", k, wt.used, wb.used))
assert pins[0][3:] == (4999, 4999), pins[0]
# (a wider upper band, ku = 4, with holes inside it and one explicitly stored zero: still k units per stored
# off-diagonal, the stored zero included, and strictly fewer than the band route's)
n, k = 5000, 2
rows, vals = [], []
for j in range(n):
    rj = [i for i in range(max(0, j - 4), j) if not (j % 3 == 0 and i == j - 2)] + [j]
    rows.append(rj)
    vals.append([0.0 if (j, i) == (10, 7) else -1.0 for i in rj[:-1]] + [4.0])
jc = np.zeros(n + 1, dtype=sp._I)
jc[1:] = np.cumsum([len(r) for r in rows])
S = sp._new(n, n, jc, np.array([i for r in rows for i in r], dtype=sp._I), np.array([v for c in vals for v in c]))
assert sp.bandwidths(S) == (0, 4) and int(np.sum(S.pr == 0)) == 1, sp.bandwidths(S)
Bm = np.ones((n, k))
wt, wb = L.Work("tri"), L.Work("band")
sp.triangular_solve(S, Bm.copy(), False, wt)
L.band_solve(S, Bm.copy(), 0, 4, _Led(), wb)
offdiag = int(S.jc[n]) - n
assert wt.used == k * offdiag and wt.used < wb.used, (wt.used, k * offdiag, wb.used)
pins.append((n, "upper ku4 holes+zero", k, wt.used, wb.used))
ok("meter: k units per off-diagonal, never more than the band route's (%s)" % "; ".join("%d %s k%d: %d <= %d" % p for p in pins))

# 3. the small route's need: exact admits the triangular route, as does any larger guard; one byte short refuses with
# the out-of-memory error naming this triangular solve and its need, the dense route (needing far more) never tried
n, k = 1000, 300
S = bidiagonal(n)
Bk = M._unmat(np.ones((n, k)))
need, largest = sp.small_triangular_need(n, k, False, False, False)
assert need > sp.SMALL_NEED, need
for guard in (need, 1 << 40):
    stand_in(guard)
    x, routes = solve(S, Bk)
    assert routes == ["triangular"], (guard, routes)
stand_in(need - 1)
L._routes, LG._recorder = [], []
try:
    B["mldivide"].call(1, [S, Bk])
    assert False, "admitted one byte short"
except MemoryError as e:
    msg = str(e)
    assert M._identifier(e) == "MATLAB:nomem", M._identifier(e)
finally:
    routes, L._routes = L._routes, None
    rec, LG._recorder = LG._recorder, None
tags = [r[3] for r in rec if r[0] == "reserve"]
assert tags == ["triangular"] and routes == [], (tags, routes)
assert "triangular system" in msg, msg
# (the one piece before the reservation, the bandwidths' discovery: a fixed workspace of 4E indices, far under the
# small-need floor, read before the capacity record and before any copy of b)
assert 4 * sp.E * sp.C_IDX * 2 < sp.SMALL_NEED
order = []
real_bw, real_rec, real_full, real_mat = sp.bandwidths, sp._capacity_record, sp.full, M._mat
sp.bandwidths = lambda *a, **kw: (order.append("bandwidths"), real_bw(*a, **kw))[1]
sp._capacity_record = lambda *a, **kw: (order.append("record"), real_rec(*a, **kw))[1]
sp.full = lambda *a, **kw: (order.append("full"), real_full(*a, **kw))[1]
M._mat = lambda *a, **kw: (order.append("_mat"), real_mat(*a, **kw))[1]
try:
    stand_in(need)
    solve(S, Bk)
    order_full = list(order)
    del order[:]
    # (a sparse b past the floor: its full value filled under the route's reservation, still one record)
    Bks = sp.from_full(Bk)
    stand_in(1 << 40)
    x, routes = solve(S, Bks)
    order_sparse = list(order)
finally:
    sp.bandwidths, sp._capacity_record, sp.full, M._mat = real_bw, real_rec, real_full, real_mat
assert order_full[:2] == ["bandwidths", "record"] and order_full.count("record") == 1, order_full
assert sp.small_triangular_need(n, k, False, False, True)[0] > sp.SMALL_NEED
assert routes == ["triangular"] and order_sparse[:2] == ["bandwidths", "record"], order_sparse
assert order_sparse.count("record") == 1 and "full" not in order_sparse, order_sparse
ok("small route: its exact need (%d bytes) and any larger guard admit it; one byte short refuses naming it, the dense "
   "route never tried" % need)

# 3b. the choice by shape: a sparse b of many columns, where the triangular route needs more than the dense route,
# takes the dense route at every guard (a host between the two needs answers, as before), and a full b of the same
# shape, needing less, the triangular route at every guard
n, k = 20, 20000
S = bidiagonal(n)
Bs = sp.from_full(M._unmat(np.eye(n)[:, [i % n for i in range(k)]]))
tri_need = sp.small_triangular_need(n, k, False, False, True)[0]
dense_need = (sp.DENSE_A_COPIES * n * n + sp.DENSE_B_COPIES * n * k) * 8 + 3 * sp.E * 8 * 2
assert dense_need < tri_need, (dense_need, tri_need)
for guard in (dense_need, 1 << 40):
    stand_in(guard)
    x, routes = solve(S, Bs)
    assert "triangular" not in routes and M._dims(x) == (n, k), (guard, routes)
Bf = sp.full(Bs)
assert sp.small_triangular_need(n, k, False, False, False)[0] <= (sp.DENSE_A_COPIES * n * n + sp.DENSE_B_COPIES * n * k) * 8
for guard in (dense_need, 1 << 40):
    stand_in(guard)
    x, routes = solve(S, Bf)
    assert routes == ["triangular"], (guard, routes)
ok("the small route by shape: a sparse b whose triangular need (%d) passes the dense route's (%d) runs the dense route "
   "at that guard and at a large one; the full b of the same shape the triangular route at both" % (tri_need, dense_need))

# 3c. no size cliff: every order from 2 (1, a scalar A, divides) takes substitution (a need under the small-need floor never refuses), lower and
# upper, real and complex A and b, full and sparse b, several right-hand sides; an all-zero A divides by zero in each
# row alike (Inf, not the dense route's NaN after the first)
stand_in(1 << 40)
count = 0
for n in range(2, 9):
    for lower in (True, False):
        for cplx in (False, True):
            S = bidiagonal(n, lower, cplx)
            for k in (1, 2, 5):
                for cplx_b in (False, True):
                    for sparse_b in (False, True):
                        bv = np.arange(1.0, n * k + 1).reshape((n, k)) + (1j if cplx_b else 0)
                        b = sp.from_full(M._unmat(bv)) if sparse_b else M._unmat(bv)
                        x, routes = solve(S, b)
                        assert routes == ["triangular"], (n, lower, cplx, k, cplx_b, sparse_b, routes)
                        r = M._farr(B["minus"].call(1, [B["mtimes"].call(1, [S, x]), b]))
                        assert float(np.max(np.abs(r))) < 1e-9, (n, k)
                        count += 1
    Z = sp.zeros(n, n)
    shown, real_err = [], M._write_err
    M._write_err = shown.append
    try:
        x, routes = solve(Z, col(np.arange(1.0, n + 1)))
    finally:
        M._write_err = real_err
    assert routes == ["triangular"] and bool(np.all(M._farr(x) == np.inf)), (n, routes, M._farr(x))
    assert sum("singular to working precision" in w for w in shown) == 1, shown
ok("no size cliff: n = 2..8, %d systems (lower, upper, real, complex, full and sparse b, k = 1, 2, 5) by substitution; "
   "an all-zero A gives Inf in every row" % count)

# 4. above n = 4000: a triangular system takes the triangular route once its bandwidths are known, where its whole
# need (big_triangular_need: the caller's copy of b, X, the result and its conversions) is at most the least need of
# the routes it replaces (the band's m_band, the ordering's that the LU needs first), by those formulas alone, never
# by the ledger's guard: the same route, and the same units, on every host.  The guard only admits its need (reserved
# until the result is made) or refuses it, and a refusal is one the old routes give too
def m_band_of(S, k, cplx):
    kl, ku = sp.bandwidths(S)
    nb = L.band_need(S.n, kl, ku, k, cplx)
    return None if nb is None else nb["persistent"] + max(nb["setup"], nb["step"])


def bound_of(S, k, cplx):
    mb = m_band_of(S, k, cplx)
    o = L.ordering_need(S)[0]
    return o if mb is None else min(mb, o)


def run(S, b, guard):
    """S \\ b at a guard: (routes, lu_work units, the triangular reservation's bytes or None, the result)"""
    stand_in(guard)
    LG._recorder = []
    W = L.Work
    used = []

    class Spy(W):
        def __init__(self, *a, **kw):
            W.__init__(self, *a, **kw)
            used.append(self)
    L.Work = Spy
    try:
        x, routes = solve(S, b)
    finally:
        L.Work = W
        rec, LG._recorder = LG._recorder, None
    tri = [r[2] for r in rec if r[0] == "reserve" and r[3] == "triangular"]
    return routes, sum(w.used for w in used), (tri[0] if tri else None), x


n = 100000
S = bidiagonal(n, False)
b1 = col(np.arange(1.0, n + 1))
mb = m_band_of(S, 1, False)
need = sp.big_triangular_need(n, 1, False, False, False)[0]
assert need <= bound_of(S, 1, False) == mb, (need, mb)
r_big = run(S, b1, 1 << 40)
r_exact = run(S, b1, need)
assert r_big[0] == r_exact[0] == ["triangular"], (r_big[0], r_exact[0])
assert r_big[1] == r_exact[1], (r_big[1], r_exact[1])
assert r_big[2] == r_exact[2] == need, (r_big[2], need)
# (one byte short: the out-of-memory error, no other route tried; without the triangular route, refused too)
stand_in(need - 1)
LG._recorder = []
L._routes = []
try:
    assert nomem(lambda: B["mldivide"].call(1, [S, b1]))
finally:
    routes, L._routes = L._routes, None
    rec, LG._recorder = LG._recorder, None
tags = [r[3] for r in rec if r[0] == "reserve"]
assert routes == [] and tags == ["discovery", "triangular"], (routes, tags)
L._routes = []
try:
    L.solve(S, M._mat(b1), "t", tri=None)
    assert False, "admitted"
except MemoryError:
    pass
finally:
    L._routes = None
# (the whole need by hand at n = 100000, k = 1: X, b's copy, and the result, each with its header; with A complex, X
# made complex from b directly (no real copy kept), the result and _box's real copy; with a sparse b, from_full's
# arrays on top)
H = sp.C_HDR
assert need == 2 * (8 * n + H), need
assert sp.big_triangular_need(n, 1, True, False, False)[0] == (16 + 16 + 8) * n + 3 * H
assert sp.big_triangular_need(n, 1, False, False, True)[0] == 2 * (8 * n + H) + 4 * 8 * n + 3 * 8 * n + 3 * 2 * 8 + 10 * H
# (the reservation held until the result is made: released after _unmat and, for a sparse b, from_full)
events = []
real_release, real_unmat, real_ff = LG.Ledger.release, M._unmat, sp.from_full


def spy_release(self, nbytes):
    events.append(("release", int(nbytes)))
    return real_release(self, nbytes)


LG.Ledger.release = spy_release
M._unmat = lambda *a, **kw: (events.append(("_unmat",)), real_unmat(*a, **kw))[1]
sp.from_full = lambda *a, **kw: (events.append(("from_full",)), real_ff(*a, **kw))[1]
try:
    stand_in(1 << 40)
    nsb = 4500
    need_sb = sp.big_triangular_need(nsb, 1, False, False, True)[0]
    bsb = real_ff(col(np.arange(1.0, nsb + 1)))
    Ssb = bidiagonal(nsb)
    del events[:]
    x, routes = solve(Ssb, bsb)
finally:
    LG.Ledger.release, M._unmat, sp.from_full = real_release, real_unmat, real_ff
assert routes == ["triangular"] and type(x) is sp.Sparse, routes
names = [e[0] for e in events]
assert names.index("from_full") > names.index("_unmat") and ("release", need_sb) in events, events
assert events.index(("release", need_sb)) > names.index("from_full"), events
# (and nothing of b is copied before the route's reservation: a sparse b's full value is filled after it, the old
# routes' _mat copy never made, and one byte short no copy at all; for the band, b's copy comes after the discovery)
order = []
real_fill, real_mat = sp._fill_full, M._mat
sp._fill_full = lambda *a, **kw: (order.append("fill"), real_fill(*a, **kw))[1]
M._mat = lambda *a, **kw: (order.append("_mat"), real_mat(*a, **kw))[1]
LG._recorder = order
try:
    stand_in(1 << 40)
    x, routes = solve(Ssb, bsb)
    tri_order = [o if isinstance(o, str) else o[3] for o in order]
    del order[:]
    stand_in(need_sb - 1)
    short_refused = nomem(lambda: B["mldivide"].call(1, [Ssb, bsb]))
    short_order = [o if isinstance(o, str) else o[3] for o in order]
    stand_in(1 << 40)
    T6 = B["plus"].call(1, [bidiagonal(6000), bidiagonal(6000, False)])
    b6 = col(np.ones(6000))
    del order[:]
    x6, routes6 = solve(T6, b6)
    band_order = [o if isinstance(o, str) else o[3] for o in order]
finally:
    sp._fill_full, M._mat, LG._recorder = real_fill, real_mat, None
assert routes == ["triangular"] and "_mat" not in tri_order, tri_order
assert tri_order.index("triangular") < tri_order.index("fill"), tri_order
assert short_refused and short_order == ["discovery", "triangular"], short_order
assert routes6 == ["band"] and band_order.index("discovery") < band_order.index("_mat"), band_order
# (a zero diagonal on the big route: the singular warning, once)
shown, real_err = [], M._write_err
M._write_err = shown.append
try:
    Sz = bidiagonal(4001)
    Sz.pr[Sz.pr == 4.0] = np.where(np.arange(4001) == 7, 0.0, 4.0)
    x, routes = solve(Sz, col(np.ones(4001)))
finally:
    M._write_err = real_err
assert routes == ["triangular"] and sum("singular to working precision" in s for s in shown) == 1, (routes, shown)
ok("big route: its whole need (%d bytes), within the band's m_band (%d): at exactly that need and at any larger guard "
   "the triangular route, the same units (%d); one byte short refused, no other route tried, as the old routes refuse; "
   "the need by hand; nothing of b copied before its reservation (none one byte short); released after the result "
   "is made; a zero diagonal warns" % (need, mb, r_big[1]))

# 4b. the choice by formula over shapes: lower and upper, bidiagonal and wider (ku = 4), one and many right-hand
# sides, real, complex A and complex b (A complex and b real: the promotion), full and sparse b (both outcomes: at
# k = 12 a sparse b, and the promotion of a lower bidiagonal A, pass m_band).  Where the whole need is within the
# bound (the proof's inequality: at most the band's need and the ordering's), the triangular route at its exact need
# and at a large guard, the same units, reserving exactly its whole need; where it passes the bound, the band as
# before (at m_band and at a large guard)
def wide_upper(n, cplx=False):
    e = col(np.ones(n))
    D = B["horzcat"].call(1, [B["times"].call(1, [4.0, e])] + [B["uminus"].call(1, [e])] * 4)
    S = B["spdiags"].call(1, [D, M._unmat(np.array([[0.0, 1.0, 2.0, 3.0, 4.0]])), float(n), float(n)])
    if cplx:
        S = B["plus"].call(1, [S, B["times"].call(1, [0.5j, B["speye"].call(1, [float(n)])])])
    return S


n = 4500
taken = {True: 0, False: 0}
for name, S, cplx_a in (("lower", bidiagonal(n), False), ("upper", bidiagonal(n, False), False),
                        ("ku4", wide_upper(n), False), ("lower complex", bidiagonal(n, cplx=True), True),
                        ("ku4 complex", wide_upper(n, True), True)):
    for k in (1, 12):
        for cplx_b in (False, True):
            for sparse_b in (False, True):
                bv = np.arange(1.0, n * k + 1).reshape((n, k)) % 7 + 1
                if cplx_b:
                    bv = bv + 1j
                b = M._unmat(bv)
                if sparse_b:
                    b = sp.from_full(b)
                cplx = cplx_a or cplx_b
                mb = m_band_of(S, k, cplx)
                need = sp.big_triangular_need(n, k, cplx_a, cplx_b, sparse_b)[0]
                fits = need <= bound_of(S, k, cplx)
                assert bound_of(S, k, cplx) == mb, (name, k)
                # (the route's least guard: its need, and before it the discovery's, 4E indices, as the old routes)
                for guard in ((max(need, 4 * sp.E * 8) if fits else mb), 1 << 40):
                    routes, units, tri_res, x = run(S, b, guard)
                    assert routes == (["triangular"] if fits else ["band"]), (name, k, cplx_b, sparse_b, guard, routes)
                    assert tri_res == (need if fits else None), (name, k, tri_res, need)
                    if guard < 1 << 40:
                        u0, x0 = units, x
                    else:
                        assert units == u0, (name, k, cplx_b, sparse_b, units, u0)
                r = M._farr(B["minus"].call(1, [B["mtimes"].call(1, [S, x0]), b]))
                assert float(np.max(np.abs(r))) < 1e-9 * n * k, (name, k)
                taken[fits] += 1
assert taken[True] and taken[False], taken
ok("route by formula over 40 shapes (%d triangular, %d band): the same route and units at the route's own need and at a "
   "large guard, the triangular reservation its whole need, within the band's and the ordering's" % (taken[True], taken[False]))

# 4c. a triangular system the band doesn't take (too wide: the LU before this route): now the triangular route, its
# need within the ordering's, its units below the LU's (pinned for one and three right-hand sides)
n = 4500
rng = np.random.default_rng(5)
rows_ = rng.integers(0, n, 3 * n)
cols_ = rng.integers(0, n, 3 * n)
keep = rows_ > cols_
W = sp.make(n, n, np.concatenate([rows_[keep], np.arange(n)]), np.concatenate([cols_[keep], np.arange(n)]),
            np.concatenate([rng.standard_normal(int(keep.sum())), 4.0 + rng.random(n)]))
kl, ku = sp.bandwidths(W)
assert ku == 0 and kl > n // 2, (kl, ku)
lu_pins = []
for k in (1, 3):
    bw = M._unmat(np.ones((n, k)))
    stand_in(1 << 40)
    old = L.Work("old")
    W0 = L.Work
    L._routes = []
    try:
        L.Work = lambda *a, **kw: old
        L.solve(W, M._mat(bw), "t", tri=None)
    finally:
        L.Work = W0
        old_routes, L._routes = L._routes, None
    assert old_routes == ["lu"], old_routes
    routes, units, tri_res, x = run(W, bw, 1 << 40)
    assert routes == ["triangular"] and units <= old.used, (routes, units, old.used)
    assert sp.big_triangular_need(n, k, False, False, False)[0] <= bound_of(W, k, False)
    r = M._farr(B["minus"].call(1, [B["mtimes"].call(1, [W, x]), bw]))
    assert float(np.max(np.abs(r))) < 1e-8, float(np.max(np.abs(r)))
    lu_pins.append((k, units, old.used))
# (and where the triangular need passes the ordering's, below the band's m_band, the LU as before: k = 200)
k = 200
need = sp.big_triangular_need(n, k, False, False, False)[0]
assert L.ordering_need(W)[0] < need <= m_band_of(W, k, False), (L.ordering_need(W)[0], need)
routes, units, tri_res, x = run(W, M._unmat(np.ones((n, k))), 1 << 40)
assert routes == ["lu"] and tri_res is None, routes
ok("a triangular system the LU took (kl = %d): the triangular route, its units below the LU's (%s); its need past the "
   "ordering's (k = 200), the LU as before" % (kl, "; ".join("k%d: %d <= %d" % p for p in lu_pins)))

# 5. A_SAFE: a promotion copy past A_SAFE leaves the band; the discovery's reservation refused leaves today's path
stand_in(1 << 40)
saved = sp.A_SAFE
sp.A_SAFE = 1000
try:
    x, routes = solve(bidiagonal(6000, cplx=True), col(np.ones(6000)))
    assert routes == ["band"], routes
finally:
    sp.A_SAFE = saved
saved = sp.A_SAFE
sp.A_SAFE = 1000
try:
    x, routes = solve(bidiagonal(300), M._unmat(np.ones((300, 2))))
    assert routes == [], routes
finally:
    sp.A_SAFE = saved
ok("a single array past A_SAFE: the old route, above n = 4000 and below")

# 6. a Stop (or any error) inside the triangular route ends the solve: nothing is caught and retried by another route
saved = sp.triangular_solve


def stop(*a, **kw):
    raise KeyboardInterrupt()


sp.triangular_solve = stop
try:
    for n in (300, 6000):
        L._routes = []
        try:
            B["mldivide"].call(1, [bidiagonal(n), col(np.ones(n))])
            assert False, "no stop"
        except KeyboardInterrupt:
            pass
        assert L._routes == ["triangular"], L._routes
finally:
    sp.triangular_solve = saved
    L._routes = None
ok("a Stop in the triangular route ends the solve, at n = 300 and 6000: no other route is tried")

# 7. every kernel at most E entries*width: E lowered to 8, k = 20 right-hand sides, a spy on the products and
# divisions
saved_E, saved_outer = sp.E, np.outer
sizes = []


def spy(a, b, *x, **kw):
    r = saved_outer(a, b, *x, **kw)
    sizes.append(r.size)
    return r


sp.E = 8
np.outer = spy
try:
    n = 40
    S = sp.from_full(M._unmat(np.tril(np.ones((n, n))) + 3 * np.eye(n)))
    X = np.ones((n, 20))
    sp.triangular_solve(S, X, True)
    assert sp.tri_block(20) == (8, 1)
finally:
    sp.E, np.outer = saved_E, saved_outer
assert sizes and max(sizes) <= 8, max(sizes)
ok("every block at most E entries*width (E = 8, k = 20: largest product %d)" % max(sizes))
