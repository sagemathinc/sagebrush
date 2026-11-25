# pcg, minres, gmres, bicgstab and lsqr admitted before any vector of the problem's length is made, against stand-in
# capacity records with a sentinel in place of the first vector, so that a refused request is shown never to reach it;
# gmres's Krylov basis charged by its restart, and complex data at twice the bytes. Run by test/matlab-krylov.test.ts;
# each check prints one "ok ..." line.
import sys
import types

import numpy as np

import _matlab as M
import _matlab_krylov as K
import _matlab_numeric as N
import _matlab_sparse as sp


def ok(name):
    print("ok", name)


def stand_in(guard):
    """a measured host that allows guard bytes for one array"""
    mod = types.ModuleType("_capacity")
    mod.capacity = lambda: {"bytes": 8 << 30, "domains": ["js-heap", "js-arraybuffer"]}
    mod.effective_guard_bytes = lambda r: guard
    sp._capacity = mod
    sys.modules["_capacity"] = mod
    sys.modules.pop("_matlab_ledger", None)


class Reached(Exception):
    pass


def attempt(f):
    """f's outcome with K._vec (each vector's first copy) replaced by a sentinel"""
    saved = K._vec

    def sentinel(*a, **k):
        raise Reached()
    K._vec = sentinel
    try:
        f()
        return "made"
    except Reached:
        return "reached"
    except M.MatlabError as e:
        return e.identifier
    except MemoryError as e:
        return M._identifier(e)
    finally:
        K._vec = saved


MB = 1 << 20
B = M._B
n = 100000
col = lambda v: M._unmat(np.asarray(v).reshape(-1, 1))
E = col(np.ones(n))
D = B["horzcat"].call(1, [B["uminus"].call(1, [E]), B["times"].call(1, [2.0, E]), B["uminus"].call(1, [E])])
T = B["spdiags"].call(1, [D, M._unmat(np.array([[-1.0, 0.0, 1.0]])), float(n), float(n)])
b = col(np.arange(1.0, n + 1))
bc = col(np.arange(1.0, n + 1) * (1 + 1j))
call = lambda name, *args: (lambda: B[name].call(5, list(args)))

# (100,000 unknowns: 32 vectors at 8 bytes, about 24 MB, refused under 8 MB and reached under 100 MB, each solver)
for name, f in (("pcg", call("pcg", T, b)), ("minres", call("minres", T, b)), ("bicgstab", call("bicgstab", T, b)),
                ("lsqr", call("lsqr", T, b)), ("gmres", call("gmres", T, b, 5.0))):
    stand_in(8 * MB)
    assert attempt(f) == "MATLAB:nomem", name
    stand_in(100 * MB)
    assert attempt(f) == "reached", name
ok("each solver: its vectors admitted before the first is made (low host: nomem; ample: reached)")

# (gmres's basis, a vector for each inner iteration: a restart of 200, about 185 MB beside the short vectors' 24 MB,
# refused under 100 MB where a restart of 5 is reached; and with no restart, the basis is min(maxit, n) vectors)
for name, f, low, high in (("restart 200", call("gmres", T, b, 200.0), 100 * MB, 400 * MB),
                           ("no restart, maxit 300", call("gmres", T, b, np.zeros((0, 0)), 1e-6, 300.0), 200 * MB, 600 * MB)):
    stand_in(low)
    assert attempt(f) == "MATLAB:nomem", name
    stand_in(high)
    assert attempt(f) == "reached", name
ok("gmres's Krylov basis charged by its restart, or by maxit without one (low host: nomem; ample: reached)")

# (complex data: 16 bytes an element where real data's are 8: a host with room for the real solve exactly refuses the
# complex one)
real_admit0 = M._admit_bytes
seen = []
M._admit_bytes = lambda need, what="": seen.append(need)
try:
    attempt(call("pcg", T, b))
    nr = seen[0]
    del seen[:]
    attempt(call("pcg", T, bc))
    nc = seen[0]
finally:
    M._admit_bytes = real_admit0
assert nc > 1.5 * nr, (nr, nc)
stand_in(nr)
assert attempt(call("pcg", T, bc)) == "MATLAB:nomem"
assert attempt(call("pcg", T, b)) == "reached"
ok("complex data charged at twice the bytes (a host of the real need: complex nomem, real reached)")

