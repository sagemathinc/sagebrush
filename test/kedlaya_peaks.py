# The ledger of Kedlaya's Frobenius matrix against CPython's own accounting
# (lib/_sage_padic_lseries.py, plan-kedlaya-optin r6 section 6), run by
# test/kedlaya.test.ts under python3:
#   peaks     U >= tracemalloc's high-water of one _kd_frobenius_matrix call
#   terms     at each within-phase peak, every named structure's bytes are at
#             most its ledger term, and dropping any one term (a mutant)
#             fails its own check; the phase lifetimes, by gc identity
#   layouts   the object sizes against sys.getsizeof at each layout step
# sys.argv[2] == "full": the whole case list (a long run, for the record).
import gc
import os
import sys
import tracemalloc

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from fractions import Fraction as F
import _sage_padic_lseries as L

T = L._KdCPython
DENSE = [F(-23, 4), F(3), F(3), F(1)]     # 27a1's dense model y^2 + y = x^3 + 3 x^2 + 3 x - 6
SPARSE = [F(1), F(0), F(0), F(1)]         # 36a1, y^2 = x^3 + 1
CURVES = [("dense", DENSE), ("sparse", SPARSE)]


def bits(Qc):
    return max(max(abs(c.numerator).bit_length(), c.denominator.bit_length()) for c in Qc)


