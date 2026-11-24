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
    types      the binary call's argument contract, in both runtimes
    kernelmem  the kernel's admissions against its measured extraction and
               basis, and the reply dead before the basis
    cops       Stop during each frame-sized step at the frame cap (CPython),
               each single-copy mutant missing the same bound
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
        # (1 x 600 and 600 x 1: their kernel bases fit pyjs's declared 1 GiB
        # heap; 1 x 1000's 999 x 1000 basis is refused there)
        for A in (rand_matrix(F, 300, 301, 21), rank_r(F, 200, 260, 90, 22), rand_matrix(F, 1, 600, 23), rand_matrix(F, 600, 1, 24)):
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
    # (the worst rank, not the actual one: max k (c - k) over k <= min(r, c),
    # W in its chunks, and the pivot flags, a bytearray of c)
    out = lambda w, c: FM._ech_words_cost(w) + c + FM._ECH_HDR
    assert FM._ech_kernel_out(40, 70) == out(35 * 35, 70) and FM._ech_kernel_out(600, 600) == out(300 * 300, 600)
    assert FM._ech_kernel_out(5, 100) == out(5 * 95, 100) and FM._ech_kernel_out(7, 7) == out(3 * 4, 7)
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
            assert isinstance(req, list), "the route sends its request in pieces"
            if isinstance(reply, BaseException):
                raise reply
            return [reply] if isinstance(reply, bytes) else reply
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
        for label, reply in [("Header", er(2)), ("Op", er(3)), ("no entry point", None), ("a bytes-only binding", TypeError("takes bytes"))]:
            n[0] = 0
            EN.call_bin = fake(reply)
            assert A.rank() == want and n[0] == 1, (label, n[0])
    finally:
        EN.call_bin = real
    ok("Cap: the memory error; Frame/Count/Schema/Internal: RuntimeError; Domain: ValueError; a KeyboardInterrupt propagates; each called once; Header/Op/None/a bytes-only binding: the other paths")


def kernel_check(A, dim):
    K = A.right_kernel().basis_matrix()
    assert K.nrows() == dim, (A.dimensions(), K.nrows(), dim)
    assert K.nrows() == 0 or (A * K.transpose()).is_zero()
    return K


def case_kernel():
    F = GF(32003)
    kernel_check(rank_r(F, 200, 200, 100), 100)
    kernel_check(rand_matrix(F, 200, 200, 61), 0)
    # (8 x 600: its 598 x 600 basis fits pyjs's declared 1 GiB heap)
    kernel_check(rank_r(F, 8, 600, 2), 598)
    kernel_check(matrix(F, 1, 512), 512)
    # the second check, W and the basis together: a figure that admits the
    # first call but not the basis
    A = rank_r(F, 8, 512, 2)
    c, k = 512, 2
    need1 = FM._ech_need(8, c, True, FM._ech_kernel_out(8, c))
    need2 = FM._ech_kernel_need2(F, k, c)
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


def case_types():
    """The binary call's argument contract, the same in both runtimes: bytes
    (one reply), a list of bytes pieces (a list of pieces); a tuple, a
    bytearray, a memoryview or a list with another piece is a TypeError;
    a pieces request past the frame cap, or in too many pieces, a
    ValueError before anything is assembled."""
    req = b"SBW1" + (12).to_bytes(4, "little") + b"nmod_poly_xx"
    assert isinstance(EN.call_bin(req), bytes)
    r = EN.call_bin([req[:5], req[5:]])
    assert isinstance(r, list) and all(isinstance(b, bytes) for b in r) and b"".join(r)[:6] == b"SBW1er", r
    for arg in ((req,), bytearray(req), memoryview(req), [req[:5], bytearray(req[5:])], [req[:5], 7]):
        try:
            EN.call_bin(arg)
            raise AssertionError("accepted: %s" % type(arg).__name__)
        except TypeError:
            pass
    one = bytes(1 << 20)
    for arg in ([one] * 257, [one] * 256 + [b"x"], [b""] * ((1 << 16) + 1)):
        try:
            EN.call_bin(arg)
            raise AssertionError("past the cap accepted")
        except ValueError:
            pass
    ok("bytes and lists of bytes; tuples, bytearrays, memoryviews and mixed lists TypeError; past the cap ValueError")


