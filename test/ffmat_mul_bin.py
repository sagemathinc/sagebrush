"""GF(p) matrix products on the binary route (engine/web bin_ops.rs
nmod_mat_mul), the cases shared by both runtimes:
test/ffmat-mul-bin.test.ts runs them in pyjs (build/cli/pyjs.cjs --sage
THIS CASE) and engine/py/test_mul_bin.py in CPython (python3 THIS CASE).
Each case prints "ok CASE ..." lines and raises on a failure.

    lazy       the binary route's module is imported on demand: not by a
               product below the threshold, then by the first one at it
    correct    the binary route against the loop, exactly: p in {2, 3,
               65537, 2^31 - 1, 2^62 - 57-ish 63-bit}, square, non-square,
               thin, entries p - 1; zero dimensions stay on the loop
    threshold  r k c = _MUL_BIN_MIN - 1 keeps the loop, _MUL_BIN_MIN takes
               the route, at thin and square shapes
    frame      a frame-only non-fit (the frame cap hook) keeps the loop
               under its own admission
    preflight  the host's need at need and need - 1 (the figure hook): the
               route, or the memory error with what fits, never the loop
    outcomes   the engine's replies by code: the reservation refused is the
               memory error, called once; an engine without the op falls
               back to the loop; protocol and invariant failures are
               RuntimeError; a KeyboardInterrupt propagates, called once
    fields     a product over a non-prime field keeps its own path; two
               different prime fields are Sage's TypeError, before any call
    mem        the measured peaks (Linux) within the predicate's need, at
               thin shapes both ways and square ones
    oracle     products against Magma 2.18-5's (black box): a checksum of
               each result, at shapes on both kernels, classical and fast
"""
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

import random as _random  # (after the star import, which has its own random)

import _sage_ffmat as FM
import _memguard
import sagebrush._engine as EN

CASE = sys.argv[1]
P63 = 9223372036854775783
T = FM._MUL_BIN_MIN


def ok(*a):
    print("ok", CASE, *a, flush=True)


def rand_matrix(F, r, c, seed=1, big=False):
    g = _random.Random(seed)
    p = int(F.order())
    if big:
        return matrix(F, r, c, [p - 1 - g.randrange(min(p, 1000)) for _ in range(r * c)])
    return matrix(F, r, c, [g.randrange(p) for _ in range(r * c)])


def case_lazy():
    gone = lambda: "_sage_ffmat_bin" not in sys.modules
    assert gone(), "imported with _sage_ffmat"
    F = GF(65537)
    A, B = rand_matrix(F, 5, 5, 1), rand_matrix(F, 5, 5, 2)
    assert 5 * 5 * 5 < T
    A * B
    assert gone(), "imported by a product below the threshold"
    A, B = rand_matrix(F, 8, 8, 3), rand_matrix(F, 8, 8, 4)
    assert 8 * 8 * 8 >= T
    A * B
    assert not gone(), "not imported by the first product at the threshold"
    ok("imported by the first GF(p) product at the threshold only")


if CASE == "lazy":
    case_lazy()
    sys.exit(0)

import _sage_ffmat_bin as FB  # noqa: E402

CALLS = []  # (r, k, c) of each binary call
_bin_call = FB._mul_bin_call


def _counting_call(arows, brows, base, r, k, c, p):
    CALLS.append((r, k, c))
    return _bin_call(arows, brows, base, r, k, c, p)


FB._mul_bin_call = _counting_call


def calls(f):
    """(f's value, the shapes it sent to the binary op)."""
    del CALLS[:]
    v = f()
    return v, list(CALLS)


def loop(f):
    """f with the binary route off (the loop)."""
    FM._MUL_BIN_ENABLED = False
    try:
        return f()
    finally:
        FM._MUL_BIN_ENABLED = True


def with_figure(fig, f):
    FM._echelon_transport_figure = (lambda: fig) if fig is not None else None
    try:
        return f()
    finally:
        FM._echelon_transport_figure = None


def case_correct():
    shapes = [(8, 8, 8), (5, 7, 9), (9, 7, 5), (1, 300, 1), (300, 1, 1), (1, 1, 300), (16, 1, 16), (33, 2, 40), (20, 31, 17)]
    n = 0
    for p in [2, 3, 65537, 2147483647, P63]:
        F = GF(p)
        for i, (r, k, c) in enumerate(shapes):
            for big in (False, True):
                A, B = rand_matrix(F, r, k, 10 * i + 1, big), rand_matrix(F, k, c, 10 * i + 2, big)
                want = loop(lambda: A * B)
                got, s = calls(lambda: A * B)
                assert s == [(r, k, c)], (p, r, k, c, s)
                assert got == want and got.parent() == want.parent(), (p, r, k, c, big)
                n += 1
    # zero dimensions: the loop's own answer, no call
    F = GF(65537)
    for r, k, c in [(0, 5, 7), (5, 0, 7), (5, 7, 0), (0, 0, 0)]:
        A, B = matrix(F, r, k), matrix(F, k, c)
        got, s = calls(lambda: A * B)
        assert s == [] and (got.nrows(), got.ncols()) == (r, c) and all(x == 0 for row in got.rows() for x in row), (r, k, c)
    ok(n, "products equal to the loop's, each one binary call; zero dimensions on the loop")