def deep(x, seen=None):
    """The bytes of x and what it holds (lists, dicts, tuples, ints,
    Fractions), each object once, rounded up to pymalloc's 16 bytes."""
    if seen is None:
        seen = set()
    if id(x) in seen:
        return 0
    seen.add(id(x))
    n = -(-sys.getsizeof(x) // 16) * 16
    if isinstance(x, (list, tuple)):
        n += sum(deep(y, seen) for y in x)
    elif isinstance(x, dict):
        n += sum(deep(k, seen) + deep(v, seen) for k, v in x.items())
    elif isinstance(x, F):
        n += deep(x.numerator, seen) + deep(x.denominator, seen)
    return n


def peaks(cases):
    """U >= the high-water of the Python allocations of the call (its
    inputs made before, so not counted: the ledger charges them anyway)."""
    for name, Qc in CURVES:
        for p, prec in cases:
            N = prec + 1
            K, W = L._kd_plan_fast(p, N)
            U = L._kd_ledger(p, N, K, W, p, bits(Qc), T)
            gc.collect()
            tracemalloc.start()
            base = tracemalloc.get_traced_memory()[0]
            tracemalloc.reset_peak()
            L._kd_frobenius_matrix(Qc, p, N, K, W)
            peak = tracemalloc.get_traced_memory()[1] - base
            tracemalloc.stop()
            print("peak %s p = %d prec %d: U >= peak: %s (U/peak %.2f)" % (name, p, prec, U >= peak, U / peak))


def terms():
    """The per-term checks at the hooks (one curve each, dense and sparse,
    p = 97, prec 3), their mutants, and the lifetimes."""
    for name, Qc in CURVES:
        p, prec = 97, 3
        N = prec + 1
        K, W = L._kd_plan_fast(p, N)
        a = bits(Qc)
        checks = []        # (point, term, measured, phase)
        live = {}

        def hook(point, v):
            if point == "digits":
                checks.append(("digits", "P Q Qd S", deep([v["P"], v["Q"], v["Qd"], v["S"]]), "S"))
                checks.append(("digits", "digits", deep(v["digits"]), "S"))
                checks.append(("digits", "digit loop", deep(v["rest"]), "S"))
                live["digits"] = (id(v["digits"]), len(v["digits"]))
            elif point == "series":
                checks.append(("series", "B cur nxt", deep([v["B"], v["cur"], v["nxt"]]), "T"))
                checks.append(("series", "digits", deep(v["digits"]), "T"))
                checks.append(("series", "c", deep(v["c"]), "T"))
                live["cur"] = (id(v["cur"]), tuple(sorted(v["cur"])))
                live["nxt"] = (id(v["nxt"]), tuple(sorted(v["nxt"])))
            elif point == "reduce":
                gc.collect()
                objs = gc.get_objects()
                # (an object found by identity and fingerprint: its id, and
                # its keys or length)
                def alive(key):
                    if key not in live:
                        return False
                    i, fp = live[key]
                    for o in objs:
                        if id(o) == i:
                            if isinstance(o, dict) and tuple(sorted(o)) == fp:
                                return True
                            if isinstance(o, list) and len(o) == fp:
                                return True
                    return False
                checks.append(("reduce %d" % v["i"], "cur and nxt gone", not (alive("cur") or alive("nxt")), None))
                checks.append(("reduce %d" % v["i"], "digits gone", not alive("digits"), None))
                if v["i"] == 1:
                    checks.append(("reduce 1", "column 0's forms gone", not alive("forms0"), None))
                checks.append(("reduce %d" % v["i"], "B", deep(v["B"]), "R"))
            elif point == "forms":
                checks.append(("forms %d" % v["i"], "forms", deep(v["forms"]), "R"))
                if v["i"] == 0:
                    live["forms0"] = (id(v["forms"]), tuple(sorted(v["forms"])))
            elif point == "exact":
                checks.append(("exact %d" % v["i"], "exact-form loop", deep([v["G"], v["rel"]]), "R"))

        L._kd_hook = hook
        try:
            L._kd_frobenius(Qc, p, N, K, W)
        finally:
            L._kd_hook = None
        ph = L._kd_phases(p, K, W, p, a, T)
        bad, seen_terms = [], set()
        for point, term, measured, phase in checks:
            if phase is None:
                if not measured:
                    bad.append("%s: %s" % (point, term))
                continue
            bound = dict(ph[phase])[term]
            seen_terms.add((phase, term))
            if measured > bound:
                bad.append("%s: %s %d > %d" % (point, term, measured, bound))
        print("terms %s: %d checks at %d hook calls, failing: %s" % (name, len(checks), len(set(c[0] for c in checks)), bad or "none"))
        # the mutants: each checked term dropped (0) fails its own check
        caught = []
        for phase, term in sorted(seen_terms):
            caught.append(any(ph_ == phase and t == term and m > 0 for _, t, m, ph_ in checks))
        print("terms %s: %d mutants (one term dropped each), each failing its own check: %s" % (name, len(caught), all(caught)))
    # the check call's (K + 2, W + 3): its structures at its own hooks are
    # within the ledger's terms for (K + 2, W + 3), and a mutant charging it
    # as the main call (K, W) fails there
    p, prec = 97, 3
    N = prec + 1
    K, W = L._kd_plan_fast(p, N)
    got = []

    counts = []      # (what, entries or bits seen, which bound of _kd_sizes)

    def maxbits(d):
        return max((x.bit_length() for A in d.values() for x in A), default=0)

    def hook2(point, v):
        if point == "series":
            got.append(("B cur nxt", deep([v["B"], v["cur"], v["nxt"]]), "T"))
            counts.append(("entries of cur", len(v["cur"]), 3))
            counts.append(("bits of cur", maxbits(v["cur"]), 0))
        elif point == "forms":
            got.append(("forms", deep(v["forms"]), "R"))
            counts.append(("entries of forms", len(v["forms"]), 4))
        elif point == "reduce":
            got.append(("B", deep(v["B"]), "R"))

    L._kd_hook = hook2
    try:
        L._kd_frobenius(DENSE, p, N, K + 2, W + 3, K + 1)
    finally:
        L._kd_hook = None
    real = L._kd_phases(p, K + 2, W + 3, p, bits(DENSE), T)
    mut = L._kd_phases(p, K, W, p, bits(DENSE), T)
    ok_real = all(m <= dict(real[ph])[t] for t, m, ph in got)
    sz_real, sz_mut = L._kd_sizes(p, K + 2, W + 3), L._kd_sizes(p, K, W)
    ok_real = ok_real and all(n <= sz_real[k] for _, n, k in counts)
    caught = sorted(set(w for w, n, k in counts if n > sz_mut[k]))
    print("terms: the check call within its own terms and sizes: %s; the mutant charging it as (K, W) fails at: %s" % (ok_real, ", ".join(caught) or "nothing"))


def layouts():
    """sys.getsizeof (rounded to 16) at most the formula, for lists grown by
    appends and dicts by insertions of 2^k and 2^k + 1 entries (k = 3 ... 14),
    and ints of 64k and 64k + 1 bits."""
    bad = []
    r16 = lambda n: -(-n // 16) * 16
    for k in range(3, 15):
        for n in (2 ** k, 2 ** k + 1):
            a = []
            for i in range(n):
                a.append(i)
            d = {}
            for i in range(n):
                d[i] = i
            if r16(sys.getsizeof(a)) > T.Ls(n):
                bad.append("list %d" % n)
            if r16(sys.getsizeof([0] * n)) > T.Ls(n):
                bad.append("list [0] * %d" % n)
            if r16(sys.getsizeof(d)) > T.D(n):
                bad.append("dict %d" % n)
    for k in range(1, 65):
        for b in (64 * k, 64 * k + 1):
            if r16(sys.getsizeof((1 << b) - 1)) > T.I(b):
                bad.append("int %d bits" % b)
    print("layouts: %s" % (bad or "all within"))


FAST = [(101, 2), (5, 50), (97, 3)]
FULL = [(101, 2), (199, 2), (401, 2), (797, 2), (5, 50), (5, 100), (5, 200), (5, 400), (97, 10)]
what = sys.argv[1]
if what == "peaks":
    peaks(FULL if sys.argv[2:] == ["full"] else FAST)
elif what == "terms":
    terms()
elif what == "layouts":
    layouts()
