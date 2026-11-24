# rescale and normalize admitted before any copy of their data is made, against stand-in capacity records with a
# sentinel in place of the copy, so that a refused request is shown never to reach it. 160,000 elements at most.
# Run by test/matlab-prep.test.ts; each check prints one "ok ..." line.
import sys
import types

import numpy as np

import _matlab as M
import _matlab_data as D
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
    """f's outcome with D._md (the data's first copy) replaced by a sentinel: the error's identifier, or "reached" """
    saved = D._md

    def sentinel(*a, **k):
        raise Reached()
    D._md = sentinel
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
        D._md = saved


MB = 1 << 20
# (a 400-by-400 array: 160,000 elements, about 15 MB of work at 96 bytes each)
A = N._un_nd(np.zeros((400, 400)))
B = N._un_nd(np.ones((400, 400)))
C = M.Char
for name, f in (("rescale", lambda: D.rescale_(1, A)), ("normalize", lambda: D.normalize_(1, A)),
                ("normalize range", lambda: D.normalize_(3, A, C("range")))):
    stand_in(8 * MB)
    assert attempt(f) == "MATLAB:nomem", name
    stand_in(100 * MB)
    assert attempt(f) == "reached", name
ok("rescale and normalize: their work admitted before the data's first copy (low host: nomem; ample: reached)")

# (rescale's bounds as large as A count too: 160,000 elements with four bounds of the same size, about 25 MB, refused
# under 20 MB, where A alone (15 MB) fits)
stand_in(20 * MB)
assert attempt(lambda: D.rescale_(1, A)) == "reached"
assert attempt(lambda: D.rescale_(1, A, A, B, C("InputMin"), A, C("InputMax"), B)) == "MATLAB:nomem"
ok("rescale: its bounds' copies counted with the data (low host: nomem)")
