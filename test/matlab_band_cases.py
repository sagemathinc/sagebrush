# MATLAB mode's sparse solves, rank-13 PR 2 (plan-matlab-nocliffs r6
# sections 2.2's band rows, 2.4, 2.4a, 2.5, 2.8; ruling d2): the chunked
# bandwidths, the chunked band path, the cost route and its admission
# fallback, the full and dense admissions, and the browser interim.  Run
# under the engine by test/matlab-band.test.ts: each check prints one
# "ok ..." line, and any failure raises.
import numpy as np
import _matlab_sparse as sp
import _matlab_lu as L
import _matlab_ledger as LG

# (the first-use fix: these cases test the admission itself, as reviewed (no floor, delta s1 r3), so they run with the
# small-need floor off through its seam; test/matlab_firstuse_cases.py tests the floor)
sp.SMALL_NEED = 0
import _matlab as M

seed = [4242]


def rnd():
    seed[0] = (seed[0] * 1103515245 + 12345) % 2147483648
    return seed[0] / 2147483648.0


def ok(name):
    print("ok", name)


def make(n, ent, m=None):
    return sp.make(m or n, n, np.array([e[0] for e in ent], dtype=np.int64), np.array([e[1] for e in ent], dtype=np.int64),
                   np.array([e[2] for e in ent]))


def band_matrix(n, kl, ku, cplx=False, zero_col=None, diag=3.0):
    ent = []
    for j in range(n):
        if j == zero_col:
            continue
        for i in range(max(0, j - ku), min(n, j + kl + 1)):
            v = rnd() * 2 - 1 + (diag if i == j else 0.0)
            ent.append((i, j, complex(v, rnd()) if cplx else v))
    return make(n, ent)


def old_bandwidths(S):
    # (master's formula, for the exact comparison: the chunked scan is a deliberate change)
    if not S.pr.size:
        return 0, 0
    d = sp._cols(S) - S.ir
    return int(max(0, -int(np.min(d)))), int(max(0, int(np.max(d))))


class Cap:
    """a capacity record that measures (both JS domains) with allowance g"""

    def __init__(self, g, domains=("js-heap", "js-arraybuffer"), nbytes=None):
        self.g = g
        self.rec = {"bytes": g if nbytes is None else nbytes, "domains": list(domains), "basis": [], "unknown_parts": []}
        self.reads = 0

    def capacity(self):
        self.reads += 1
        return dict(self.rec)

    def effective_guard_bytes(self, rec):
        return self.g


real_L, real_sp, real_LG = L._capacity, sp._capacity, LG._capacity


def use(cap):
    L._capacity = cap
    sp._capacity = cap
    LG._capacity = cap


def restore():
    L._capacity, sp._capacity, LG._capacity = real_L, real_sp, real_LG
    L._routes = None
    LG._recorder = None
    L.E, L.A_SAFE = sp.E, sp.A_SAFE


class Shim:
    """the numpy module as _matlab_sparse sees it, recording each array a call
    takes or returns (r6 section 2.8's instrumentation, for bandwidths)"""

    def __init__(self, np_):
        self._np = np_
        self.sizes = []

    def __getattr__(self, name):
        f = getattr(self._np, name)
        if not callable(f) or isinstance(f, type):
            return f

        def wrapped(*a, **k):
            for x in a:
                if isinstance(x, self._np.ndarray):
                    self.sizes.append(x.size)
            r = f(*a, **k)
            if isinstance(r, self._np.ndarray):
                self.sizes.append(r.size)
            return r
        return wrapped


# -- 1. bandwidths: chunked on both axes, exactly master's result
fixtures = [band_matrix(30, 3, 2), band_matrix(30, 0, 5), band_matrix(40, 7, 0), band_matrix(25, 0, 0)]
fixtures.append(make(50, [(int(rnd() * 50), int(rnd() * 50), 1.0) for _ in range(300)]))
fixtures.append(make(40, [(i, 5, 1.0) for i in range(40)] + [(0, 0, 2.0), (39, 39, 1.0)]))
fixtures.append(make(60, [(59, 0, 1.0), (0, 59, 1.0)]))
fixtures.append(make(20, [], 20))
for S in fixtures:
    for step in (None, 8, 3, 1):
        assert sp.bandwidths(S, step) == old_bandwidths(S), (sp.bandwidths(S, step), old_bandwidths(S), step)