def case_threshold():
    F = GF(65537)
    for below, at in [((T - 1, 1, 1), (T, 1, 1)), ((1, T - 1, 1), (1, T, 1)), ((1, 1, T - 1), (1, 1, T))]:
        for (r, k, c), routed in [(below, False), (at, True)]:
            A, B = rand_matrix(F, r, k, 5), rand_matrix(F, k, c, 6)
            want = loop(lambda: A * B)
            got, s = calls(lambda: A * B)
            assert got == want and s == ([(r, k, c)] if routed else []), (r, k, c, s)
    # (and square: T = 256 is not a cube; 6^3 = 216 below, 7^3 = 343 at or past it)
    for n, routed in [(6, 6 ** 3 >= T), (7, 7 ** 3 >= T)]:
        A, B = rand_matrix(F, n, n, 7), rand_matrix(F, n, n, 8)
        got, s = calls(lambda: A * B)
        assert got == loop(lambda: A * B) and s == ([(n, n, n)] if routed else []), (n, s)
    ok("T", T, "r k c = T - 1 on the loop, T on the binary route (thin both ways and square)")


def case_frame():
    F = GF(32003)
    r, k, c = 40, 30, 20
    A, B = rand_matrix(F, r, k, 41), rand_matrix(F, k, c, 42)
    q = FB._mul_request_len(r, k, c)
    want = loop(lambda: A * B)
    FB._SBW1_FRAME_CAP = q
    try:
        assert calls(lambda: A * B) == (want, [(r, k, c)])
        FB._SBW1_FRAME_CAP = q - 1
        assert calls(lambda: A * B) == (want, []), "a frame-only non-fit keeps the loop"
    finally:
        FB._SBW1_FRAME_CAP = None
    ok("Q", q, "binary at the frame cap, the loop one byte past it")


def case_preflight():
    F = GF(32003)
    p = 32003
    for r, k, c in [(30, 40, 50), (1, 400, 1), (64, 1, 64)]:
        A, B = rand_matrix(F, r, k, 51), rand_matrix(F, k, c, 52)
        n = FB._mul_need(r, k, c, p, FB._ech_out_cost(F, r, c))
        want = loop(lambda: A * B)
        v, s = with_figure(FM._HEAP_SHARE * n, lambda: calls(lambda: A * B))
        assert s == [(r, k, c)] and v == want, (r, k, c, s)
        try:
            with_figure(FM._HEAP_SHARE * n - 1, lambda: calls(lambda: A * B))
            raise AssertionError("%dx%dx%d: admitted one byte short" % (r, k, c))
        except _memguard.SagebrushMemoryError as e:
            assert CALLS == [], (r, k, c, CALLS)
            assert e.need_bytes == n and e.limit_bytes == n - 1, (e.need_bytes, e.limit_bytes)
            assert "%d x %d" % (r, k) in str(e) and "At most about" in str(e) and e.fits >= 0, str(e)
            assert FB._mul_need(e.fits, e.fits, e.fits, p, FB._ech_out_cost(F, e.fits, e.fits)) <= n - 1
        ok("%dx%dx%d" % (r, k, c), "need", n, "routed at need, the memory error at need - 1 (no call, no loop)")


def er(code, text=b"x"):
    return b"SBW1er" + code.to_bytes(2, "little") + (0).to_bytes(8, "little") + len(text).to_bytes(2, "little") + text


def case_outcomes():
    F = GF(32003)
    A, B = rand_matrix(F, 12, 13, 61), rand_matrix(F, 13, 14, 62)
    want = loop(lambda: A * B)
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
            ("a malformed reply", b"SBW1ok" + (2).to_bytes(4, "little"), RuntimeError),
        ]:
            n[0] = 0
            EN.call_bin = fake(reply)
            try:
                A * B
                raise AssertionError(label + ": no error")
            except expect:
                pass
            assert n[0] == 1, (label, "called", n[0])
        for label, reply in [("Header", er(2)), ("Op", er(3)), ("no entry point", None), ("a bytes-only binding", TypeError("takes bytes"))]:
            n[0] = 0
            EN.call_bin = fake(reply)
            assert A * B == want and n[0] == 1, (label, n[0])
    finally:
        EN.call_bin = real
    ok("Cap: the memory error; Frame/Count/Schema/Internal and a malformed reply: RuntimeError; Domain: ValueError;"
       " a KeyboardInterrupt propagates; each called once; Header/Op/None/a bytes-only binding: the loop")


