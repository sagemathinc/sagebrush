# bitget, bitset and bitcmp admitted before their work, against stand-in capacity records with a sentinel in place
# of the first reading of A's values, so that a refused request is shown never to reach it. 160,000 elements at most.
# Run by test/matlab-bits.test.ts; each check prints one "ok ..." line.
import sys
import types

import numpy as np

import _matlab as M
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
    saved = M._bit_patterns

    def sentinel(*a, **k):
        raise Reached()
    M._bit_patterns = sentinel
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
        M._bit_patterns = saved


MB = 1 << 20
# (a 400-by-400 array: 160,000 elements, about 41 MB at 256 bytes each with the bit positions' 160,000 more)
A = N._un_nd(np.zeros((400, 400)))
for name, f in (("bitget", lambda: M._B["bitget"].call(1, [A, A + 1.0])),
                ("bitset", lambda: M._B["bitset"].call(1, [A, 1.0])),
                ("bitcmp", lambda: M._B["bitcmp"].call(1, [A]))):
    stand_in(8 * MB)
    assert attempt(f) == "MATLAB:nomem", name
    stand_in(200 * MB)
    assert attempt(f) == "reached", name
ok("bitget, bitset and bitcmp: their work admitted before A's values are read (low host: nomem; ample: reached)")
