"""GF(p) echelon on the binary route (engine/web bin_ops.rs nmod_echelon),
the cases shared by both runtimes:
test/ffmat-echelon-bin.test.ts runs them in pyjs (build/cli/pyjs.cjs --sage
THIS CASE) and engine/py/test_ech_bin.py in CPython (python3 THIS CASE).
Each case prints "ok CASE ..." lines and raises on a failure.

    route      past the JSON route's 1024 envelope, every caller takes the
               binary op at its actual shape ([A | B] and [A | I] packed, no
               augmented list), counted at the call
    correct    the binary route against the Python path, exactly
    json       the binary route against the JSON route, at shapes both take
    probe      each caller's admission arguments (shape, want_rows, the
               result bytes G): rank and det charge no rows
    preflight  the host's need at need and need - 1 (the figure hook): the
               route, or the memory error with what fits, never the Python
               path
    frame      a frame-only non-fit (the frame cap hook) keeps the Python
               path under its own admission
    outcomes   the engine's replies by code: the reservation refused is the
               memory error, called once; an engine without the op falls
               back; protocol and invariant failures are RuntimeError; a
               KeyboardInterrupt propagates, called once
    kernel     the kernel basis at an unknown rank: square of rank n / 2,
               full rank, low-rank wide, zero; its second check (W and the
               basis together)
    mem        the measured peaks (Linux) within the predicate's need, at
               1 x c, r x 1 and square shapes, with and without rows
    cops       the route's uninterruptible C operations at their actual
               maximum size (the frame cap), within the Stop bound
    interrupt [DIR]
               prints "ready" (and creates DIR/ready) just before a long
               binary elimination for the harness to interrupt
"""
import os
import sys

try:
    GF
except NameError:
    try:  # (pyjs, run as plain Python)
        from sage_all import *
    except ImportError:  # (CPython: the package)
        sys._sagebrush_heap_limit = 1 << 32  # (a figure that admits the cases' operands)
        import sagebrush
        from sagebrush.sage import *

import _sage_ffmat as FM
import _memguard
import sagebrush._engine as EN

PYJS = hasattr(sys, "_sagebrush_heap_used")
CASE = sys.argv[1]
P63 = 9223372036854775783
KIB, MIB = 1024, 1 << 20

# ------------------------------------------------------------------ counters

CALLS = []  # (rows, cols, want_rows) of each binary call
ROUTES = []  # (rows, cols, want_rows, out) of each admission asked
_bin_call = FM._ech_bin_call
_bin_route = FM._ech_bin_route


def _counting_call(rowsrc, base, r, c, p, want_rows):
    CALLS.append((r, c, want_rows))
    return _bin_call(rowsrc, base, r, c, p, want_rows)


def _probing_route(base, r, c, want_rows, out, out_of=None):
    ROUTES.append((r, c, want_rows, out))
    return _bin_route(base, r, c, want_rows, out, out_of)


FM._ech_bin_call = _counting_call
FM._ech_bin_route = _probing_route


def calls(f):
    """(f's value, the shapes it sent to the binary op)."""
    del CALLS[:]
    v = f()
    return v, list(CALLS)


def with_figure(fig, f):
    FM._echelon_transport_figure = (lambda: fig) if fig is not None else None
    try:
        return f()
    finally:
        FM._echelon_transport_figure = None


def python_path(f):
    """f with the binary and JSON routes off (the Python elimination)."""
    FM._ECH_BIN_ENABLED = False
    try:
        return with_figure(0, f)
    finally:
        FM._ECH_BIN_ENABLED = True