def case_fields():
    # a non-prime field: its own path, no call
    K = GF(9, "a")
    A = matrix(K, 8, 8, [K.gen() ** (i % 7) for i in range(64)])
    got, s = calls(lambda: A * A)
    assert s == [] and got == loop(lambda: A * A)
    # matrices over two different prime fields: Sage's TypeError, before any call
    B = rand_matrix(GF(101), 9, 9, 71)
    C = rand_matrix(GF(103), 9, 9, 72)
    try:
        calls(lambda: B * C)
        raise AssertionError("GF(101) * GF(103): no error")
    except TypeError:
        assert CALLS == []
    ok("GF(9): its own path, no call; GF(101) * GF(103): TypeError, no call")


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
    engine's, the extension's own memory) within the need's Python share
    (_mul_need python_only), and at least the result's slots; and VmHWM -
    VmRSS of the first run within need.  pyjs: VmHWM - VmRSS of the first
    run within need plus the wasm instance's reservation (outside the heap,
    but resident)."""
    PYJS = hasattr(sys, "_sagebrush_heap_used")
    p = P63
    F = GF(p)
    for r, k, c in [(1, 1 << 16, 1), (1 << 16, 1, 1), (1, 1, 1 << 16), (256, 256, 256), (700, 700, 700)]:
        A, B = rand_matrix(F, r, k, 81, big=True), rand_matrix(F, k, c, 82, big=True)
        n = FB._mul_need(r, k, c, p, FB._ech_out_cost(F, r, c))
        engine = FB._mul_engine_reservation(r, k, c, p)
        with Peak() as h:
            v, s = calls(lambda: A * B)
        assert s == [(r, k, c)], s
        del v
        extra = ""
        if not PYJS:
            import tracemalloc
            tracemalloc.start()
            tracemalloc.reset_peak()
            v = A * B
            traced = tracemalloc.get_traced_memory()[1]
            tracemalloc.stop()
            del v
            py = FB._mul_need(r, k, c, p, FB._ech_out_cost(F, r, c), python_only=True)
            extra = " traced %d (%.2f of the Python share %d)" % (traced, traced / py, py)
            assert 8 * r * c <= traced <= py, ((r, k, c), traced, py)
        print("    %dx%dx%d VmHWM-VmRSS %d need %d (%.2f)%s" % (r, k, c, h.hwm, n, h.hwm / n, extra), flush=True)
        bound = n + (engine if PYJS else 0)
        assert h.hwm <= bound, ((r, k, c), h.hwm, bound)
        del A, B
    ok("the measured peaks within the predicate's need")


def lcg_matrices(p, r, k, c):
    """A then B, row-major, from the LCG x <- (x a + b) mod 2^64 seeded at
    1, each entry x's top bits (x >> 33) reduced mod p (the oracle's)."""
    a, b, x = 6364136223846793005, 1442695040888963407, 1
    out = []
    for n in (r * k, k * c):
        e = []
        for _ in range(n):
            x = (x * a + b) % (1 << 64)
            e.append((x >> 33) % p)
        out.append(e)
    F = GF(p)
    return matrix(F, r, k, out[0]), matrix(F, k, c, out[1])


# Magma 2.18-5 (black box, magma -b), Nov 25 2026: (p, r, k, c, S) with
# S = sum over (i, j) of C[i, j] (an integer in [0, p)) * (i c + j + 1)
# mod 2^61 - 1, 0-based, C = A * B for lcg_matrices(p, r, k, c)
ORACLE = [
    (2, 17, 23, 19, 24587),
    (65537, 17, 23, 19, 1753870295),
    (2147483647, 17, 23, 19, 56503152676174),
    (9223372036854775783, 17, 23, 19, 905109714128851657),
    (65537, 1, 300, 1, 16569),
    (65537, 300, 1, 300, 133017994597401),
    (2147483647, 9, 1, 40, 65660074261585),
    (65537, 400, 400, 400, 419611999258263),
    (9223372036854775783, 140, 140, 140, 233625927710510518),
    (2, 129, 64, 130, 70326704),
]


def case_oracle():
    M = (1 << 61) - 1
    for p, r, k, c, want in ORACLE:
        A, B = lcg_matrices(p, r, k, c)
        C, s = calls(lambda: A * B)
        assert s == [(r, k, c)], (p, r, k, c, s)
        S = 0
        for i, row in enumerate(C.rows()):
            for j, x in enumerate(row):
                S = (S + int(x) * (i * c + j + 1)) % M
        assert S == want, (p, r, k, c, S, want)
    ok(len(ORACLE), "products equal to Magma's (checksums), each one binary call (400^3 at 65537 and 140^3 at"
       " the 63-bit prime are shapes the engine takes on the fast route: engine/web tests/bin_mat_mul_alloc.rs)")


{
    "correct": case_correct,
    "threshold": case_threshold,
    "frame": case_frame,
    "preflight": case_preflight,
    "outcomes": case_outcomes,
    "fields": case_fields,
    "oracle": case_oracle,
    "mem": case_mem,
}[CASE]()