# (complex arithmetic that only a preconditioner brings: gmres and pcg with A = I, b real and M1 = (1+i)I, charged as
# complex, about twice the real need; the need recorded, then a host of exactly that need reaches the first vector and
# one byte less refuses it)
needs = []
real_admit = M._admit_bytes


def record(f):
    """the needs f's admission asks for, the check itself bypassed, the solver stopped at its first vector"""
    del needs[:]
    M._admit_bytes = lambda need, what="": needs.append(need)
    try:
        attempt(f)
    finally:
        M._admit_bytes = real_admit
    return list(needs)


m = 20000
I = B["speye"].call(1, [float(m)])
Ic = B["times"].call(1, [1 + 1j, I])
ones = col(np.ones(m))
for name, f_real, f_cplx in (
        ("gmres", call("gmres", I, ones, 150.0, 1e-6, 1.0, I), call("gmres", I, ones, 150.0, 1e-6, 1.0, Ic)),
        ("pcg", call("pcg", I, ones, 1e-6, 10.0, I), call("pcg", I, ones, 1e-6, 10.0, Ic))):
    nr, nc = record(f_real)[0], record(f_cplx)[0]
    assert nc > 1.8 * nr, (name, nr, nc)
    stand_in(nc)
    assert attempt(f_cplx) == "reached", name
    stand_in(nc - 1)
    assert attempt(f_cplx) == "MATLAB:nomem", name
ok("a complex preconditioner charged as complex: exact need reached, one byte less refused (gmres, pcg)")

# (a residual history's growth admitted before each step: with 2048 entries' room beyond what the solve owns, the
# 2048th entry fits and the 2049th is refused, however many iterations maxit allows)
stand_in(1 << 40)
bud = K._Budget("a test solve")
bud.reserve(8 << 20)
room = bud.owned + K._HISTORY_ENTRY * 2048
stand_in(room)
h = K._History(bud)
for i in range(2048):
    h.append(float(i))
try:
    h.append(0.0)
    assert False, "the 2049th entry was admitted"
except MemoryError as e:
    assert M._identifier(e) == "MATLAB:nomem"
assert len(h) == 2048
ok("a residual history admitted step by step: 2048 entries fit exactly, the 2049th is refused")

stand_in(1 << 40)
taken = [0]
real_take = K._Budget.take


def counting(self):
    taken[0] += 1
    return real_take(self)


K._Budget.take = counting
try:
    small = 30
    Es = col(np.ones(small))
    Ds = B["horzcat"].call(1, [B["uminus"].call(1, [Es]), B["times"].call(1, [3.0, Es]),
                               B["times"].call(1, [-2.0, Es])])
    Ns = B["spdiags"].call(1, [Ds, M._unmat(np.array([[-1.0, 0.0, 1.0]])), float(small), float(small)])
    bs = col(np.arange(1.0, small + 1))
    for name, args, n_out in (("pcg", [Ns, bs, 1e-12, 200.0], 5), ("minres", [Ns, bs, 1e-12, 200.0], 5),
                              ("bicgstab", [Ns, bs, 1e-12, 200.0], 5), ("gmres", [Ns, bs, 3.0, 1e-12, 40.0], 5),
                              ("lsqr", [Ns, bs, 1e-12, 200.0], 6)):
        taken[0] = 0
        out = B[name].call(n_out, args)
        entries = M._numel(out[4]) + (M._numel(out[5]) if n_out == 6 else 0)
        assert taken[0] == entries and entries > 1, (name, taken[0], entries)
finally:
    K._Budget.take = real_take
ok("every solver's residual histories admitted entry by entry (taken == returned, pcg minres bicgstab gmres lsqr)")

# (a preconditioner's factors kept and admitted in the solve's own budget: a sparse M's LU reserves there, on top of
# the Krylov vectors, and a full M's factors are counted before the first vector; each refused on a host with room for
# the vectors alone)
stand_in(1 << 40)
nf = 800
Ef = col(np.ones(nf))
Df = B["horzcat"].call(1, [B["uminus"].call(1, [Ef]), B["times"].call(1, [4.0, Ef]), B["uminus"].call(1, [Ef])])
Tf = B["spdiags"].call(1, [Df, M._unmat(np.array([[-1.0, 0.0, 1.0]])), float(nf), float(nf)])
bf = col(np.arange(1.0, nf + 1))
Mfull = B["full"].call(1, [Tf])
plain = record(call("pcg", Tf, bf, 1e-6, 10.0))[0]
full_need = record(call("pcg", Tf, bf, 1e-6, 10.0, Mfull))[0]
# (a full M of 800: its factors alone 5.1 MB, past the small-need floor)
assert full_need - plain >= nf * nf * 8, (plain, full_need)
stand_in(full_need - 1)
assert attempt(call("pcg", Tf, bf, 1e-6, 10.0, Mfull)) == "MATLAB:nomem"
stand_in(full_need)
assert attempt(call("pcg", Tf, bf, 1e-6, 10.0, Mfull)) == "reached"
ok("a full preconditioner's factors counted with the Krylov vectors (one byte short: nomem; exact: reached)")

