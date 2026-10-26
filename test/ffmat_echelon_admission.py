"""GF(p) echelon admission by shape (plan F4 r4, d5c6c1cd), the cases shared
by both runtimes: test/ffmat-echelon-admission.test.ts runs them in pyjs
(node --max-old-space-size=1024 build/cli/pyjs.cjs --sage THIS CASE) and
engine/py/test_ffmat_echelon.py in CPython (python3 THIS CASE).  Each case
prints "ok CASE ..." lines and raises on a failure.

    route        the engine path through the 1024 envelope, Python past it
                 (rank, det, echelon form, one and k right-hand sides,
                 inverse), counted at the transport
    preflight    the transport predicate at need - 1, need and need + 1 for
                 each op's widest sent shape (the figure hook)
    integration  the real heap figure lowered under a built 1024 x 1024
                 matrix: rank() declines through _heap_budget itself
    correct      the engine path against the Python path, exactly
    bridge       call_text, and no _LIMITED entry for nmod_echelon
    mem-T mem-Tp mem-W negctl
                 the measured memory (Linux): the transport at the seam,
                 rank()/det() whole, the whole row-returning call with its
                 result, and today's bridge exceeding the transport bound
    interrupt [DIR]
                 prints "ready" (and creates DIR/ready) just before a long
                 engine elimination for the harness to interrupt, then its
                 outcome (and writes it to DIR/result)
"""
import os
import sys

try:
    GF
except NameError:
    try:  # (pyjs, run as plain Python: test/ffmat-echelon-admission.test.ts's worker)
        from sage_all import *
    except ImportError:  # (CPython: the package)
        sys._sagebrush_heap_limit = 1 << 30  # (a figure that admits the envelope's operands)
        import sagebrush
        from sagebrush.sage import *

import _sage_ffmat as FM
import sagebrush._engine as EN

PYJS = hasattr(sys, "_sagebrush_heap_used")
CASE = sys.argv[1]
P63 = 9223372036854775783  # the largest prime below 2^63: 19-digit entries
KIB, MIB = 1024, 1 << 20

# ------------------------------------------------------------------ counters

SENT = []  # the (rows, cols) of each matrix sent to the engine
TEXTS = [0]  # call_text's calls
_transport = FM._engine_echelon_transport
_call_text = EN.call_text


def _counting_transport(rows, ncols, p, want_rows):
    SENT.append((len(rows), ncols))
    return _transport(rows, ncols, p, want_rows)


def _counting_call_text(request):
    TEXTS[0] += 1
    return _call_text(request)


FM._engine_echelon_transport = _counting_transport
EN.call_text = _counting_call_text


def sent(f):
    """(f's value, the shapes it sent to the engine)."""
    del SENT[:]
    t = TEXTS[0]
    v = f()
    assert TEXTS[0] - t == len(SENT), (TEXTS[0] - t, SENT)
    return v, list(SENT)


def need(r, c):
    return FM._ECH_TRANSPORT_PER_ENTRY * r * c + FM._ECH_TRANSPORT_FIXED


def with_figure(fig, f):
    FM._echelon_transport_figure = (lambda: fig) if fig is not None else None
    try:
        return f()
    finally:
        FM._echelon_transport_figure = None


def python_path(f):
    """f with every matrix kept on the Python path (the figure 0)."""
    return with_figure(0, f)


def admits_operand(F, r, c, factor=1):
    """The figure in force admits an r x c operand over F (times factor),
    so no other matrix guard sends a fixture down the Python path."""
    FM._admit_size(F, r, c, factor)


def ok(*a):
    print("ok", CASE, *a, flush=True)


# ------------------------------------------------------------------ fixtures

def rand_matrix(F, r, c, seed=1, big=False):
    import random
    g = random.Random(seed)
    p = int(F.order())
    if big:
        return matrix(F, r, c, [p - 1 - g.randrange(1000) for _ in range(r * c)])
    return matrix(F, r, c, [g.randrange(p) for _ in range(r * c)])


def rank_r(F, m, n, r, seed=2):
    """U V with U m x r (I_r on top) and V r x n (I_r on the left): rank r
    exactly (astra2's note)."""
    import random
    g = random.Random(seed)
    p = int(F.order())
    U = matrix(F, m, r, [(1 if i == j else 0) if i < r else g.randrange(p) for i in range(m) for j in range(r)])
    V = matrix(F, r, n, [(1 if i == j else 0) if j < r else g.randrange(p) for i in range(r) for j in range(n)])
    return U * V


# ------------------------------------------------------------------ cases