def case_kernelmem():
    """The kernel's first admission against its extraction (CPython,
    tracemalloc): wide kernels of non-small entries, whose basis the second
    check refuses, peak (up to the refusal) within the first call's Python
    share; a rank n / 2 square's whole call within the largest of its three
    admissions; and the reply dead (a weakref) before the basis is admitted
    (its second check) or built."""
    if PYJS:
        ok("skipped in pyjs (tracemalloc and weakref timing are CPython's)")
        return
    import gc
    import tracemalloc
    import weakref
    F = GF(P63)
    cost = FM._ech_out_cost
    replies = []
    real_reply, real_admit = FM._EchReply, FM._admit_size

    class Watched(real_reply):
        def __init__(self, pieces):
            real_reply.__init__(self, pieces)
            replies.append(weakref.ref(self))

    def admit(base, m, n, factor=1):
        # (the kernel's second check calls _admit_size just before the basis)
        assert all(w() is None for w in replies), "the reply is still alive at the basis's admission"
        return real_admit(base, m, n, factor)
    FM._EchReply, FM._admit_size = Watched, admit
    try:
        for c in (1 << 16, 1 << 18):
            A = rand_matrix(F, 1, c, 91, big=True)
            n1 = FM._ech_need(1, c, True, FM._ech_kernel_out(1, c))
            py1 = FM._ech_need(1, c, True, FM._ech_kernel_out(1, c), python_only=True)
            del replies[:]
            gc.collect()
            tracemalloc.start()
            tracemalloc.reset_peak()
            try:
                with_figure(FM._HEAP_SHARE * n1, lambda: A._kernel_basis())
                raise AssertionError("1 x %d: the basis was admitted" % c)
            except _memguard.SagebrushMemoryError as e:
                assert "kernel basis" in str(e), str(e)
            traced = tracemalloc.get_traced_memory()[1]
            tracemalloc.stop()
            print("    kernel 1x%d: traced %d up to the second check, the first admission's Python share %d (%.2f)" % (c, traced, py1, traced / py1), flush=True)
            assert traced <= py1, (c, traced, py1)
            assert replies and all(w() is None for w in replies)
        n = 200
        A = rank_r(F, n, n, n // 2, 92)
        k = n // 2
        needs = [FM._ech_need(n, n, True, FM._ech_kernel_out(n, n), python_only=True),
                 FM._ech_kernel_need2(F, k, n),
                 FM._ech_need(n - k, n, True, cost(F, n - k, n), python_only=True)]
        del replies[:]
        tracemalloc.start()
        tracemalloc.reset_peak()
        K = A._kernel_basis()
        traced = tracemalloc.get_traced_memory()[1]
        tracemalloc.stop()
        assert len(K) == n - k
        print("    kernel %dx%d rank %d: traced %d, the admissions %r" % (n, n, k, traced, needs), flush=True)
        assert traced <= max(needs), (traced, needs)
    finally:
        FM._EchReply, FM._admit_size = real_reply, real_admit
    ok("wide kernels within the first admission up to the second check; the reply dead before the basis")


def stop_latency(step, delays, need=3):
    """The worst time from a SIGINT, sent after each delay into step(), to
    its KeyboardInterrupt (step() run once per delay).  The signal comes
    from a helper process (no thread or lock in this one, which an
    asynchronous KeyboardInterrupt could leave held), which reports when it
    sent it; a delay the step outlasts is skipped (the helper stopped, a
    stray signal drained), and at least `need` delays must land."""
    import signal
    import subprocess
    import time
    worst, landed = 0.0, 0
    for d in delays:
        helper = subprocess.Popen([sys.executable, "-c",
                                   "import os, sys, time\ntime.sleep(%r)\nt = time.time()\nos.kill(%d, %d)\nprint(repr(t), flush=True)" % (d, os.getpid(), int(signal.SIGINT))],
                                  stdout=subprocess.PIPE, text=True)
        caught = None
        try:
            step()
        except KeyboardInterrupt:
            caught = time.time()
        while True:
            # (the helper may still send: stop it, then drain its signal)
            try:
                if caught is None:
                    helper.terminate()
                out = helper.communicate()[0]
                time.sleep(0.3)
                break
            except KeyboardInterrupt:
                continue
        sent = float(out) if out.strip() else None
        if caught is not None and sent is not None:
            worst = max(worst, caught - sent)
            landed += 1
    assert landed >= need, "only %d of %d signals landed inside the step" % (landed, len(delays))
    return worst * 1e3


def case_cops():
    """Stop during each frame-sized step of the route at its actual maximum
    size (a request at the frame cap, E = (2^28 - 100) / 8 words), CPython:
    a SIGINT sent at several points into the step, and the worst time to its
    KeyboardInterrupt, against a bound of BOUND_MS (a fifth of the interrupt
    harness's 250 ms Stop bound, web/interrupt-classify.mjs: one run of a
    chunk and a check), and for the whole engine call CALL_BOUND_MS (half
    of it: the release of its frame-sized buffers after a Stop is added).  Each step's single-copy version (the mutant: the
    whole buffer in one C operation, as before) must miss the same bound:
    the measurement sees one uninterruptible copy of that size."""
    if PYJS:
        ok("skipped in pyjs: its copies into and out of the engine (src/runtime/engine.ts binCallPieces) are tested at the frame cap by test/ffmat-echelon-bin-copy.test.ts, a Ctrl-C after one run each way and each omission mutant copying the whole frame")
        return
    import array
    import itertools
    import time
    BOUND_MS = 50
    CALL_BOUND_MS = 125
    from sagebrush._engine import call_bin
    e = (FM._ech_frame_cap() - 100) // 8
    rows, cols = e // 1024, 1024
    e = rows * cols
    q = FM._ech_request_len(rows, cols)
    results = {}

    def timed(f):
        t = time.perf_counter()
        f()
        return time.perf_counter() - t

    def delays(total, k=5):
        return [total * (i + 1) / (k + 2) for i in range(k)]

    # 1. pack: _ech_pack against the old words array and join
    src = lambda: (itertools.repeat(P63 - 2, cols) for _ in range(rows))
    dur = timed(lambda: FM._ech_pack(src(), rows, cols, P63, 3))
    results["pack"] = stop_latency(lambda: FM._ech_pack(src(), rows, cols, P63, 3), delays(dur))

    def old_pack():
        w = array.array("Q", [0]) * e
        return b"".join([b"h" * 76, memoryview(w).cast("B"), b"t" * 24])
    dur = timed(old_pack)
    results["pack (mutant: words + join)"] = stop_latency(old_pack, [0.05, 0.1] + delays(dur, 3))

    # 2. the request into the binding: a frame-cap list of pieces (a zero
    # E-word matrix: the engine refuses nothing, the reply has its rows)
    zero = bytes(FM._ECH_PIECE)
    le = lambda x, n: x.to_bytes(n, "little")
    head = b"".join([b"SBW1", le(12, 4), b"nmod_echelon", le(3, 4), FM._ff._sbw1_u641(array.array("Q", (P63,))),
                     le(24 + 8 * e, 4), b"MAT1", le(rows, 4), le(cols, 4), b"U641", le(e, 8)])
    body = 8 * e
    pieces = [head] + [zero] * (body // FM._ECH_PIECE) + ([bytes(body % FM._ECH_PIECE)] if body % FM._ECH_PIECE else [])
    pieces.append(FM._ff._sbw1_u641(array.array("Q", (3,))))
    assert sum(len(b) for b in pieces) == q
    t = time.perf_counter()
    reply = call_bin(pieces)
    dur = time.perf_counter() - t
    assert isinstance(reply, list) and reply[0][:6] == b"SBW1ok", reply[0][:40]
    results["call (copy in, engine, reply out)"] = stop_latency(lambda: call_bin(pieces), delays(dur, 8))

    def old_copy_in():
        return b"".join(pieces)
    dur = timed(old_copy_in)
    results["copy in (mutant: one copy)"] = stop_latency(old_copy_in, [0.05, 0.1] + delays(dur, 3))
    one = b"".join(pieces)
    del pieces
    t = time.perf_counter()
    call_bin(one)
    dur = time.perf_counter() - t
    results["reply out (mutant: one bytes)"] = stop_latency(lambda: call_bin(one), delays(dur, 10))
    del one

    # 3. the parse: the reply's runs against one frombytes of the rows
    def parse():
        rd = FM._EchReply(list(reply))
        rd.take(10)
        rd.words(rd.u641())
        rd.u641()
        rd.words(1)
        rd.u641()
        n = 0
        for _, _, v in FM._ech_row_runs(rd, rows, cols):
            n += len(v)
        assert n == e
    dur = timed(parse)
    results["parse"] = stop_latency(parse, delays(dur))
    flat = b"".join(reply)

    def old_parse():
        a = array.array("Q")
        # (the rows payload: after the header, no pivots and the det, at 66)
        a.frombytes(memoryview(flat)[66:66 + 8 * e])
        return a
    dur = timed(old_parse)
    results["parse (mutant: one frombytes)"] = stop_latency(old_parse, [0.05, 0.1] + delays(dur, 3))
    del flat, reply

    # (the whole call's bound adds the release of its frame-sized buffers
    # after a Stop in the engine: the request's copy, the decoded matrix and
    # the reply, each one free of up to 2^28 bytes, about 25 ms each on the
    # project machine; the steps' bound is one run of a chunk and a check)
    bound = lambda name: CALL_BOUND_MS if name.startswith("call") else BOUND_MS
    for name, ms in results.items():
        print("   ", name, "worst %.1f ms" % ms, "(bound %d ms)" % bound(name), flush=True)
    for name, ms in results.items():
        if "mutant" in name:
            # (a single copy of the frame is seen past one chunk's bound)
            assert ms > BOUND_MS, "%s: %.1f ms, within %d ms: the measurement can't see a single copy" % (name, ms, BOUND_MS)
        else:
            assert ms <= bound(name), "%s: %.1f ms after the Stop" % (name, ms)
    ok("each step at the frame cap within %d ms of a Stop and the whole call within %d ms; each single-copy mutant past %d ms" % (BOUND_MS, CALL_BOUND_MS, BOUND_MS))


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
    "frame": case_frame, "outcomes": case_outcomes, "kernel": case_kernel, "types": case_types, "kernelmem": case_kernelmem, "mem": case_mem, "cops": case_cops,
    "interrupt": case_interrupt,
}
if CASE == "mem" and not LINUX:
    ok("skipped: no /proc/self/clear_refs (Linux only)")
    sys.exit(0)
CASES[CASE]()
