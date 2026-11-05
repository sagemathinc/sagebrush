# read_csv's decoded-memory budget (plan-pandas r7 E 1a, 1c): the six
# adversarial shapes, each at its own cap, under one finite limit.  For each
# shape the largest size that reads is found (doubling, then bisection) and
# printed, with the frame it gives; one more is refused before the governed
# growth, and the refusal names that growth, so no shape's charge is masked by
# another's.  The oracle has no budget, so this test's .out is Sagebrush's.
import io

import sagebrush

import pandas as pd
from _cases import case

# (test_budget.limits.json: 8 MiB, above the parser's fixed buffers; grading's
# value is chosen by measurement)
case("limit", lambda: sagebrush.limit("pandas.decoded_bytes"))


def refused(e):
    return isinstance(e, ValueError) and "'pandas.decoded_bytes'" in str(e)


def attempt(run, k):
    try:
        return True, run(k)
    except Exception as e:
        if refused(e):
            return False, e
        raise


def at_cap(run):
    hi = 1
    while attempt(run, hi)[0]:
        hi *= 2
    lo = hi // 2        # (reads; hi doesn't)
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if attempt(run, mid)[0]:
            lo = mid
        else:
            hi = mid
    return lo


def shape(name, run, show):
    k = at_cap(run)
    if k == 0:
        case(name + ".cap", lambda: "refused at size 1: " + str(attempt(run, 1)[1]))
        return
    ok, value = attempt(run, k)
    case(name + ".cap", lambda: (k, show(value)))
    ok, e = attempt(run, k + 1)
    case(name + ".cap+1", lambda: None if ok else str(e))


def read(text, **kw):
    return pd.read_csv(io.StringIO(text), **kw)


def frame(df):
    return (df.shape, sorted(set(str(t) for t in df.dtypes)))


# 1. a very wide empty row (k commas: k + 1 empty fields): column metadata and builders
shape("wide-empty-row", lambda k: read("," * k + "\n", header=None), frame)
# 2. very tall one-character numeric data: the numeric builder and its output
shape("tall-numeric", lambda k: read("0\n" * k, header=None), frame)
# 3. the most small strings: string objects and list slots
shape("small-strings", lambda k: read("a\n" * k, header=None), frame)
# 4. late numeric->str widening: the first non-numeric value in the last row
shape("late-widening", lambda k: read("1\n" * k + "x\n", header=None), frame)
# 5. many column labels: a wide header of long unique labels
shape("many-labels", lambda k: read(",".join("label_%060d" % i for i in range(k)) + "\n"), frame)


# (not shape 6, which is test_budget_map.py: a composition, a read and then
#  its index's lookup map, every label twice; the read's own growth binds
#  first, so this checks only that the map built after a read stays within
#  the budget the read left)
def read_then_map(k):
    df = read("".join("%d,1\n" % (i >> 1) for i in range(2 * k)), header=None, index_col=0)
    return df.loc[0].shape


shape("read-then-map", read_then_map, lambda s: s)