def case_route_ech():
    F = GF(7)
    for n in (401, 1024):
        A = identity_matrix(F, n)
        admits_operand(F, n, n)
        assert sent(A.rank) == (n, [(n, n)])
        assert sent(A.det) == (1, [(n, n)])
        assert sent(A.echelon_form)[1] == [(n, n)]
    A = identity_matrix(F, 1025)
    assert sent(A.rank) == (1025, [])
    ok("rank/det/echelon: engine at 401 and 1024, Python at 1025")


def case_route_solve():
    F = GF(7)
    # one right-hand side: [A | b] has m + 1 columns
    for m, want in ((1023, [(1023, 1024)]), (1024, [])):
        A = identity_matrix(F, m)
        b = vector(F, [i % 7 for i in range(m)])
        x, s = sent(lambda: A.solve_right(b))
        assert x == b and s == want, (m, s)
    ok("solve_right, one RHS: engine at 1023, Python at 1024")


def case_route_solvek():
    F = GF(7)
    # k right-hand sides: [A | B] of m + k columns; past 1024 each column
    # goes alone (m + 1 columns), as for any [A | B] the engine doesn't take
    # (m = 1022: k = 2 is m + k = 1024, one call; k = 3 is 1025, three
    # columns alone: the same boundary as any m, at the fewest columns)
    m = 1022
    A = identity_matrix(F, m)
    for k, want in ((2, [(m, m + 2)]), (3, [(m, m + 1)] * 3)):
        B = matrix(F, m, k, [(i + j) % 7 for i in range(m) for j in range(k)])
        X, s = sent(lambda: A.solve_right(B))
        assert X == B and s == want, (k, s[:3], len(s))
    ok("solve_right, k RHS: [A | B] at m + k = 1024, column by column at 1025")


def case_route_inv():
    F = GF(7)
    for n, want in ((512, [(512, 1024)]), (513, [])):
        A = identity_matrix(F, n)
        admits_operand(F, n, n, 3)
        X, s = sent(A.inverse)
        assert X == A and s == want, (n, s)
    ok("inverse: engine at 512, Python at 513")


def case_route():
    # (all four; pyjs runs them as separate cases: each crosses into the
    # Python elimination, too slow there to share one process's time limit)
    case_route_ech()
    case_route_solve()
    case_route_solvek()
    case_route_inv()


def preflight_shapes(F):
    """(label, (rows, cols) sent, the call), at each op's widest shape."""
    I1024, I1023, I1000, I512 = (identity_matrix(F, n) for n in (1024, 1023, 1000, 512))
    b = vector(F, [i % 7 for i in range(1023)])
    B = matrix(F, 1000, 24, [(i + j) % 7 for i in range(1000) for j in range(24)])
    return [
        ("rank", (1024, 1024), I1024.rank, []),
        ("solve 1 RHS", (1023, 1024), lambda: I1023.solve_right(b), []),
        # (declined, [A | B] is solved column by column: each 1000 x 1001
        # column fits the same figure)
        ("solve k RHS", (1000, 1024), lambda: I1000.solve_right(B), [(1000, 1001)] * 24),
        ("inverse", (512, 1024), I512.inverse, []),
    ]