# (a function handle's results may be complex: charged at 16 bytes an element, so pcg with A a handle needs at least
# the 32 vectors at 16; and a sparse preconditioner's LU reserves in the solve's own ledger, on top of the Krylov
# vectors, so a host with room for those alone refuses it)
nh = 20000
bh = col(np.arange(1.0, nh + 1))
h_need = record(call("pcg", B["uplus"], bh, 1e-6, 10.0))[0]
assert h_need >= 16 * K._SHORT * nh, h_need
stand_in(h_need - 1)
assert attempt(call("pcg", B["uplus"], bh, 1e-6, 10.0)) == "MATLAB:nomem"
stand_in(h_need)
assert attempt(call("pcg", B["uplus"], bh, 1e-6, 10.0)) == "reached"
Th = B["spdiags"].call(1, [B["horzcat"].call(1, [B["uminus"].call(1, [bh]), B["times"].call(1, [4.0, col(np.ones(nh))]),
                                                 B["uminus"].call(1, [bh])]),
                           M._unmat(np.array([[-1.0, 0.0, 1.0]])), float(nh), float(nh)])
Lh = B["tril"].call(1, [Th])
first = record(call("pcg", Th, bh, 1e-6, 10.0, Lh))[0]
stand_in(first)
assert attempt(call("pcg", Th, bh, 1e-6, 10.0, Lh)) == "MATLAB:nomem"
ok("a handle charged as complex (exact need reached, one byte less refused); a sparse M's LU reserved on top of the vectors")


# (a preconditioner's diagonal test makes nothing larger than E entries before the admission: no sparse copy of a full
# M (from_full, np.nonzero), no bandwidth discovery of a sparse one; sentinels on all of them, and a host one byte
# short of the need refusing without touching any (the exact-need rows for a full M are the factors' row above)
saved_dd = (sp.from_full, sp._as_sparse, sp.bandwidths, np.nonzero)


def touched(*a, **k):
    raise AssertionError("a sparse copy or a discovery before the admission")


Ld = B["tril"].call(1, [Th])
Mfd = B["full"].call(1, [B["tril"].call(1, [Tf])])
for name, Mx, bx, Ax in (("full M", Mfd, bf, Tf), ("sparse M", Ld, bh, Th)):
    need = record(call("pcg", Ax, bx, 1e-6, 10.0, Mx))[0]
    sp.from_full = sp._as_sparse = sp.bandwidths = np.nonzero = touched
    try:
        stand_in(need - 1)
        assert attempt(call("pcg", Ax, bx, 1e-6, 10.0, Mx)) == "MATLAB:nomem", name
    finally:
        sp.from_full, sp._as_sparse, sp.bandwidths, np.nonzero = saved_dd
ok("a preconditioner's diagonal test copies nothing before the admission (full and sparse M; one byte short: nomem)")

# (the full diagonal test's every kernel at most E entries, on both axes, also where n > E: with E lowered to 8 and
# n = 9, a spy on count_nonzero sees no call larger than 8 entries, for a diagonal matrix and one with an off-diagonal
# entry, and the answers are right)
saved_E, saved_cnz = K.E, np.count_nonzero
sizes = []


def spy(a, *args, **kw):
    sizes.append(int(np.asarray(a).size))
    return saved_cnz(a, *args, **kw)


K.E = 8
np.count_nonzero = spy
try:
    D9 = np.diag(np.arange(1.0, 10.0))
    assert K._isdiag(M._unmat(D9), False) is True
    D9[7, 1] = 1.0
    assert K._isdiag(M._unmat(D9), False) is False
finally:
    K.E, np.count_nonzero = saved_E, saved_cnz
assert sizes and max(sizes) <= 8, sizes
ok("the full diagonal test's kernels at most E entries on both axes (E = 8, n = 9: largest %d)" % max(sizes))