def json_route(f):
    """f with the binary route off (the JSON route where it admits)."""
    FM._ECH_BIN_ENABLED = False
    try:
        return f()
    finally:
        FM._ECH_BIN_ENABLED = True


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
    exactly."""
    import random
    g = random.Random(seed)
    p = int(F.order())
    U = matrix(F, m, r, [(1 if i == j else 0) if i < r else g.randrange(p) for i in range(m) for j in range(r)])
    V = matrix(F, r, n, [(1 if i == j else 0) if j < r else g.randrange(p) for i in range(r) for j in range(n)])
    return U * V


def outcome(h):
    try:
        return ("value", h())
    except (ValueError, ZeroDivisionError, ArithmeticError) as e:
        return ("raise", type(e).__name__, str(e))


# ------------------------------------------------------------------ cases

def case_route():
    F = GF(32003)
    I = identity_matrix(F, 1025)
    assert calls(I.rank) == (1025, [(1025, 1025, False)])
    assert calls(I.det) == (1, [(1025, 1025, False)])
    v, s = calls(I.echelon_form)
    assert v == I and s == [(1025, 1025, True)]
    row = matrix(F, 1, 4096, [1] + [0] * 4095)
    assert calls(row.rank) == (1, [(1, 4096, False)])
    assert calls(row.transpose().rank) == (1, [(4096, 1, False)])
    I = identity_matrix(F, 1100)
    B = matrix(F, 1100, 3, [(i + j) % 7 for i in range(1100) for j in range(3)])
    v, s = calls(lambda: I.solve_right(B))
    assert v == B and s == [(1100, 1103, True)], s
    b = vector(F, [i % 7 for i in range(1100)])
    v, s = calls(lambda: I.solve_right(b))
    assert v == b and s == [(1100, 1101, True)], s
    J = identity_matrix(F, 700)
    v, s = calls(J.inverse)
    assert v == J and s == [(700, 1400, True)], s
    ok("rank/det/echelon at 1025, 1 x 4096 and 4096 x 1, [A | B] 1100 x 1103, [A | b] 1100 x 1101, [A | I] 700 x 1400")


def case_correct():
    for p in (2, 7, 65537, 1000000007, P63):
        F = GF(p)
        mats = [
            rand_matrix(F, 12, 30, 3), rand_matrix(F, 30, 12, 4),
            rank_r(F, 30, 20, 7), rank_r(F, 20, 30, 5),
            rand_matrix(F, 25, 25, 5, big=True),
            rand_matrix(F, 1, 40, 6), rand_matrix(F, 40, 1, 7),
        ]
        for A in mats:
            for op in ("rank", "echelon_form", "pivots"):
                a, s = calls(lambda: outcome(getattr(A, op)))
                b = python_path(lambda: outcome(getattr(A, op)))
                assert s and a == b, (p, op, A.dimensions())
            k = outcome(lambda: A.right_kernel().basis_matrix())
            assert k == python_path(lambda: outcome(lambda: A.right_kernel().basis_matrix())), (p, "kernel")
        for Q in (rand_matrix(F, 9, 9, 8, big=True), rank_r(F, 9, 9, 6)):
            assert calls(lambda: outcome(Q.det))[0] == python_path(lambda: outcome(Q.det)), (p, "det")
        A = rank_r(F, 20, 8, 8)
        x = vector(F, [i + 1 for i in range(8)])
        assert calls(lambda: outcome(lambda: A.solve_right(A * x)))[0] == ("value", x)
        W = rank_r(F, 8, 20, 8)
        Bm = W * matrix(F, 20, 3, list(range(60)))
        a = calls(lambda: outcome(lambda: W.solve_right(Bm)))[0]
        assert a == python_path(lambda: outcome(lambda: W.solve_right(Bm))) and W * a[1] == Bm
        T = matrix(F, [list(r) for r in rank_r(F, 9, 10, 6).rows()] + [[0] * 10])
        c = vector(F, [1] * 10)
        assert calls(lambda: outcome(lambda: T.solve_right(c)))[0][0] == "raise"
        G = rand_matrix(F, 12, 12, 9, big=True)
        a = calls(lambda: outcome(G.inverse))[0]
        assert a == python_path(lambda: outcome(G.inverse)), (p, "inverse")
        S = rank_r(F, 6, 6, 4)
        assert calls(lambda: outcome(S.inverse))[0][0] == "raise"
        for E in (matrix(F, 0, 3), matrix(F, 3, 0), matrix(F, 0, 0)):
            assert calls(E.rank) == (0, [])
        ok("p =", p)


def case_json():
    for p in (7, 32003, P63):
        F = GF(p)
        for A in (rand_matrix(F, 300, 301, 21), rank_r(F, 200, 260, 90, 22), rand_matrix(F, 1, 1000, 23), rand_matrix(F, 1000, 1, 24)):
            for op in ("rank", "echelon_form", "pivots", "right_kernel"):
                a, s = calls(lambda: outcome(getattr(A, op)))
                b = json_route(lambda: outcome(getattr(A, op)))
                assert s and a == b, (p, op, A.dimensions())
        ok("p =", p, "the binary route equals the JSON route")


def case_probe():
    F = GF(32003)
    A = rank_r(F, 40, 70, 20)
    cost = FM._ech_out_cost

    def probe(f):
        del ROUTES[:]
        f()
        return list(ROUTES)
    assert probe(A.rank) == [(40, 70, False, 0)]
    assert probe(A.pivots) == [(40, 70, False, 0)]
    S = rank_r(F, 30, 30, 30)
    assert probe(S.det) == [(30, 30, False, 0)]
    assert probe(A.echelon_form) == [(40, 70, True, cost(F, 40, 70))]
    B = matrix(F, 30, 4, list(range(120)))
    assert probe(lambda: S.solve_right(B)) == [(30, 34, True, cost(F, 30, 4))]
    b = vector(F, list(range(30)))
    assert probe(lambda: S.solve_right(b)) == [(30, 31, True, cost(F, 1, 30))]
    assert probe(S.inverse) == [(30, 60, True, cost(F, 30, 30))]
    r = probe(A.right_kernel)
    assert r[0] == (40, 70, True, FM._ech_kernel_out(40, 70)), r[0]
    # (the worst rank, not the actual one: max k (c - k) over k <= min(r, c))
    assert FM._ech_kernel_out(40, 70) == 8 * 35 * 35 and FM._ech_kernel_out(600, 600) == 8 * 300 * 300
    assert FM._ech_kernel_out(5, 100) == 8 * 5 * 95 and FM._ech_kernel_out(7, 7) == 8 * 3 * 4
    ok("each caller's shape, want_rows and G; rank/det/pivots charge no rows")


def preflight_calls(F):
    """(label, (r, c, want_rows, out), the call) at small shapes."""
    row, col = rand_matrix(F, 1, 4096, 31), rand_matrix(F, 4096, 1, 32)
    S = rand_matrix(F, 50, 50, 33)
    B = matrix(F, 50, 3, list(range(150)))
    b = vector(F, list(range(50)))
    cost = FM._ech_out_cost
    return [
        ("rank 1x4096", (1, 4096, False, 0), row.rank),
        ("rank 4096x1", (4096, 1, False, 0), col.rank),
        ("echelon 1x4096", (1, 4096, True, cost(F, 1, 4096)), row.echelon_form),
        ("echelon 4096x1", (4096, 1, True, cost(F, 4096, 1)), col.echelon_form),
        ("solve k", (50, 53, True, cost(F, 50, 3)), lambda: S.solve_right(B)),
        ("solve 1", (50, 51, True, cost(F, 1, 50)), lambda: S.solve_right(b)),
        ("inverse", (50, 100, True, cost(F, 50, 50)), S.inverse),
    ]


def case_preflight():
    F = GF(32003)
    for label, (r, c, rows, out), call in preflight_calls(F):
        n = FM._ech_need(r, c, rows, out)
        want = python_path(lambda: outcome(call))
        v, s = with_figure(FM._HEAP_SHARE * n, lambda: calls(lambda: outcome(call)))
        assert s == [(r, c, rows)] and v == want, (label, s)
        try:
            with_figure(FM._HEAP_SHARE * n - 1, lambda: calls(call))
            raise AssertionError(label + ": admitted one byte short")
        except _memguard.SagebrushMemoryError as e:
            assert CALLS == [], (label, CALLS)
            assert e.need_bytes == n and e.limit_bytes == n - 1, (label, e.need_bytes, e.limit_bytes)
            assert "%d x %d" % (r, c) in str(e) and "At most about" in str(e) and e.fits >= 0, (label, str(e))
            # (what fits, fits)
            assert FM._ech_need(e.fits, e.fits, rows, 0 if not rows else 0) <= n - 1
        ok(label, "need", n, "routed at need, the memory error at need - 1 (no call, no Python path)")


def case_frame():
    F = GF(32003)
    A = rand_matrix(F, 1100, 3, 41)
    q = FM._ech_request_len(1100, 3)
    want = python_path(A.rank)
    FM._SBW1_FRAME_CAP = q
    try:
        assert calls(A.rank) == (want, [(1100, 3, False)])
        FM._SBW1_FRAME_CAP = q - 1
        assert calls(A.rank) == (want, []), "a frame-only non-fit keeps the Python path"
    finally:
        FM._SBW1_FRAME_CAP = None
    ok("Q", q, "binary at the frame cap, the Python path one byte past it")


def er(code, text=b"x"):
    return b"SBW1er" + code.to_bytes(2, "little") + (0).to_bytes(8, "little") + len(text).to_bytes(2, "little") + text


def case_outcomes():
    F = GF(32003)
    A = rand_matrix(F, 20, 30, 51)
    want = python_path(A.rank)
    real = EN.call_bin
    n = [0]

    def fake(reply):
        def f(req):
            n[0] += 1
            if isinstance(reply, BaseException):
                raise reply
            return reply
        return f
    try:
        for label, reply, expect in [
            ("Cap", er(7), _memguard.SagebrushMemoryError),
            ("Frame", er(1), RuntimeError),
            ("Count", er(4), RuntimeError),
            ("Schema", er(5), RuntimeError),
            ("Internal", er(8), RuntimeError),
            ("Domain", er(6), ValueError),
            ("interrupt", KeyboardInterrupt(), KeyboardInterrupt),
        ]:
            n[0] = 0
            EN.call_bin = fake(reply)
            try:
                A.rank()
                raise AssertionError(label + ": no error")
            except expect:
                pass
            assert n[0] == 1, (label, "called", n[0])
        for label, reply in [("Header", er(2)), ("Op", er(3)), ("no entry point", None)]:
            n[0] = 0
            EN.call_bin = fake(reply)
            assert A.rank() == want and n[0] == 1, (label, n[0])
    finally:
        EN.call_bin = real
    ok("Cap: the memory error; Frame/Count/Schema/Internal: RuntimeError; Domain: ValueError; a KeyboardInterrupt propagates; each called once; Header/Op/None: the other paths")


def kernel_check(A, dim):
    K = A.right_kernel().basis_matrix()
    assert K.nrows() == dim, (A.dimensions(), K.nrows(), dim)
    assert K.nrows() == 0 or (A * K.transpose()).is_zero()
    return K


def case_kernel():
    F = GF(32003)
    kernel_check(rank_r(F, 200, 200, 100), 100)
    kernel_check(rand_matrix(F, 200, 200, 61), 0)
    kernel_check(rank_r(F, 8, 1024, 2), 1022)
    kernel_check(matrix(F, 1, 512), 512)
    # the second check, W and the basis together: a figure that admits the
    # first call but not the basis
    A = rank_r(F, 8, 512, 2)
    c, k = 512, 2
    need1 = FM._ech_need(8, c, True, FM._ech_kernel_out(8, c))
    need2 = 8 * k * (c - k) + FM._ech_out_cost(F, c - k, c) + (FM._ECH_INT_COST + 8) * c + c + (FM._ECH_INT_COST + 8) * (c - k) + 4 * FM._ECH_HDR + FM._ECH_SLACK
    # (the basis's own echelon, the second call, has its own need)
    need3 = FM._ech_need(c - k, c, True, FM._ech_out_cost(F, c - k, c))
    assert need1 < need2
    for fig, admitted in ((FM._HEAP_SHARE * max(need2, need3), True), (FM._HEAP_SHARE * need2 - 1, False)):
        try:
            v, s = with_figure(fig, lambda: calls(lambda: A.right_kernel().dimension()))
            assert admitted and v == c - k, (fig, v)
        except _memguard.SagebrushMemoryError as e:
            assert not admitted and e.need_bytes == need2 and "kernel basis" in str(e), (fig, str(e))
    ok("rank n/2 square, full rank, low-rank wide, zero; the second check at need2 and need2 - 1")


# ------------------------------------------------------------------ memory

LINUX = os.path.exists("/proc/self/clear_refs")


def status(key):
    with open("/proc/self/status") as f:
        for line in f:
            if line.startswith(key + ":"):
                return int(line.split()[1]) * 1024
    raise KeyError(key)


class Peak:
    """VmHWM - VmRSS over the interval (reset by clear_refs)."""

    def __enter__(self):
        with open("/proc/self/clear_refs", "w") as f:
            f.write("5")
        self.rss = status("VmRSS")
        return self

    def __exit__(self, *exc):
        self.hwm = status("VmHWM") - self.rss
        return False


def case_mem():
    """CPython: tracemalloc's peak of the Python side (every phase but the
    engine's, which is the extension's own memory) within the need's Python
    share (_ech_need python_only), and at least the words it must hold
    (the measurement sees the phases); and VmHWM - VmRSS of the first run
    (no warm-up: the allocator's growth counts) within need.  pyjs: VmHWM -
    VmRSS of the first run within need plus the wasm instance's
    reservation (outside the heap, but resident)."""
    F = GF(P63)
    cost = FM._ech_out_cost
    shapes = [
        ("rank 1x65536", 1, 1 << 16, False, lambda M: M.rank()),
        ("rank 65536x1", 1 << 16, 1, False, lambda M: M.rank()),
        ("echelon 1x65536", 1, 1 << 16, True, lambda M: M.echelon_form()),
        ("echelon 65536x1", 1 << 16, 1, True, lambda M: M.echelon_form()),
        ("rank 1100x1100", 1100, 1100, False, lambda M: M.rank()),
        ("echelon 1100x1100", 1100, 1100, True, lambda M: M.echelon_form()),
    ]
    for label, r, c, rows, op in shapes:
        e = r * c
        M = rand_matrix(F, r, c, 71, big=True)
        n = FM._ech_need(r, c, rows, cost(F, r, c) if rows else 0)
        engine = FM._ech_engine_reservation(r, c, rows)
        with Peak() as h:
            v = op(M)
        del v
        extra = ""
        if not PYJS:
            import tracemalloc
            tracemalloc.start()
            tracemalloc.reset_peak()
            v = op(M)
            traced = tracemalloc.get_traced_memory()[1]
            tracemalloc.stop()
            del v
            py = FM._ech_need(r, c, rows, cost(F, r, c) if rows else 0, python_only=True)
            extra = " traced %d (%.2f of the Python share %d)" % (traced, traced / py, py)
            assert 8 * e <= traced <= py, (label, traced, py)
        print("   ", label, "VmHWM-VmRSS", h.hwm, "need", n, "(%.2f)" % (h.hwm / n) + extra, flush=True)
        bound = n + (engine if PYJS else 0)
        assert h.hwm <= bound, (label, h.hwm, bound)
        del M
    ok("the measured peaks within the predicate's need")


def case_cops():
    """The route's uninterruptible C operations, each at its actual maximum
    size (a request at the frame cap: E = (2^28 - 100) / 8 words), timed
    (the worst of three runs) against the interrupt harness's Stop bound
    (web/interrupt-classify.mjs STOP_BOUND_MS): the words' allocation, the
    frame's join, a reply-sized bytes copy (the binding's copy of the
    reply, PyBytes::new / pyjs's slice) and the rows' frombytes.  A Stop
    raised during one is seen once it returns."""
    import array
    import time
    bound_ms = 250
    e = (FM._ech_frame_cap() - 100) // 8
    worst = {}

    def timed(name, f):
        for _ in range(3):
            t = time.perf_counter()
            x = f()
            ms = (time.perf_counter() - t) * 1e3
            del x
            worst[name] = max(worst.get(name, 0), ms)
    w = array.array("Q", [0]) * e
    timed("words", lambda: array.array("Q", [0]) * e)
    timed("join", lambda: b"".join([b"h" * 76, memoryview(w).cast("B"), b"t" * 24]))
    req = b"".join([b"h" * 76, memoryview(w).cast("B"), b"t" * 24])
    del w
    timed("reply copy", lambda: bytes(memoryview(req)[1:]))

    def fb():
        a = array.array("Q")
        a.frombytes(memoryview(req)[76:76 + 8 * e])
        return a
    timed("frombytes", fb)
    del req
    for name, ms in worst.items():
        print("   ", name, "%.0f ms" % ms, "(bound %d ms)" % bound_ms, flush=True)
    late = {k: round(v) for k, v in worst.items() if v > bound_ms}
    assert not late, "past the Stop bound at the frame cap: %r" % late
    ok("each C operation at the frame cap within %d ms" % bound_ms, {k: round(v) for k, v in worst.items()})


def case_interrupt():
    F = GF(P63)
    A = rand_matrix(F, 2048, 2048, 81, big=True)
    d = sys.argv[2] if len(sys.argv) > 2 else None
    real = EN.call_bin

    def ready_then_call(req):
        print("ready", flush=True)
        if d:
            open(os.path.join(d, "ready"), "w").close()
        return real(req)
    EN.call_bin = ready_then_call
    try:
        r = A.echelon_form().rank()
        out = "not interrupted %s %s" % (r, CALLS)
    except KeyboardInterrupt:
        out = "interrupted %s" % (CALLS,)
    print(out, flush=True)
    if d:
        with open(os.path.join(d, "result"), "w") as f:
            f.write(out)


CASES = {
    "route": case_route, "correct": case_correct, "json": case_json, "probe": case_probe, "preflight": case_preflight,
    "frame": case_frame, "outcomes": case_outcomes, "kernel": case_kernel, "mem": case_mem, "cops": case_cops,
    "interrupt": case_interrupt,
}
if CASE == "mem" and not LINUX:
    ok("skipped: no /proc/self/clear_refs (Linux only)")
    sys.exit(0)
CASES[CASE]()
