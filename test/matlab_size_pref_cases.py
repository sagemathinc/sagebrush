# MATLAB mode's 5 GB array-size preference (#1842) at its boundary. Sagebrush refuses nothing for the preference:
# when the memory guard or the allocation refuses an array of 5 * 2^30 bytes or more, the refusal is reported as
# MATLAB's SizeLimitExceeded; one byte less, it stays out of memory. _matlab._made is driven directly, with a
# stand-in refusal, so nothing is allocated. Run by test/matlab-size-preference.test.ts; each check prints one
# "ok ..." line.
import numpy as np

import _matlab as M

P = 5 * 2 ** 30
ID = "MATLAB:array:SizeLimitExceeded"


def ok(name):
    print("ok", name)


def outcome(made, refuse=True):
    """what making an array under made gives: the error raised (a refusal stood in by MemoryError), or None"""
    try:
        with made:
            if refuse:
                raise MemoryError()
    except M.MatlabError as e:
        return e
    except MemoryError as e:
        return e
    return None


# (a stand-in host with room for anything, so only the stand-in refusal decides: the admission, #1960, passes)
import sys
import types
import _matlab_sparse as sp
cap = types.ModuleType("_capacity")
cap.capacity = lambda: {"bytes": 1 << 50, "domains": ["js-heap", "js-arraybuffer"]}
cap.effective_guard_bytes = lambda r: 1 << 50
sp._capacity = cap
sys.modules["_capacity"] = cap
sys.modules.pop("_matlab_ledger", None)

assert M._SIZE_PREFERENCE_BYTES == P

# -- int8 (1 byte each): a refusal at 5 GB exactly is MATLAB's; one byte less stays out of memory
e = outcome(M._made((P, 1), 1))
assert isinstance(e, M.MatlabError) and e.identifier == ID and str(e.message) == (
    "Requested 5368709120x1 (5.0GB) array exceeds maximum array size preference (5.0GB) and might cause MATLAB to "
    "become unresponsive."), e
e = outcome(M._made((P - 1, 1), 1))
assert type(e) is MemoryError and M._identifier(e) == "MATLAB:nomem", e
ok("1 byte per element: refused at 5 * 2^30 bytes, SizeLimitExceeded (5.0GB); one byte less, nomem")

# -- nothing is refused for the preference itself: an array that is made is made
assert outcome(M._made((P, 1), 1), refuse=False) is None
assert outcome(M._made((2 ** 31, 1), 8), refuse=False) is None
ok("no refusal of its own: a request above 5 GB that the host can make is made")

# -- double (8 bytes each), 2-D, and the size named RxC
e = outcome(M._made((2 ** 20, 5 * 2 ** 7), 8))
assert isinstance(e, M.MatlabError) and "Requested 1048576x640 (5.0GB)" in str(e.message), e
assert type(outcome(M._made((2 ** 27 - 1, 5), 8))) is MemoryError
ok("8 bytes per element, 2-D: refused at 5 * 2^27 elements as RxC; 5 elements fewer, nomem")

# -- growth: a double array grown by a linear index, named N-by-1; a 2-D growth RxC
cur = np.zeros((3, 1))
e = outcome(M._refuse_huge_growth((1, 5 * 2 ** 27), cur, 1.0, True))
assert isinstance(e, M.MatlabError) and e.identifier == ID and "Requested 671088640x1 (5.0GB)" in str(e.message), e
assert type(outcome(M._refuse_huge_growth((1, 5 * 2 ** 27 - 1), cur, 1.0, True))) is MemoryError
e = outcome(M._refuse_huge_growth((2 ** 20, 5 * 2 ** 7), cur, 1.0, False))
assert isinstance(e, M.MatlabError) and "Requested 1048576x640 (5.0GB)" in str(e.message), e
ok("growth: refused at the boundary as N-by-1 for a linear index, RxC for 2-D; one element fewer, nomem")

# -- the 2^48-byte tier comes first, before anything is attempted
try:
    M._made((2 ** 45, 1), 8)
    raise AssertionError("not refused")
except M.MatlabError as e:
    assert e.identifier == "MATLAB:pmaxsize", e
ok("at 2^48 bytes the error is MATLAB:pmaxsize, raised before anything is made")