ok("bandwidths: chunked (E, 8, 3, 1) gives master's exact result on band, random, long-column, corner and empty fixtures")
# (the adversarial empty-column fixture: n = 64 E, one nonzero in the last column)
e = 8
S = make(64 * e, [(3, 64 * e - 1, 1.0)])
units = []
want = old_bandwidths(S)
shim = Shim(np)
sp.np = shim
try:
    got = sp.bandwidths(S, e, units.append)
finally:
    sp.np = np
assert got == want
assert len(units) == 64 and sum(units) == S.n + 64 + 1, (len(units), sum(units))
assert max(shim.sizes) <= e + 1, max(shim.sizes)
ok("bandwidths: the empty-column fixture n = 64E costs exactly n + K + nnz (K = 64), no call over E + 1 entries")
# (dropping the jc charge, or master's _cols(S) - S.ir, is caught)
assert sum(units) - len(units) - 64 != S.n + 64 + 1
shim = Shim(np)
sp.np = shim
try:
    old_bandwidths(S)
finally:
    sp.np = np
big = make(40, [(i, 5, 1.0) for i in range(40)] + [(i, i, 1.0) for i in range(40)])
shim = Shim(np)
sp.np = shim
try:
    old_bandwidths(big)
    old_max = max(shim.sizes)
    shim.sizes = []
    units = []
    sp.bandwidths(big, e, units.append)
finally:
    sp.np = np
assert old_max > e + 1 and max(shim.sizes) <= e + 1, (old_max, max(shim.sizes))
shim = Shim(np)
sp.np = shim
try:
    sp.bandwidths(big, e)
finally:
    sp.np = np
assert max(shim.sizes) <= e + 1, ("the uncharged scan", max(shim.sizes))
assert sum(units) == big.n + len(units) + int(big.jc[big.n]), (sum(units), len(units))
ok("bandwidths: master's formula (the mutant) takes calls of nnz entries; a long column is scanned in slices of E, charged exactly")


# -- 2. the band path: master's answers, kernels of at most E, its work exact
def band_work(n, kl, ku, k, piv_zero=()):
    w = 0
    for s in range(n):
        if s in piv_zero:
            continue
        last, hi = min(n - 1, s + kl), min(n - 1, s + kl + ku)
        w += (last - s) * (hi - s) + (last - s) * k
    for s in range(n):
        w += (min(n - 1, s + kl + ku) - s) * k
    return w


use(Cap(10 ** 12))
try:
    for cplx in (False, True):
        for (n, kl, ku) in ((30, 3, 2), (25, 0, 4), (25, 5, 0), (20, 6, 6), (12, 11, 11)):
            S = band_matrix(n, kl, ku, cplx)
            for k in (1, 3, 9):
                B = np.array([[complex(rnd(), rnd()) if cplx and k == 3 else rnd() for _ in range(k)] for _ in range(n)])
                X0 = sp._legacy_band_solve(S, B.copy())
                for e2, asafe in ((None, None), (8, 256), (4, 128)):
                    if e2 and (2 * kl + ku + 1) * (16 if cplx else 8) > asafe:
                        # (one band column past A_SAFE: no band path, a route to LU)
                        L.E, L.A_SAFE = e2, asafe
                        try:
                            assert L.band_need(n, kl, ku, k, cplx) is None
                        finally:
                            L.E, L.A_SAFE = sp.E, sp.A_SAFE
                        continue
                    if e2:
                        L.E, L.A_SAFE = e2, asafe
                    LG._recorder = []
                    W = L.Work("t")
                    try:
                        X1, sing = L.band_solve(S, B.copy(), kl, ku, L.Ledger("t"), W)
                        kern = [r[1] for r in LG._recorder if r[0] == "kernel"]
                        allocs = [r[2] for r in LG._recorder if r[0] == "alloc"]
                    finally:
                        LG._recorder = None
                        L.E, L.A_SAFE = sp.E, sp.A_SAFE
                    assert float(np.max(np.abs(X1 - X0))) <= 1e-10 * max(1.0, float(np.max(np.abs(X0)))), (n, kl, ku, k, e2, cplx)
                    assert not sing
                    assert W.used == band_work(n, kl, ku, k), (W.used, band_work(n, kl, ku, k), n, kl, ku, k)
                    if e2:
                        assert max(kern) <= e2 and max(allocs) <= asafe, (max(kern), max(allocs), e2)
    ok("band: master's answers (real, complex, k = 1, 3, 9; E = 8, 4 segmented); every kernel <= E, allocation <= A_SAFE; work exact")
    # (a zero column: master's warning case, the same non-finite pattern)
    S = band_matrix(20, 2, 2, zero_col=7)
    B = np.ones((20, 2))
    X0 = sp._legacy_band_solve(S, B.copy())
    X1, sing = L.band_solve(S, B.copy(), 2, 2, L.Ledger("t"), L.Work("t"))
    fin = np.isfinite(X0)
    assert sing and np.array_equal(fin, np.isfinite(X1))
    if fin.any():
        assert float(np.max(np.abs(X1[fin] - X0[fin]))) <= 1e-10 * max(1.0, float(np.max(np.abs(X0[fin]))))
    ok("band: a zero pivot is skipped as master's (singular, the same non-finite entries)")
