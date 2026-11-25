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
ok("meter: k units per off-diagonal, never more than the band route's (%s)" % "; ".join("%d %s k%d: %d <= %d" % p for p in pins))

# 3. the small route's need: exact admits the triangular route, one byte short leaves the dense route (which, needing
# far more, refuses as it did before)
n, k = 1000, 300
S = bidiagonal(n)
Bk = M._unmat(np.ones((n, k)))
need, largest = sp.small_triangular_need(n, k, False, False, False)
assert need > sp.SMALL_NEED, need
stand_in(need)
x, routes = solve(S, Bk)
assert routes == ["triangular"], routes
stand_in(need - 1)
L._routes = []
assert nomem(lambda: B["mldivide"].call(1, [S, Bk]))
assert "triangular" not in (L._routes or []), L._routes
L._routes = None
# (and the decision comes before any discovery: one byte short, the bandwidths are never read)
saved_bw = sp.bandwidths


def no_discovery(*a, **kw):
    raise AssertionError("bandwidths read before the triangular need was admitted")


sp.bandwidths = no_discovery
try:
    stand_in(need - 1)
    assert nomem(lambda: B["mldivide"].call(1, [S, Bk]))
finally:
    sp.bandwidths = saved_bw
ok("small route: its exact need (%d bytes) admits it; one byte short leaves the old dense route, which refuses" % need)

# 3b. no earlier refusal: a sparse b of many columns, where the triangular route needs more than the dense route; a
# host between the two runs the dense route, which succeeds as it did before
n, k = 20, 20000
S = bidiagonal(n)
Bs = sp.from_full(M._unmat(np.eye(n)[:, [i % n for i in range(k)]]))
tri_need = sp.small_triangular_need(n, k, False, False, True)[0]
dense_need = (sp.DENSE_A_COPIES * n * n + sp.DENSE_B_COPIES * n * k) * 8 + 3 * sp.E * 8 * 2
assert dense_need < tri_need, (dense_need, tri_need)
stand_in(dense_need)
x, routes = solve(S, Bs)
assert "triangular" not in routes and M._dims(x) == (n, k), routes
ok("no earlier refusal: a host of the dense route's need (%d) below the triangular need (%d) runs the dense route" % (dense_need, tri_need))

# 4. no earlier refusal above n = 4000: the band need admitted and the triangular need too large leaves the band; the
# counterexample (upper bidiagonal, n = 100000, k = 1) fits the triangular route at the band route's own need
n = 100000
S = bidiagonal(n, False)
b1 = col(np.ones(n))
kl, ku = sp.bandwidths(S)
nb = L.band_need(n, kl, ku, 1, False)
band_total = nb["persistent"] + max(nb["setup"], nb["step"])
tri = L.triangular_need(n, 1, False, 8)
assert tri < band_total, (tri, band_total)
stand_in(band_total)
x, routes = solve(S, b1)
assert routes == ["triangular"], routes
saved = L.triangular_need
L.triangular_need = lambda *a: band_total + 1
try:
    x, routes = solve(S, b1)
    assert routes == ["band"], routes
finally:
    L.triangular_need = saved
ok("big route: at the band's own need (%d bytes) the triangular route (%d) runs; a larger one leaves the band" % (band_total, tri))

# 5. A_SAFE: a promotion copy past A_SAFE leaves the band; the discovery's reservation refused leaves today's path
stand_in(1 << 40)
saved = L.A_SAFE
L.A_SAFE = 1000
try:
    x, routes = solve(bidiagonal(6000, cplx=True), col(np.ones(6000)))
    assert routes == ["band"], routes
finally:
    L.A_SAFE = saved
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
