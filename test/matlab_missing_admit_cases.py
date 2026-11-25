# rmmissing and fillmissing admitted before any copy of their data is made, against stand-in capacity records with a
# sentinel in place of the first copy, so that a refused request is shown never to reach it; including the shapes
# whose work is in their vectors (an empty array of many columns, a single row) and in one long vector's fill.
# Run by test/matlab-missing.test.ts; each check prints one "ok ..." line.
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
    """f's outcome with D._md (the data's first copy) and D._standard_missing replaced by sentinels"""
    saved = D._md, D._standard_missing

    def sentinel(*a, **k):
        raise Reached()
    D._md = D._standard_missing = sentinel
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
        D._md, D._standard_missing = saved


MB = 1 << 20
C = M.Char
# (a 400-by-400 array: 160,000 elements, about 15 MB at 96 bytes each, with 400 vectors and one 400-long fill)
A = N._un_nd(np.zeros((400, 400)))
for name, f in (("rmmissing", lambda: D.rmmissing_(2, A)), ("fillmissing", lambda: D.fillmissing_(2, A, C("linear"))),
                ("fillmissing constant", lambda: D.fillmissing_(2, A, C("constant"), 0.0))):
    stand_in(8 * MB)
    assert attempt(f) == "MATLAB:nomem", name
    stand_in(100 * MB)
    assert attempt(f) == "reached", name
ok("rmmissing and fillmissing: their work admitted before the data's first copy (low host: nomem; ample: reached)")

# (the shapes whose work isn't in their elements: an empty 0-by-300000 array, 300,000 vectors at 128 bytes; a row of
# 100,000 filled along its length, one 100,000-long fill at 768 bytes an element on top of the elements' 96)
E = N._un_nd(np.ones((0, 300000)))
Row = N._un_nd(np.ones((1, 100000)))
for name, f, low in (("empty", lambda: D.rmmissing_(2, E, 1.0), 20 * MB),
                     ("empty fill", lambda: D.fillmissing_(2, E, C("linear"), 1.0), 20 * MB),
                     ("row spline", lambda: D.fillmissing_(2, Row, C("spline")), 40 * MB)):
    stand_in(low)
    assert attempt(f) == "MATLAB:nomem", name
    stand_in(200 * MB)
    assert attempt(f) == "reached", name
ok("rmmissing and fillmissing: vectors' and a long vector's work counted before any copy (low host: nomem)")

# (rmmissing's bookkeeping for each slice along the dimension, its counts, TF and index, counted before any copy: an
# empty 300000-by-0 array along its first dimension, by default and given, and a 0-by-300000 along the second, 300,000
# slices at 128 bytes, refused under 8 MB; and fillmissing's moving median, each element's window sorted: a row of
# 1,000 with a window of 1,000, and of 1e9, cut to the data's length, refused under 8 MB and 40 MB)
Tall = N._un_nd(np.zeros((300000, 0)))
Wide = N._un_nd(np.zeros((0, 300000)))
Row1k = N._un_nd(np.concatenate([[np.nan], np.ones(999)]).reshape(1, -1))
for name, f, low, high in (("tall default", lambda: D.rmmissing_(2, Tall), 8 * MB, 100 * MB),
                           ("tall dim 1", lambda: D.rmmissing_(2, Tall, 1.0), 8 * MB, 100 * MB),
                           ("wide dim 2", lambda: D.rmmissing_(2, Wide, 2.0), 8 * MB, 100 * MB),
                           ("movmedian 1000", lambda: D.fillmissing_(2, Row1k, C("movmedian"), 1000.0), 8 * MB, 100 * MB),
                           ("movmedian 1e9", lambda: D.fillmissing_(2, Row1k, C("movmedian"), 1e9), 40 * MB, 200 * MB)):
    stand_in(low)
    assert attempt(f) == "MATLAB:nomem", name
    stand_in(high)
    assert attempt(f) == "reached", name
ok("rmmissing's slices and fillmissing's moving-median windows counted before any copy (low host: nomem)")

# (a dimension far past A's last is 1: no work in proportion to it, before the admission or after it. Along dimension
# 1e15 any list or shape padded out to it can't even be made; the charges stay under 2 KB)
charges = []
real_admit = M._admit_bytes
M._admit_bytes = lambda b, what="": charges.append(b)
try:
    S = N._un_nd(np.array([[1.0, np.nan, 3.0]]))
    r1 = D.rmmissing_(2, S, 1e15)
    r2 = D.fillmissing_(2, S, C("linear"), 1e15)
finally:
    M._admit_bytes = real_admit
assert M._dims(r1[1]) == (1, 1) and M._dims(r2[0]) == (1, 3), (M._dims(r1[1]), M._dims(r2[0]))
assert charges and max(charges) < 2048, charges
ok("rmmissing and fillmissing: a dimension far past the array's last costs nothing (dim 1e15, charges under 2 KB)")

# (a malformed window is refused before it is read: a 2,000,000-element single window or a 1,000,000-element int8 one
# is never converted, so no copy of it is made before the refusal; a sentinel in place of the window's conversion is
# never reached)
Big = M._B["single"].call(1, [N._un_nd(np.ones((1, 2000000)))])
Big8 = M._B["int8"].call(1, [N._un_nd(np.ones((1, 1000000)))])
saved = D._vec


def no_copy(*a, **k):
    raise Reached()
D._vec = no_copy
try:
    for name, f in (("fillmissing movmean", lambda: D.fillmissing_(2, 1.0, C("movmean"), Big)),
                    ("fillmissing movmedian", lambda: D.fillmissing_(2, 1.0, C("movmedian"), Big)),
                    ("fillmissing int8 window", lambda: D.fillmissing_(2, 1.0, C("movmedian"), Big8)),
                    ("movmean", lambda: M._B["movmean"].call(1, [1.0, Big])),
                    ("movmedian int8 window", lambda: M._B["movmedian"].call(1, [1.0, Big8]))):
        try:
            f()
            assert False, name
        except Reached:
            assert False, name + ": the window was read before it was refused"
        except M.MatlabError as e:
            assert "Window length" in str(e), (name, str(e))
finally:
    D._vec = saved
ok("a malformed window (2,000,000 single, 1,000,000 int8) is refused before it is read (no copy made)")