def case_preflight():
    F = GF(7)
    for label, (r, c), call, declined in preflight_shapes(F):
        n = need(r, c)
        want = None
        for fig, admitted in ((4 * n - 4, False), (4 * n, True), (4 * n + 4, True)):
            assert ((fig // FM._HEAP_SHARE) >= n) == admitted
            assert with_figure(fig, lambda: FM._engine_echelon_transport_fits(r, c)) == admitted
            v, s = with_figure(fig, lambda: sent(call))
            assert s == ([(r, c)] if admitted else declined), (label, fig, s[:2])
            want = v if want is None else want
            assert v == want, label
        ok(label, "need", n, "declined at need - 1, admitted at need and need + 1")


def case_integration():
    F = GF(7)
    A = identity_matrix(F, 1024)
    admits_operand(F, 1024, 1024)
    n = need(1024, 1024)
    old = getattr(sys, "_sagebrush_heap_limit", None)
    try:
        sys._sagebrush_heap_limit = 4 * n - 4
        assert FM._heap_budget() == 4 * n - 4
        assert sent(A.rank) == (1024, [])
        sys._sagebrush_heap_limit = 4 * n
        assert sent(A.rank) == (1024, [(1024, 1024)])
    finally:
        sys._sagebrush_heap_limit = old
    ok("rank() declines through _heap_budget() at 4 need - 4, routes at 4 need")


def same(f, g):
    """f() on the engine path and g() (the same) on the Python path: equal
    values, or equal exceptions."""
    def run(h):
        try:
            return ("value", h())
        except (ValueError, ZeroDivisionError, ArithmeticError) as e:
            return ("raise", type(e).__name__, str(e))
    a, sa = sent(lambda: run(f))
    b, sb = sent(lambda: python_path(lambda: run(g)))
    assert sb == [], sb
    assert a == b, (a, b)
    return a, sa


def case_correct():
    for p in (2, 7, P63):
        F = GF(p)
        mats = [
            rand_matrix(F, 12, 30, 3), rand_matrix(F, 30, 12, 4),  # wide, tall: full rank
            rank_r(F, 30, 20, 7), rank_r(F, 20, 30, 5),  # rank-deficient
            rand_matrix(F, 25, 25, 5, big=True),
        ]
        for A in mats:
            for op in ("rank", "echelon_form", "pivots"):
                v, s = same(getattr(A, op), getattr(A, op))
                assert s, (p, op)  # (the engine path was taken)
        for A in mats[2:4]:
            assert A.rank() == (7 if A.nrows() == 30 else 5)
        # det: the sign of odd and even row permutations, a singular matrix
        n = 9
        D = diagonal_matrix(F, [F(i + 2) for i in range(n)])
        for perm, sign in (([1, 0] + list(range(2, n)), -1), ([1, 2, 0] + list(range(3, n)), 1)):
            Q = matrix(F, [D.row(i) for i in perm])
            v, s = same(Q.det, Q.det)
            assert s and v[1] == sign * D.det(), (p, perm, v)
        S = rank_r(F, 9, 9, 6)
        assert same(S.det, S.det)[0] == ("value", 0)
        # solve_right: overdetermined consistent, underdetermined (the chosen
        # solution equal), inconsistent; vector and matrix right-hand sides
        A = rank_r(F, 20, 8, 8)
        x = vector(F, [i + 1 for i in range(8)])
        v, _ = same(lambda: A.solve_right(A * x), lambda: A.solve_right(A * x))
        assert v == ("value", x)
        W = rank_r(F, 8, 20, 8)
        v, _ = same(lambda: W.solve_right(W * vector(F, list(range(20)))), lambda: W.solve_right(W * vector(F, list(range(20)))))
        assert W * v[1] == W * vector(F, list(range(20)))
        Bm = W * matrix(F, 20, 3, list(range(60)))
        v, _ = same(lambda: W.solve_right(Bm), lambda: W.solve_right(Bm))
        assert W * v[1] == Bm
        # (the last row of T is zero and c's last entry isn't: no solution)
        T = matrix(F, [list(r) for r in rank_r(F, 9, 10, 6).rows()] + [[0] * 10])
        c = vector(F, [1] * 10)
        v, _ = same(lambda: T.solve_right(c), lambda: T.solve_right(c))
        assert v[0] == "raise", v  # (inconsistent: refused on both paths alike)
        # inverse, and a singular one refused alike
        # (unit lower times unit upper triangular: invertible by construction,
        # with nonzero entries everywhere, so the elimination pivots and swaps)
        Lo, Up = rand_matrix(F, 12, 12, 9, big=True), rand_matrix(F, 12, 12, 10, big=True)
        Lo = matrix(F, 12, 12, [Lo[i, j] if j < i else (1 if i == j else 0) for i in range(12) for j in range(12)])
        Up = matrix(F, 12, 12, [Up[i, j] if j > i else (1 if i == j else 0) for i in range(12) for j in range(12)])
        G = matrix(F, [list(r) for r in (Lo * Up).rows()][::-1])
        v, _ = same(G.inverse, G.inverse)
        assert v[1] * G == identity_matrix(F, 12)
        v, _ = same(rank_r(F, 6, 6, 4).inverse, rank_r(F, 6, 6, 4).inverse)
        assert v[0] == "raise", v
        # empty shapes keep their behaviour and never reach the engine
        for E in (matrix(F, 0, 3), matrix(F, 3, 0), matrix(F, 0, 0)):
            assert sent(E.rank) == (0, [])
        ok("p =", p)


def case_bridge():
    assert "nmod_echelon" not in EN._LIMITED
    req = '{"fn":"nmod_echelon","p":"7","rows":2,"cols":2,"reduced":true,"want_rows":true,"m":"1,2;3,4"}'
    import json
    t = _call_text(req)
    assert json.loads(t)["ok"] == EN.call("nmod_echelon", p="7", rows=2, cols=2, reduced=True, want_rows=True, m="1,2;3,4")
    ok("call_text's reply is call()'s; nmod_echelon has no _LIMITED entry")


# ------------------------------------------------------------------ memory

LINUX = os.path.exists("/proc/self/clear_refs")


def status(key):
    with open("/proc/self/status") as f:
        for line in f:
            if line.startswith(key + ":"):
                return int(line.split()[1]) * 1024
    raise KeyError(key)


def mem_shapes(F):
    """(label, rows, cols) at each op's widest sent shape: the matrix
    actually sent ([A | b], [A | B], [A | I]), 19-digit entries."""
    A = rand_matrix(F, 1024, 1024, 11, big=True)
    S = rand_matrix(F, 1023, 1024, 12, big=True)  # [A | b]
    K = rand_matrix(F, 1000, 1024, 13, big=True)  # [A | B], m + k = 1024
    G = rand_matrix(F, 512, 512, 14, big=True)
    one, zero = F.one(), F.zero()
    inv = [list(r) + [one if i == j else zero for j in range(512)] for i, r in enumerate(G._rows)]  # [A | I]
    return [("1024x1024", A._rows, 1024), ("solve 1023x1024", S._rows, 1024), ("solve k 1000x1024", K._rows, 1024), ("inverse 512x1024", inv, 1024)]


def wasm_bound(e):
    """pyjs: the engine's own memory for E entries, outside the heap but
    resident (nmod_ops.rs: R + 28 E + 33 KiB, R <= 20 E + 4 KiB)."""
    return 48 * e + 37 * KIB if PYJS else 0


class Peak:
    """One interval's peaks: VmHWM - VmRSS (reset by clear_refs), and in
    CPython, if traced, tracemalloc's, started after the operands exist
    (astra2's note: the prebuilt operands are not in the baseline)."""

    def __init__(self, traced=False):
        self.tracing = traced and not PYJS

    def __enter__(self):
        if self.tracing:
            import tracemalloc
            tracemalloc.start()
            tracemalloc.reset_peak()
        with open("/proc/self/clear_refs", "w") as f:
            f.write("5")
        self.rss = status("VmRSS")
        return self

    def __exit__(self, *exc):
        self.hwm = status("VmHWM") - self.rss
        self.traced = None
        if self.tracing:
            import tracemalloc
            self.traced = tracemalloc.get_traced_memory()[1]
            tracemalloc.stop()
        return False


class Measured:
    pass


def measure(f):
    """f's peaks: in CPython two runs of f, one under tracemalloc (its
    traced peak) and one without (VmHWM: tracemalloc's own bookkeeping,
    tens of bytes for each block it traces, is resident memory, 40 MB for a
    2^20-element result); in pyjs one.  The value is the untraced run's."""
    pk = Measured()
    pk.traced = None
    if not PYJS:
        with Peak(traced=True) as t:
            v = f()
        del v
        pk.traced = t.traced
    with Peak() as h:
        pk.value = f()
    pk.hwm = h.hwm
    return pk


def report(label, e, pk, extra=""):
    ok(label, "E", e, "VmHWM-VmRSS", pk.hwm, "(%.1f B/entry)" % (pk.hwm / e), "traced", pk.traced, extra)


def case_mem_T():
    F = GF(P63)
    p = int(F.order())
    for label, rows, c in mem_shapes(F):
        e = len(rows) * c
        pk = measure(lambda: FM._engine_echelon_transport(rows, c, p, True))
        assert pk.value[2] is not None
        del pk.value
        report(label, e, pk)
        if pk.traced is not None:
            assert pk.traced <= 40 * e + 256 * KIB, (label, pk.traced)
        assert pk.hwm <= need(len(rows), c) + wasm_bound(e) + 4 * MIB, (label, pk.hwm)


def case_mem_Tp():
    F = GF(P63)
    A = rand_matrix(F, 1024, 1024, 11, big=True)
    e = 1024 * 1024
    for op in ("rank", "det"):
        pk = measure(lambda: sent(getattr(A, op)))
        assert pk.value[1] == [(1024, 1024)]
        del pk.value
        report(op + "()", e, pk)
        if pk.traced is not None:
            assert pk.traced <= 40 * e + 256 * KIB, (op, pk.traced)
        assert pk.hwm <= need(1024, 1024) + wasm_bound(e) + 4 * MIB, (op, pk.hwm)


def result_size(m):
    """CPython: the bytes the returned rows hold of their own (the list,
    the row lists, each distinct element and its int, once by id; ints of
    the small-int cache are shared, not the result's)."""
    seen = set()
    n = sys.getsizeof(m)
    for row in m:
        n += sys.getsizeof(row)
        for x in row:
            if id(x) not in seen:
                seen.add(id(x))
                n += sys.getsizeof(x)
                v = getattr(x, "_v", None)
                if v is None:
                    v = int(x)
                if isinstance(v, int) and not -5 <= v <= 256 and id(v) not in seen:
                    seen.add(id(v))
                    n += sys.getsizeof(v)
    return n


def case_mem_W():
    F = GF(P63)
    p = int(F.order())
    for label, rows, c in mem_shapes(F):
        r = len(rows)
        e = r * c
        if PYJS:
            base = sys._sagebrush_heap_used()
        pk = measure(lambda: FM._engine_echelon(rows, F, c, p, True))
        m = pk.value[0]
        del pk.value  # (only the rows stay alive: astra2's note)
        if PYJS:
            held = sys._sagebrush_heap_used()
            del m
            res = held - sys._sagebrush_heap_used() if base is not None else None
            assert res is not None, "pyjs: no heap statistics (Node with a collector)"
        else:
            res = result_size(m)
            del m
        report(label, e, pk, "Res %d (%.1f B/entry)" % (res, res / e))
        if PYJS:
            assert pk.hwm <= need(r, c) + res + wasm_bound(e) + 4 * MIB, (label, pk.hwm, res)
        else:
            assert res <= 93 * e + 64 * KIB, (label, res)
            assert pk.traced <= max(40 * e + 256 * KIB, 20 * e + res + 104 * KIB), (label, pk.traced, res)
            assert pk.hwm <= need(r, c) + res + 4 * MIB, (label, pk.hwm, res)


def old_engine_echelon(rows, base, ncols, p, want_rows):
    """Today's bridge, before plan F4 r4 §2a (for the negative control)."""
    text = ";".join(",".join(str(int(x)) for x in r) for r in rows)
    r = EN.call("nmod_echelon", p=str(p), rows=len(rows), cols=ncols, m=text, reduced=bool(want_rows), want_rows=bool(want_rows))
    return [int(t) for t in r["pivots"].split(",")] if r["pivots"] else []


def case_negctl():
    """Today's bridge exceeds the transport bound: in CPython its traced
    peak for a rank at 1024 x 1024 with 19-digit entries (astra2's note:
    long actual entries, so the text is near 20 E) passes 40 E + 256 KiB.
    (pyjs's encoder copy: test/ffmat-echelon-admission.test.ts, through
    engineCall itself.)"""
    if PYJS:
        ok("skipped in pyjs (the engineCall test is its negative control)")
        return
    F = GF(P63)
    A = rand_matrix(F, 1024, 1024, 11, big=True)
    e = 1024 * 1024
    text = sum(len(str(int(x))) + 1 for x in A._rows[0]) * 1024
    assert text > 19 * e, text
    pk = measure(lambda: old_engine_echelon(A._rows, F, 1024, int(F.order()), False))
    report("old bridge rank", e, pk)
    assert pk.traced > 40 * e + 256 * KIB, pk.traced
    pk = measure(lambda: FM._engine_echelon_transport(A._rows, 1024, int(F.order()), False))
    report("new bridge rank", e, pk)
    assert pk.traced <= 40 * e + 256 * KIB, pk.traced


def case_interrupt():
    F = GF(P63)
    A = rand_matrix(F, 1024, 1024, 21, big=True)

    d = sys.argv[2] if len(sys.argv) > 2 else None

    def ready_then_call(request):
        print("ready", flush=True)  # (the request is built: the engine runs next)
        if d:
            open(os.path.join(d, "ready"), "w").close()
        return _counting_call_text(request)
    EN.call_text = ready_then_call
    try:
        r = A.echelon_form().rank()
        out = "not interrupted %s %s" % (r, SENT)
    except KeyboardInterrupt:
        # the engine call was interrupted, and no Python elimination followed
        out = "interrupted %s" % (SENT,)
    print(out, flush=True)
    if d:
        with open(os.path.join(d, "result"), "w") as f:
            f.write(out)


CASES = {
    "route": case_route, "route-ech": case_route_ech, "route-solve": case_route_solve, "route-solvek": case_route_solvek,
    "route-inv": case_route_inv, "preflight": case_preflight, "integration": case_integration, "correct": case_correct,
    "bridge": case_bridge, "mem-T": case_mem_T, "mem-Tp": case_mem_Tp, "mem-W": case_mem_W, "negctl": case_negctl,
    "interrupt": case_interrupt,
}
if CASE.startswith("mem") or CASE == "negctl":
    if not LINUX:
        ok("skipped: no /proc/self/clear_refs (Linux only)")
        sys.exit(0)
CASES[CASE]()
