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

# (complex data: 16 bytes an element, about 49 MB for pcg's vectors, refused under 30 MB where real data's 24 MB is
# reached)
stand_in(30 * MB)
assert attempt(call("pcg", T, bc)) == "MATLAB:nomem"
assert attempt(call("pcg", T, b)) == "reached"
ok("complex data charged at twice the bytes (30 MB host: complex nomem, real reached)")
