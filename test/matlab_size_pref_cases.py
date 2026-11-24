# MATLAB mode's 5 GB array-size preference (#1842) at its boundary: _matlab._refuse_made and _refuse_huge_growth
# called directly, so nothing is allocated. A request of exactly 5 * 2^30 bytes is refused, one byte less is not;
# the bytes are counted at the class's size; a linear index's growth is named N-by-1. Run by
# test/matlab-size-preference.test.ts; each check prints one "ok ..." line.
import numpy as np

import _matlab as M

P = 5 * 2 ** 30
ID = "MATLAB:array:SizeLimitExceeded"


def ok(name):
    print("ok", name)


def refusal(f):
    try:
        f()
    except M.MatlabError as e:
        return e
    return None


assert M._SIZE_PREFERENCE_BYTES == P

# -- int8 (1 byte each): 5 GB exactly is refused, one byte less is not
e = refusal(lambda: M._refuse_made((P, 1), 1))
assert e is not None and e.identifier == ID and str(e.message) == (
    "Requested 5368709120x1 (5.0GB) array exceeds maximum array size preference (5.0GB) and might cause MATLAB to "
    "become unresponsive."), e
assert refusal(lambda: M._refuse_made((P - 1, 1), 1)) is None
ok("1 byte per element: 5 * 2^30 bytes refused (5.0GB), one byte less admitted")

# -- double (8 bytes each), 2-D: the boundary in elements is 5 * 2^27
assert refusal(lambda: M._refuse_made((2 ** 27, 5), 8)).identifier == ID
assert refusal(lambda: M._refuse_made((2 ** 27 - 1, 5), 8)) is None
e = refusal(lambda: M._refuse_made((2 ** 20, 5 * 2 ** 7), 8))
assert e is not None and "Requested 1048576x640 (5.0GB)" in str(e.message), e
ok("8 bytes per element, 2-D: 5 * 2^27 elements refused, 5 elements fewer admitted, named RxC")

# -- growth: a double array grown by a linear index to 5 * 2^27 elements is refused, named N-by-1
cur = np.zeros((3, 1))
e = refusal(lambda: M._refuse_huge_growth((1, 5 * 2 ** 27), cur, 1.0, True))
assert e is not None and e.identifier == ID and "Requested 671088640x1 (5.0GB)" in str(e.message), e
assert refusal(lambda: M._refuse_huge_growth((1, 5 * 2 ** 27 - 1), cur, 1.0, True)) is None
e = refusal(lambda: M._refuse_huge_growth((2 ** 20, 5 * 2 ** 7), cur, 1.0, False))
assert e is not None and "Requested 1048576x640 (5.0GB)" in str(e.message), e
ok("growth: a linear index's growth to the boundary refused as N-by-1, one element fewer admitted; a 2-D growth as RxC")

# -- the 2^48-byte tier comes first
e = refusal(lambda: M._refuse_made((2 ** 45, 1), 8))
assert e is not None and e.identifier == "MATLAB:pmaxsize", e
ok("at 2^48 bytes the error is MATLAB:pmaxsize, not the preference's")
