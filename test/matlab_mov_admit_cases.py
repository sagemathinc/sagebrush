# The moving statistics (movmean, movmedian and the others) admitted before any copy of their data is made, against
# stand-in capacity records with a sentinel in place of the first copy, so that a refused request is shown never to
# reach it; a moving median's windows are charged cut at the data's length, with a fill value's copies, and a window
# with no complete position under 'discard' charges none. Run by test/matlab-mov.test.ts; each check prints one
# "ok ..." line.
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
    """f's outcome with D._md (the data's first copy) replaced by a sentinel"""
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
C = M.Char
mov = lambda name, *args: (lambda: M._B[name].call(1, list(args)))

# (a 400-by-400 array: 160,000 elements, about 24 MB at 160 bytes each, whatever the statistic)
A = N._un_nd(np.zeros((400, 400)))
for name in ("movsum", "movmean", "movprod", "movmax", "movmin", "movvar", "movstd", "movmedian"):
    stand_in(8 * MB)
    assert attempt(mov(name, A, 3.0)) == "MATLAB:nomem", name
    stand_in(100 * MB)
    assert attempt(mov(name, A, 3.0)) == "reached", name
ok("each moving statistic: its elements' work admitted before the data's first copy (low host: nomem; ample: reached)")

# (a moving median of a row of 1,000: with a window of 1e9, cut at the data's length, 1,999 values an element at 40
# bytes, about 76 MB; with a fill value as well, as many again of its copies, about 153 MB; under 'discard' no window
# lies inside the data, so only the elements' 160 KB, under any host's least check)
Row = N._un_nd(np.ones((1, 1000)))
for name, f, low, high in (("window 1e9", mov("movmedian", Row, 1e9), 40 * MB, 200 * MB),
                           ("[1e9 0]", mov("movmedian", Row, N._un_nd(np.array([[1e9, 0.0]]))), 20 * MB, 200 * MB),
                           ("fill value", mov("movmedian", Row, 1e9, C("Endpoints"), 2.0), 100 * MB, 400 * MB),
                           ("fill NaN", mov("movmedian", Row, 1e9, C("Endpoints"), C("fill")), 40 * MB, 100 * MB)):
    stand_in(low)
    assert attempt(f) == "MATLAB:nomem", name
    stand_in(high)
    assert attempt(f) == "reached", name
stand_in(1 * MB)
assert attempt(mov("movmedian", Row, 1e9, C("Endpoints"), C("discard"))) == "reached"
ok("a moving median's windows charged cut at the data's length, with a fill value's copies; none under 'discard'")

# (a dimension far past the data's last is 1: no work in proportion to it, before the admission or after it, and each
# element is its own window. Along dimension 1e15 any shape padded out to it can't even be made; the charges stay
# under 2 KB)
charges = []
real_admit = M._admit_bytes
M._admit_bytes = lambda b, what="": charges.append(b)
try:
    S = N._un_nd(np.array([[1.0, np.nan, 3.0]]))
    r = M._B["movmedian"].call(1, [S, 3.0, 1e15])
finally:
    M._admit_bytes = real_admit
assert M._dims(r) == (1, 3) and np.array_equal(np.asarray(M._arr(r)).reshape(-1), [1.0, np.nan, 3.0], equal_nan=True), r
assert charges and max(charges) < 2048, charges
ok("a dimension far past the data's last costs nothing (dim 1e15, charges under 2 KB, each element alone)")
