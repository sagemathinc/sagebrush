# read_csv's decoded-memory budget, shape 6 (plan-pandas r7 E 1c; daybreak3's
# ruling): a duplicate index's lookup map on its own, under the same 8 MiB
# limit as test_budget.py (test_budget_map.limits.json; a file of its own, as
# the limit is fixed once per process).  A read of that size can't fit with
# its map, so the index is made directly and given read_csv's budget; the
# first .loc runs the production lazy builder (_pd_index's _pd_positions).
# The map charges 100 B a label, 16 B a duplicate's list and 8 B each further
# position.  For each repetition, the most labels whose map is built is found
# (doubling, then bisection) and its charge checked; one more is refused by
# the map's preflight, leaving no map and no charge.  The oracle has no
# budget, so this test's .out is Sagebrush's.
import numpy as np
import pandas as pd
from pandas._pd_csv import _make_budget

import sagebrush
from _cases import case

case("limit", lambda: sagebrush.limit("pandas.decoded_bytes"))


def refused(e):
    return isinstance(e, ValueError) and "'pandas.decoded_bytes'" in str(e)


def series(k, rep):
    labels = [i // rep for i in range(rep * k)]
    s = pd.Series(np.zeros(rep * k), index=labels)
    b = _make_budget()
    s.index._pd_budget = b
    return s, b


def builds(k, rep):
    s, b = series(k, rep)
    try:
        s.loc[0]
        return True
    except Exception as e:
        if refused(e):
            return False
        raise


def at_cap(rep):
    hi = 1
    while builds(hi, rep):
        hi *= 2
    lo = hi // 2
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if builds(mid, rep):
            lo = mid
        else:
            hi = mid
    return lo


for rep, per_label in ((2, 100 + 16), (3, 100 + 16 + 8)):
    name = "repeated-%d" % rep
    k = at_cap(rep)
    s, b = series(k, rep)
    first = s.loc[0].tolist()
    case(name + ".cap", lambda: (k, b.used, b.used == per_label * k, first))
    used = b.used
    last = s.loc[k - 1].tolist()
    case(name + ".cap.later-lookup", lambda: (last, b.used == used))
    case(name + ".cap.map-labels", lambda: len(s.index._pd_map))
    s, b = series(k + 1, rep)
    try:
        s.loc[0]
        refusal = None
    except ValueError as e:
        refusal = str(e)
    case(name + ".cap+1", lambda: refusal)
    case(name + ".cap+1.no-map", lambda: s.index._pd_map is None)
    case(name + ".cap+1.no-charge", lambda: b.used)
