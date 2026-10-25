# The ledger of Kedlaya's Frobenius matrix against V8's own heap (lib/
# _sage_padic_lseries.py, plan-kedlaya-optin r6 section 6), run by
# test/kedlaya.test.ts under Sagebrush in Node:
#   layouts         per object, the live heap's growth (after a full
#                   collection) over many copies, at most the V8 table's
#                   formula, at each layout step
#   peak P PREC C   the live heap before the call (after a full collection),
#                   then the call: test/kedlaya.test.ts bisects the smallest
#                   --max-old-space-size it completes in
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from fractions import Fraction as F
import _sage_padic_lseries as L

T = L._KdV8
CURVES = {"dense": [F(-23, 4), F(3), F(3), F(1)], "sparse": [F(1), F(0), F(0), F(1)]}
def used():
    # (two full collections: the first one's garbage can still be counted
    # right after it)
    sys._sagebrush_heap_used()
    return sys._sagebrush_heap_used()


def per_object(make, bound):
    """(growth, noise): the live heap's growth per object made, the median
    of three trials, each over enough copies for about 8 MiB by the
    formula's bound (at most 2^21), held in a list made beforehand (so the
    holder's own growth isn't counted), less the same loop's growth making
    nothing; and that control's largest size per copy, the measurement's
    own noise."""
    copies = max(32, min(1 << 21, (8 << 20) // bound))
    make(0)

    def trial(make):
        keep = [None] * copies
        u0 = used()
        for i in range(copies):
            keep[i] = make(i)
        u1 = used()
        # (keep read after the measurement: V8 drops a local it sees no
        # later use of, and the copies with it, before u1)
        assert len(keep) == copies
        return u1 - u0
    got, noise = [], 0
    for _ in range(3):
        c = trial(lambda i: None)
        got.append(trial(make) - c)
        noise = max(noise, abs(c))
    return sorted(got)[1] / copies, noise / copies


def layouts(top):
    bad = []
    worst = {}
    for k in range(3, top + 1):
        for n in (2 ** k, 2 ** k + 1):

            def grown(i, n=n):
                a = []
                for j in range(n):
                    a.append(j)
                return a

            def inserted(i, n=n):
                d = {}
                for j in range(n):
                    d[j] = j
                return d
            # (the outer list's own slots: 8 bytes a copy)
            m, e = per_object(grown, T.Ls(n))
            if m > T.Ls(n) + e:
                bad.append("list %d: %.1f > %d + noise %.1f" % (n, m, T.Ls(n), e))
            worst["list"] = max(worst.get("list", 0), m / T.Ls(n))
            m, e = per_object(inserted, T.D(n))
            if m > T.D(n) + e:
                bad.append("dict %d: %.1f > %d + noise %.1f" % (n, m, T.D(n), e))
            worst["dict"] = max(worst.get("dict", 0), m / T.D(n))
    for k in range(1, 33):
        for b in (64 * k, 64 * k + 1):
            m, e = per_object(lambda i, b=b: (1 << b) - 1 - i, T.I(b))
            if m > T.I(b) + e:
                bad.append("int %d bits: %.1f > %d + noise %.1f" % (b, m, T.I(b), e))
            worst["int"] = max(worst.get("int", 0), m / T.I(b))
    print("v8 layouts: %s; the largest measured/formula: %s" % (bad or "all within",
          ", ".join("%s %.2f" % kv for kv in sorted(worst.items()))))


def peak(p, prec, curve):
    Qc = CURVES[curve]
    N = prec + 1
    K, W = L._kd_plan_fast(p, N)
    a = max(max(abs(c.numerator).bit_length(), c.denominator.bit_length()) for c in Qc)
    U = L._kd_ledger(p, N, K, W, p, a, T)
    # (a first call compiles the code: V8 keeps its bytecode and feedback in
    # the old space, which is not the call's; the second call is measured)
    L._kd_frobenius_matrix(Qc, p, N, K, W)
    base = used()
    print("baseline %d U %d" % (base, U), flush=True)
    L._kd_frobenius_matrix(Qc, p, N, K, W)
    print("done", flush=True)


if sys.argv[1] == "layouts":
    # (CI: layout steps up to 2^12 entries; "full": up to 2^14, the plan's)
    layouts(14 if sys.argv[2:] == ["full"] else 12)
else:
    peak(int(sys.argv[2]), int(sys.argv[3]), sys.argv[4])