finally:
    restore()


# -- 3. band_need: the phases' exact bytes, and tight admission
def need_formula(n, kl, ku, k, cplx, E, A_SAFE):
    cv = 16 if cplx else 8
    ldab = 2 * kl + ku + 1
    kc = min(k, E)
    ab, xb = n * ldab * cv, n * kc * cv
    seg = ab > A_SAFE or xb > A_SAFE

    def s0(b):
        nb = -(-b // A_SAFE) if b > A_SAFE else 0
        return L.C_LIST + nb * (L.C_PTR + L.C_HDR) if nb else 0
    route = 3 * E * 8 + E * 1 + E * cv if seg else 0
    pers = ab + xb + (n * k * cv if (k > E or xb > A_SAFE) else 0) + n * 8 + s0(ab) + s0(xb) + 4 * L.C_HDR
    return pers + max(5 * E * 8 + E * cv + route, 3 * E * 8 + 4 * E * cv + route)


def phases(n, kl, ku, k, cplx, E, A_SAFE):
    cv = 16 if cplx else 8
    ldab = 2 * kl + ku + 1
    seg = n * ldab * cv > A_SAFE or n * min(k, E) * cv > A_SAFE
    route = 3 * E * 8 + E * 1 + E * cv if seg else 0
    return 5 * E * 8 + E * cv + route, 3 * E * 8 + 4 * E * cv + route


for args, lowered in (((5000, 3, 2, 1, False), None), ((5000, 3, 2, 20000, True), None), ((100000, 50, 50, 2, True), None),
                      ((300, 3, 2, 2, True), (8, 256)), ((300, 3, 2, 20, False), (8, 256))):
    if lowered:
        L.E, L.A_SAFE = lowered
    try:
        nb = L.band_need(*args)
        E_, AS = L.E, L.A_SAFE
    finally:
        L.E, L.A_SAFE = sp.E, sp.A_SAFE
    assert nb["persistent"] + max(nb["setup"], nb["step"]) == need_formula(*args, E_, AS), args
    assert (nb["setup"], nb["step"]) == phases(*args, E_, AS), (args, nb)
# (and the path reserves exactly those: persistent + setup, then the step allowance)
use(Cap(10 ** 12))
try:
    L.E, L.A_SAFE = 8, 256
    S = band_matrix(40, 3, 2, True)
    nb = L.band_need(40, 3, 2, 2, True)
    LG._recorder = []
    L.band_solve(S, np.ones((40, 2)), 3, 2, L.Ledger("t"), L.Work("t"))
    res = [(r[3], r[2]) for r in LG._recorder if r[0] == "reserve"]
finally:
    restore()
assert res == [("band", nb["persistent"] + nb["setup"]), ("band-step", nb["step"])], res
ok("band: M_band and each phase's reservation are exactly the phase formulas (plain and segmented storage)")

n = 4001
T = band_matrix(n, 2, 1)
b = np.ones((n, 1))
nb = L.band_need(n, 2, 1, 1, False)
m_band = nb["persistent"] + max(nb["setup"], nb["step"])
disc = 4 * L.E * L.C_IDX
saved_costs = dict(L.COSTS["cli"])
saved_floor = sp.legacy_band_route
try:
    L._routes = []
    use(Cap(m_band))
    LG._recorder = []
    try:
        X, s = L.solve(T, b, "t")
        tags = [r[3] for r in LG._recorder if r[0] == "reserve"]
    finally:
        LG._recorder = None
    # (master's route takes band here, (2 kl + ku + 1) n = 24006 <= 2^28 and n (kl + 1)(kl + ku + 1) = 48012 <= 2^29,
    # so the amendment r1 floor takes it at once, though T_band = 0.4087 is over c_ord nnz = 9.2e-6 * 16000 = 0.1472:
    # no ordering)
    assert L._routes == ["band"] and tags == ["discovery", "band", "band-step"], (L._routes, tags)
    X0 = sp._legacy_band_solve(T, b.copy())
    assert float(np.max(np.abs(X - X0))) == 0.0
    ok("route: a tridiagonal-like n = 4001 system takes the band path at once (master's route as the floor, no ordering), with master's band answer exactly; G = M_band admits it")
    # (one byte less: band is refused; the LU, whose own need is larger here, too: one refusal, naming both)
    use(Cap(m_band - 1))
    L._routes = []
    try:
        L.solve(T, b, "t")
        raise AssertionError("no refusal")
    except MemoryError as e:
        assert "band path needs %d bytes" % m_band in str(e).splitlines()[0] or "band path needs" in str(e), str(e)
        assert e.need_bytes <= m_band
    ok("route: G = M_band - 1 refuses band; neither path admitted gives one refusal naming both needs")
    # (the route-only mutant: no floor and a band estimate never chosen is caught by the route assertion)
    use(Cap(10 ** 12))
    L.COSTS["cli"]["band"] = 1.0
    sp.legacy_band_route = lambda n, kl, ku: False
    L._routes = []
    L.solve(T, b, "t")
    assert L._routes == ["lu"], L._routes
    L.COSTS["cli"].update(saved_costs)
    sp.legacy_band_route = saved_floor
    ok("route: the route-only mutant (no floor, band never cheaper) takes LU, so the band-route assertion kills it")
finally:
    L.COSTS["cli"].update(saved_costs)
    sp.legacy_band_route = saved_floor
    restore()

# (the pre-order shortcut, its own row: band(4001, 8, 8) has T_band = 0.5103 <= c_ord nnz = 9.2e-6 * 67945 = 0.6251
# under the incumbent COSTS (a margin of 1.225), so band is taken at once, with no ordering)
n = 4001
T8 = band_matrix(n, 8, 8)
b = np.ones((n, 1))
try:
    use(Cap(10 ** 12))
    L._routes = []
    LG._recorder = []
    try:
        X, s = L.solve(T8, b, "t")
        tags = [r[3] for r in LG._recorder if r[0] == "reserve"]
    finally:
        LG._recorder = None
    assert L._routes == ["band"] and tags == ["discovery", "band", "band-step"], (L._routes, tags)
    X0 = sp._legacy_band_solve(T8, b.copy())
    assert float(np.max(np.abs(X - X0))) == 0.0
    ok("route: band(4001, 8, 8) takes the band path at once (the pre-order shortcut, no ordering), with master's band answer exactly")
finally:
    restore()

# (the floor is master's predicate exactly, at both of its edges: the storage (2 kl + ku + 1) n <= 2^28 and the
# work n (kl + 1)(kl + ku + 1) <= 2^29)
assert sp.legacy_band_route(1 << 20, 0, 255) and not sp.legacy_band_route(1 << 20, 0, 256)
assert sp.legacy_band_route(1 << 19, 3, 252) and not sp.legacy_band_route(1 << 19, 3, 253)
ok("route: the floor is master's band predicate at its storage and work edges")

# (where master's route doesn't take band, the cost route decides as before: an arrow, kl = ku = n - 1, whose band
# work n^2 (2n - 1) is over 2^29, takes the ordering and the LU)
n = 4001
ent = [(j, j, 4.0 + rnd()) for j in range(n)] + [(0, j, rnd()) for j in range(1, n)] + [(j, 0, rnd()) for j in range(1, n)]
W = make(n, ent)
b = np.ones((n, 1))
try:
    use(Cap(10 ** 12))
    L._routes = []
    LG._recorder = []
    try:
        X, s = L.solve(W, b, "t")
        tags = [r[3] for r in LG._recorder if r[0] == "reserve"]
    finally:
        LG._recorder = None
    assert not sp.legacy_band_route(n, n - 1, n - 1)
    assert L._routes == ["lu"] and "ordering" in tags and "band" not in tags, (L._routes, tags)
    # (the residual through the runtime's own sparse product: its numpy has no ufunc .at)
    AX = M._mat(sp.binop("mtimes", W, M._unmat(X)))
    assert float(np.max(np.abs(AX - b))) < 1e-9
    ok("route: an arrow (master's route takes LU) keeps the cost route: the ordering, then the LU")
finally:
    restore()


# -- 4. the fallback table (r6 section 2.4a)
def peak_of(fn):
    LG._recorder = []
    try:
        fn()
        ev = LG._recorder
    finally:
        LG._recorder = None
    return max(r[1] for r in ev if r[0] == "reserve")


n = 4001
R = make(n, [(j, j, 4.0) for j in range(n)] + [(int(rnd() * n), int(rnd() * n), rnd() - 0.5) for _ in range(2 * n)])
kl, ku = sp.bandwidths(R)
b = np.ones((n, 1))
try:
    use(Cap(10 ** 12))
    # (R's LU estimate is over L.SLOW_LU_WARN_S, so its first solve here, the peak measurement, shows the slow-LU
    # warning, the first for n = 4001 in this session, and the LU-only solve below shows nothing (once per session per
    # n).  Both solves are caught rather than left on stderr; later 4001 solves stay silent until section 7 re-arms it)
    shown4, real_err4 = [], M._write_err
    M._write_err = shown4.append
    try:
        lu_peak = peak_of(lambda: L.solve(R, b, "t"))
        n_peak = len(shown4)
        nbR = L.band_need(n, kl, ku, 1, False)
        mR = nbR["persistent"] + max(nbR["setup"], nbR["step"])
        assert mR > lu_peak, (mR, lu_peak)
        # LU-only feasible: band's need (a wide band) is beyond G, the LU's peak isn't
        use(Cap(lu_peak))
        L._routes = []
        X, s = L.solve(R, b, "t")
    finally:
        M._write_err = real_err4
    assert L._routes == ["lu"]
    assert n_peak == 1 and len(shown4) == 1, (n_peak, shown4)
    assert shown4[0].startswith("Warning: Solving this 4001x4001 sparse system by its sparse LU"), shown4
    ok("fallback: LU-only feasible (band's need beyond G): the LU, at exactly its peak")
    # band-only, at step 3: the ordering is refused and band fits (a cheap band forced by the cost seam).  These
    # fallback rows exercise the cost route's steps 3-5, so the routing floor (master's band route, which would take
    # band(4001, 3, 3) at once) is turned off here and restored in this section's finally
    sp.legacy_band_route = lambda n, kl, ku: False
    Tb = band_matrix(n, 3, 3)
    nbT = L.band_need(n, 3, 3, 1, False)
    mT = nbT["persistent"] + max(nbT["setup"], nbT["step"])
    L.COSTS["cli"]["band"] = 1e-3
    L.COSTS["cli"]["ord"] = 1e-12
    use(Cap(mT))
    L._routes = []
    LG._recorder = []
    try:
        L.solve(Tb, b, "t")
        ev = LG._recorder
    finally:
        LG._recorder = None
    assert L._routes == ["band"], L._routes
    tags = [r[3] for r in ev if r[0] == "reserve"]
    assert "ordering" in tags and tags.index("ordering") < tags.index("band"), tags
    assert [r for r in ev if r[0] == "reserve" and r[3] == "ordering"][0][1] > mT
    ok("fallback: band-only at step 3 (the ordering's admission tried and refused): band")
    # band-only, at step 5: the LU is preferred, then refused part way; the ledger returns, band runs
    L.COSTS["cli"]["band"] = 1.0
    L._routes = []
    led_seen = []
    real_factor = L.factor

    def watched(S, what, **kw):
        led_seen.append(kw["ledger"].owned)
        try:
            return real_factor(S, what, **kw)
        finally:
            led_seen.append(kw["ledger"].owned)
    L.factor = watched
    # (G: the ordering fits, the LU's factor doesn't, band does)
    use(Cap(10 ** 12))
    LG._recorder = []
    try:
        L.ordering(Tb, L.Ledger("t"), L.Work("t"))
        ord_peak = max(r[1] for r in LG._recorder if r[0] == "reserve")
    finally:
        LG._recorder = None
    G = max(ord_peak, mT) + 1
    LG._recorder = []
    try:
        use(Cap(G))
        X, s = L.solve(Tb, b, "t")
        ev = LG._recorder
    finally:
        LG._recorder = None
        L.factor = real_factor
    assert L._routes == ["band"], L._routes
    assert len(led_seen) == 2, led_seen
    band_first = [r for r in ev if r[0] == "reserve" and r[3] == "band"][0]
    assert band_first[1] == band_first[2], ("the LU's bytes left in the ledger", band_first)
    X0 = sp._legacy_band_solve(Tb, b.copy())
    assert float(np.max(np.abs(X - X0))) == 0.0
    ok("fallback: band-only at step 5 (the LU preferred, refused part way): the ledger back to empty, then band, master's answer")
finally:
    L.COSTS["cli"].update(saved_costs)
    sp.legacy_band_route = saved_floor
    restore()


# -- 5. ruling d2: measured hosts never reach master's caps or the legacy code
def poison(*names):
    saved = {}
    for nm in names:
        saved[nm] = getattr(sp, nm)

        def bad(*a, _nm=nm, **k):
            raise AssertionError("a measured host called " + _nm)
        setattr(sp, nm, bad)
    return saved


S400 = band_matrix(400, 2, 2)
T = band_matrix(4001, 2, 1)
D = band_matrix(300, 300, 300)
b4 = np.ones((4001, 1))
try:
    want_full = sp._legacy_full_arr(S400)
    use(Cap(10 ** 12))
    keep = (sp.MAX_FULL, sp.MAX_BAND_WORK)
    saved = poison("_legacy_full_arr", "_legacy_mldivide", "_legacy_band_solve", "_legacy_lu")
    sp.MAX_FULL, sp.MAX_BAND_WORK = 0, 0
    try:
        assert np.array_equal(sp.full_arr(S400), want_full)
        x1 = M._mat(sp.mldivide(T, M._unmat(b4)))
        x2 = M._mat(sp.mldivide(R, M._unmat(b4)))
        x3 = M._mat(sp.mldivide(D, M._unmat(np.ones((300, 1)))))
    finally:
        sp.MAX_FULL, sp.MAX_BAND_WORK = keep
        for nm, f in saved.items():
            setattr(sp, nm, f)
    assert np.all(np.isfinite(x1)) and np.all(np.isfinite(x2)) and np.all(np.isfinite(x3))
    ok("d2: measured, with MAX_FULL = MAX_BAND_WORK = 0 and every legacy function poisoned: full, band, LU and dense solves succeed")
    # (unmeasured: the same patch makes full refuse with master's error, and n > 4000 takes master's route)
    use(Cap(4 << 30, domains=("wasm-engine",)))
    calls = []
    real_lb = sp._legacy_band_solve

    def counted(*a):
        calls.append(1)
        return real_lb(*a)
    sp._legacy_band_solve = counted
    try:
        y = M._mat(sp.mldivide(T, M._unmat(b4)))
        sp.MAX_FULL = 0
        try:
            sp.full_arr(S400)
            raise AssertionError("no refusal")
        except Exception as e:
            assert getattr(e, "identifier", "") == "MATLAB:array:SizeLimitExceeded", e
        finally:
            sp.MAX_FULL = keep[0]
    finally:
        sp._legacy_band_solve = real_lb
    assert calls == [1] and float(np.max(np.abs(y - x1))) <= 1e-12
    ok("d2: unmeasured (wasm-engine only): master's band route and caps, the same answer; full refuses past MAX_FULL")
    # (a measured zero is measured: refused by admission, never legacy)
    use(Cap(0))
    try:
        sp.full_arr(S400)
        raise AssertionError("no refusal")
    except Exception as e:
        assert getattr(e, "identifier", "") == "MATLAB:array:SizeLimitExceeded" and getattr(e, "record", None) is not None, e
    ok("d2: a measured zero refuses full by admission (its record attached), not by the legacy cap")
finally:
    restore()


# -- 6. delta (s1) r3: one fresh capacity record per measured operation, no floor, no cache
try:
    cap = Cap(10 ** 12)
    use(cap)
    for i in range(3):
        before = cap.reads
        sp.full_arr(band_matrix(30, 1, 1))
        assert cap.reads == before + 1, (i, cap.reads - before)
    before = cap.reads
    M._mat(sp.mldivide(band_matrix(300, 300, 300), M._unmat(np.ones((300, 1)))))
    assert cap.reads == before + 1, cap.reads - before
    before = cap.reads
    M._mat(sp.mldivide(band_matrix(4001, 2, 1), M._unmat(np.ones((4001, 1)))))
    assert cap.reads == before + 1, cap.reads - before
    ok("s1: each measured full(), dense solve and n > 4000 sparse solve reads exactly one fresh record, its phases sharing it")
    # (aggregate: results kept while the record's G shrinks by what each keeps)
    S = band_matrix(200, 1, 1)
    need = sp._full_need(S)

    class Shrinking(Cap):
        def capacity(self):
            self.reads += 1
            r = dict(self.rec)
            r["bytes"] = self.g
            return r

    cap = Shrinking(3 * need)
    use(cap)
    kept = []
    try:
        for i in range(5):
            kept.append(sp.full_arr(S))
            cap.g -= need
        raise AssertionError("no refusal")
    except Exception as e:
        assert getattr(e, "identifier", "") == "MATLAB:array:SizeLimitExceeded" and len(kept) == 3, (len(kept), e)
        assert e.need_bytes == need and e.limit_bytes == 0
    ok("s1: kept results shrink each fresh record's G; the call whose need passes its own G is refused, before it allocates")
    # (the cached-record mutant: reusing the previous record fails the exactly-once count)
    real_rec = sp._capacity_record
    memo = []

    def cached():
        if not memo:
            memo.append(real_rec())
        return memo[0]
    sp._capacity_record = cached
    cap = Cap(10 ** 12)
    use(cap)
    try:
        before = cap.reads
        sp.full_arr(band_matrix(30, 1, 1))
        sp.full_arr(band_matrix(30, 1, 1))
        assert cap.reads - before == 1
    finally:
        sp._capacity_record = real_rec
    ok("s1: the cached-record mutant reads one record for two operations, which the exactly-once check catches")
finally:
    restore()


# -- 7. the slow-LU warning (William, Oct 28 2026: decision A on the 4000/4001 boundary, with a warning): before a
# factorization whose estimate t_lu >= L.SLOW_LU_WARN_S starts, once per session per n, through MATLAB's warning
# machinery (silenced by warning('off', id), lastwarn either way, re-armed by warning('on', id)), on stderr
def random3(n):
    ent = []
    for j in range(n):
        ent.append((j, j, 4.0))
        for _ in range(3):
            ent.append((int(rnd() * n), j, rnd() - 0.5))
    return make(n, ent)


class _Factoring(Exception):
    pass


shown = []
real_err, real_factor, real_warn_s = M._write_err, L.factor, L.SLOW_LU_WARN_S


def wstate(st):
    M.warning_b(0, M.Char(st), M.Char(L.SLOW_LU_ID))


def stop_at_factor(*a, **k):
    raise _Factoring()


def until_factor(S):
    """L.solve(S) up to the factorization (seamed out): what was shown before it starts"""
    before = len(shown)
    L.factor = stop_at_factor
    try:
        L.solve(S, np.ones((S.n, 1)), "t")
        reached = False
    except _Factoring:
        reached = True
    finally:
        L.factor = real_factor
    return reached, shown[before:]


try:
    use(Cap(10 ** 12))
    assert not M._doc_layout()
    M._write_err = lambda s: shown.append(s)
    M._warn_once.clear()
    M._lastwarn[:] = ["", ""]
    # (random3(4001): the inv1 row's family; its LU estimate is over the threshold, so it warns before factoring)
    R3 = random3(4001)
    reached, out = until_factor(R3)
    assert reached and len(out) == 1 and out[0].startswith("Warning: Solving this 4001x4001 sparse system by its sparse LU"), out
    assert M._lastwarn[1] == L.SLOW_LU_ID, M._lastwarn
    reached, out = until_factor(R3)
    assert reached and out == [], out
    ok("slow LU: random3(4001) warns once, on stderr and before its factorization starts; a repeat in the session shows nothing")
    wstate("off")
    M._lastwarn[:] = ["", ""]
    wstate("on")
    reached, out = until_factor(R3)
    assert reached and len(out) == 1 and M._lastwarn[1] == L.SLOW_LU_ID, out
    wstate("off")
    M._warn_once.clear()
    M._lastwarn[:] = ["", ""]
    reached, out = until_factor(R3)
    assert reached and out == [] and M._lastwarn[1] == L.SLOW_LU_ID, (out, M._lastwarn)
    wstate("on")
    ok("slow LU: warning('on', id) re-arms it; warning('off', id) silences it, and lastwarn records it either way")
    # (never below the threshold, or off the LU route: random3(4000) (dense), a tridiagonal and an arrow at 4001)
    M._warn_once.clear()
    before = len(shown)
    M._mat(sp.mldivide(random3(4000), M._unmat(np.ones((4000, 1)))))
    M._mat(sp.mldivide(band_matrix(4001, 1, 1), M._unmat(np.ones((4001, 1)))))
    n = 4001
    A = make(n, [(j, j, 4.0 + rnd()) for j in range(n)] + [(0, j, rnd()) for j in range(1, n)] + [(j, 0, rnd()) for j in range(1, n)])
    L._routes = []
    XA = M._mat(sp.mldivide(A, M._unmat(np.ones((n, 1)))))
    assert L._routes == ["lu"] and shown[before:] == [], (L._routes, shown[before:])
    ok("slow LU: no warning for random3(4000) (dense), a tridiagonal(4001) (band) or a cheap LU (an arrow at 4001)")
    # (the result is byte-identical with the warning shown: the arrow's LU with the threshold at 0)
    L.SLOW_LU_WARN_S = 0.0
    M._warn_once.clear()
    before = len(shown)
    XW = M._mat(sp.mldivide(A, M._unmat(np.ones((n, 1)))))
    assert len(shown) == before + 1 and XW.tobytes() == XA.tobytes()
    ok("slow LU: the warning changes no result (the same LU, byte for byte, with and without it)")
    # (the browser's interim, master's route, never reaches it: an unmeasured record, threshold 0.  The arrow here has
    # its hub at n - 1, the last row and column, so master's LU, which orders no columns, solves it with no fill; the
    # hub-at-0 arrow above fills in completely and master's LU rightly refuses it)
    He = make(n, [(j, j, 4.0 + rnd()) for j in range(n)] + [(n - 1, j, rnd()) for j in range(n - 1)] + [(j, n - 1, rnd()) for j in range(n - 1)])
    use(Cap(10 ** 12, domains=("js-heap",)))
    M._warn_once.clear()
    before = len(shown)
    M._mat(sp.mldivide(He, M._unmat(np.ones((n, 1)))))
    assert shown[before:] == [], shown[before:]
    ok("slow LU: the unmeasured (browser) path, master's route, never warns")
finally:
    M._write_err, L.factor, L.SLOW_LU_WARN_S = real_err, real_factor, real_warn_s
    M._warn_once.clear()
    restore()
