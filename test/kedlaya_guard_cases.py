# The preflight of Kedlaya's Frobenius matrix (lib/_sage_padic_lseries.py,
# plan-kedlaya-optin r6 section 3): run by test/kedlaya.test.ts under python3
# and Sagebrush, which must print the same (test/kedlaya_guard_cases.out).
# sys.argv[1]: a section; "finite" takes the limit as sys.argv[2] (python3
# proposes it; Sagebrush is given it with --limits).
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from fractions import Fraction as F
import _capacity
import _limits
import _sage_padic_lseries as L

if len(sys.argv) > 2 and not _limits.finalized():
    _limits.propose(_limits.validate({"padic.kedlaya_work": int(sys.argv[2]) if sys.argv[2] != "unlimited" else "unlimited"}))

Q27 = [F(-27, 4), F(0), F(0), F(1)]          # 27a1, y^2 + y = x^3 - 7: Q = x^3 - 27/4
Q36 = [F(1), F(0), F(0), F(1)]               # 36a1, the sparse model y^2 = x^3 + 1
calls = []


def no_modulus(p, W):
    calls.append("modulus")
    raise AssertionError("the working modulus was made")


real_setup = L._kd_setup


def spy_setup(*a):
    calls.append("setup")
    return real_setup(*a)


L._kd_modulus = no_modulus
L._kd_setup = spy_setup
real_heap = _capacity.heap_figure


def heap(n):
    _capacity.heap_figure = (lambda: n) if n is not None else real_heap


def attempt(p, N, Qc=Q27):
    """The preflight's answer, and whether anything past it ran."""
    del calls[:]
    try:
        r = "admitted %s" % (L._kd_preflight(p, N, N - 1, Qc),)
    except MemoryError as e:
        # D1's memory error: its type, exact fields and wording (the routes'
        # lines, which depend on where it runs, only counted)
        lines = str(e).splitlines()
        r = "refused %s: %s [need %d, limit %d, for %r, fixed %s, capacity %s, routes %s]" % (
            type(e).__name__, lines[1], e.need_bytes, e.limit_bytes, e.allowance_for, e.fixed,
            isinstance(getattr(e, "capacity", None), dict), len(lines) > 3 and lines[0] == "Not enough memory for this computation.")
        assert e.what in lines[1] and (e.record, e.partial, e.checkpoint) == (None, None, None)
    except NotImplementedError as e:
        r = "refused %s: %s [memory fields %s]" % (type(e).__name__, e, [a for a in ("need_bytes", "limit_bytes") if hasattr(e, a)])
    return r + ("" if not calls else " RAN %s" % calls)


def finite():
    """p = 197, N = 9 (prec 8): lower 4,695,889, full 5,136,128."""
    heap(1 << 40)
    print("finite %s: lower %d, full %d: %s" % (sys.argv[2], 197 ** 2 * 11 ** 2, L._kd_cost(197, 9), attempt(197, 9)))


def minimum():
    """Step 1: the working modulus alone.  N = 10^100 refused at once (under
    10 ms, before the modulus and setup); the bound below the bytes of P
    measured (CPython: sys.getsizeof); and a mutant with r2's J-based figure
    refusing a sparse case that the real bound admits past step 1."""
    heap(None)
    attempt(5, 10 ** 100 + 1)
    t = time.time()
    r = attempt(5, 10 ** 100 + 1)
    dt = time.time() - t
    print("min: N = 10^100: %s; step 1: %s; under 10 ms: %s" % (r[:52], "just its working modulus" in r and "RAN" not in r, dt < 0.01))
    if sys.implementation.name == "cpython":
        ok = all(L._kd_min_bytes(p, N) <= sys.getsizeof(p ** L._kd_plan_fast(p, N)[1])
                 for p in (5, 97, 1009) for N in range(1, 31))
        print("min: at most the bytes of P, p in (5, 97, 1009), N <= 30: %s" % ok)
    # the mutant: J = K p + 1 residues of b bits
    p, N = 97, 6
    K, W = L._kd_plan_fast(p, N)
    j_fig = (K * p + 1) * -(-W * p.bit_length() // 8)
    real = L._kd_min_bytes(p, N)
    heap((real + j_fig) // 2)
    good = attempt(p, N, Q36)
    L._kd_min_bytes = lambda p, N: (L._kd_plan_fast(p, N)[0] * p + 1) * -(-L._kd_plan_fast(p, N)[1] * p.bit_length() // 8)
    try:
        bad = attempt(p, N, Q36)
    finally:
        L._kd_min_bytes = real_min
    print("min: real bound %d < heap %d < J figure %d" % (real, (real + j_fig) // 2, j_fig))
    print("min: real: %s" % ("not impossible" if "just its working modulus" not in good else good))
    print("min: mutant: %s" % ("impossible" if "just its working modulus" in bad else bad))


real_min = L._kd_min_bytes


def budget():
    """Step 4: a total of 4U admits and 4U - 4 refuses, before the modulus,
    under every shipped table; its text is not step 1's."""
    real_engine = L._kd_engine
    for eng in ("cpython", "v8", "jsc"):
        L._kd_engine = lambda eng=eng: eng
        for p, N in ((97, 11), (5, 51), (401, 3)):
            K, W = L._kd_plan_fast(p, N)
            U = L._kd_ledger(p, N, K, W, p, 7, L._KD_TABLES[eng])
            heap(4 * U)
            a = attempt(p, N)
            heap(4 * U - 4)
            b = attempt(p, N)
            print("budget %s p = %d N = %d: U = %d; 4U: %s; 4U - 4: %s" % (eng, p, N, U, a, b))
    L._kd_engine = real_engine


def engines():
    """The engines without a table, refused before the modulus with the
    engine's text; and the labels of the runtime's (engine, host)."""
    heap(1 << 40)
    real_engine = L._kd_engine
    for eng in ("jsc (WebKit)", "spidermonkey", "unknown"):
        L._kd_engine = lambda eng=eng: eng
        print("engine %s: %s" % (eng, attempt(97, 3)))
    L._kd_engine = real_engine
    for e, h in (("v8", "node"), ("v8", "deno"), ("v8", "browser"), ("jsc", "bun"), ("jsc", "browser"),
                 ("spidermonkey", "browser"), ("unknown", "browser")):
        print("label %s on %s: %s" % (e, h, L._kd_label(e, h)))


def tiny():
    """D1's wording at the smallest totals: none (the modulus's lower bound
    against an allowance of 0), a nonzero total below the modulus, and
    quarter-budgets of 0, 1 and 2 bytes past step 1 (p = 5, N = 2: the
    modulus needs 2 bytes)."""
    real_engine = L._kd_engine
    L._kd_engine = lambda: "cpython"
    for n in (0, 1, 3, 4, 8):
        heap(n)
        print("tiny %d: %s" % (n, attempt(5, 2)))
    L._kd_engine = real_engine


{"finite": finite, "min": minimum, "budget": budget, "engines": engines, "tiny": tiny}[sys.argv[1]]()
