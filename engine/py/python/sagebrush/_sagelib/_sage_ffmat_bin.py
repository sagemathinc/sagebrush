"""The binary route of GF(p) echelon (engine/web bin_ops.rs nmod_echelon,
SBW1), for lib/_sage_ffmat.py: the host's admission (_ech_need), the
request's packing, the call and the reply's reading.

Imported by _sage_ffmat._ech_bin on the first echelon over a prime field
that may take the route, not with _sage_ffmat: Magma mode imports that
module at its start, and this code needn't be in its heap until then."""

import sys as _sys
from math import isqrt as _isqrt

import _sage_ff as _ff
import _sage_ffmat as _fm


# ---- the binary route (engine/web bin_ops.rs nmod_echelon, SBW1): any
# shape whose request fits the frame cap, admitted from its shape alone by
# _ech_need below before anything is packed; see _ech_bin_route.  No
# frame-sized buffer is ever made or copied in one step: the request goes to
# the engine as a list of pieces of at most _ECH_PIECE bytes, which the
# binding copies with checks for Ctrl-C between runs, and the reply comes
# back as pieces of at most _ECH_REPLY_PIECE bytes, read as runs of words by
# _ech_runs; every step's longest run is a piece.

# bytes of a Python int below 2^63 with its list slot (CPython: the int
# object, at most 36 bytes, and the 8-byte pointer); pyjs measured
# (engine/py/test_ech_bin.py and test/ech-bin.test.ts pin it from above)
_ECH_INT_COST = 96 if _sys.implementation.name == "pyjs" else 44
# a bytes object's fixed cost with its list slot (CPython: 33 + 8)
_ECH_BYTES_COST = 160 if _sys.implementation.name == "pyjs" else 41
# a list's or array's fixed header (L), and the predicate's fixed slack
_ECH_HDR = 64
_ECH_SLACK = 256 * 1024
# the request's pieces and the reply's (the binding's and the runtime's
# BIN_CHUNK, engine/py src/lib.rs and src/runtime/engine.ts)
_ECH_PIECE = 1 << 16
_ECH_REPLY_PIECE = 1 << 20
# the engine's own reservation terms (bin_ops.rs echelon_reservation, at a
# 64-bit usize: CPython's extension); pyjs's engine memory is the wasm
# instance's, outside this budget
_ECH_ENGINE_SLACK = 4096
# the binding's copies of the request in this budget: CPython's extension
# copies the pieces into one owned buffer (engine/py call_bin); pyjs copies
# into the wasm instance's memory, outside the heap
_ECH_BINDING_COPIES = 0 if _sys.implementation.name == "pyjs" else 1
# the engine's reply in this budget while the binding makes its pieces
# (CPython: the extension's buffer; pyjs: the wasm instance's)
_ECH_REPLY_COPIES = 0 if _sys.implementation.name == "pyjs" else 1
# (tests: the frame cap; None: SBW1's, 2^28)
_SBW1_FRAME_CAP = None


def _ech_frame_cap():
    return _SBW1_FRAME_CAP if _SBW1_FRAME_CAP is not None else 1 << 28


def _ech_request_len(r, c):
    """nmod_echelon's request bytes (bin_ops.rs echelon_request_len)."""
    return 100 + 8 * r * c


def _ech_reply_len(r, c, k, want_rows):
    """nmod_echelon's reply bytes for k pivots (bin_ops.rs
    echelon_reply_len)."""
    return 50 + 8 * k + (16 + 8 * r * c if want_rows else 0)


def _ech_engine_reservation(r, c, want_rows):
    """The engine's reservation (bin_ops.rs echelon_reservation, usize 8)."""
    k = min(r, c)
    return 8 * r * c + 32 * c + 16 * k + 8 * 32 + _ech_reply_len(r, c, k, want_rows) + _ECH_ENGINE_SLACK


def _ech_list_cost(n):
    """A list of n slots built by appends (a comprehension): its header and
    its slots at CPython's growth bound, n + n / 8 + 6 rounded up."""
    return _ECH_HDR + 8 * (n + n // 8 + 8)


def _ech_pieces_cost(n_bytes, piece):
    """n_bytes in a list of bytes pieces of at most piece bytes each (and
    up to two short ones): the bytes, each piece's fixed cost, the list."""
    n = -(-n_bytes // piece) + 2
    return n_bytes + n * _ECH_BYTES_COST + _ech_list_cost(n)


def _ech_out_cost(base, r_o, c_o):
    """The bytes of an r_o x c_o result as rows of elements over base: the
    elements (_entry_cost, the contract _admit_size uses), and the outer and
    row lists twice over (the rows built from the reply, then the result's
    constructor's copy of them, FFMatrix and FFVector, which shares the
    elements but not the lists)."""
    lists = _ech_list_cost(r_o) + r_o * _ech_list_cost(c_o)
    return 2 * lists + r_o * c_o * _fm._entry_cost(base)


def _ech_words_cost(n):
    """n words in a list of arrays('Q') of at most _ECH_REPLY_PIECE bytes
    each (_ech_chunked): the words, each array's header and growth, the
    list."""
    per = _ECH_REPLY_PIECE // 8
    k = -(-n // per) + 1
    return 8 * n + k * (_ECH_HDR + _ECH_REPLY_PIECE // 16) + _ech_list_cost(k)


def _ech_need(r, c, want_rows, out, python_only=False):
    """The host's peak for one binary echelon of an r x c matrix whose
    caller builds out bytes of result from the reply, plus the fixed slack:
    the largest of its phases beyond the caller's input,
    - pack: the request's pieces so far, the piece being filled and one
      run of a row (at most a piece's words, as ints and their array);
    - call: the pieces, the binding's copy of them and, in CPython, the
      engine's reservation (its own memory, the process's);
    - return: the pieces (held for the call), the engine's reply and the
      binding's pieces of it;
    - build: the reply's pieces (freed as read), one run's ints, the
      pivots, and the caller's result.
    With python_only, the Python objects' share alone (no engine
    reservation, no binding copy: what tracemalloc sees)."""
    e, k = r * c, min(r, c)
    iota, hdr = _ECH_INT_COST, _ECH_HDR
    q = _ech_request_len(r, c)
    p = _ech_reply_len(r, c, k, want_rows)
    pyjs = _sys.implementation.name == "pyjs"
    engine = 0 if pyjs or python_only else _ech_engine_reservation(r, c, want_rows)
    copies = 0 if python_only else _ECH_BINDING_COPIES
    reply_copies = 0 if python_only else _ECH_REPLY_COPIES
    req = _ech_pieces_cost(q, _ECH_PIECE)
    rep = _ech_pieces_cost(p, _ECH_REPLY_PIECE)
    per = _ECH_PIECE // 8
    run = (iota + 8) * min(c, per) + 8 * min(c, per) + 3 * hdr
    phases = (
        req + _ECH_PIECE + hdr + run,          # pack
        req + copies * q + engine,             # call
        req + reply_copies * p + rep,          # return
        rep + run + iota * k + 2 * hdr + out,  # build
    )
    return max(phases) + _ECH_SLACK


def _ech_bound():
    return (_fm._echelon_transport_figure or _fm._heap_budget)() // _fm._HEAP_SHARE


def _ech_fits(want_rows, out_of, bound):
    """The largest square side n whose binary echelon fits bound (out_of(n):
    its caller's result bytes), by bisection on the monotone need."""
    lo, hi = 0, 1
    while _ech_need(hi, hi, want_rows, out_of(hi)) <= bound and hi < 1 << 20:
        hi *= 2
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if _ech_need(mid, mid, want_rows, out_of(mid)) <= bound:
            lo = mid
        else:
            hi = mid
    return lo


def _ech_refuse(base, r, c, need, bound, want_rows, out_of, what=None):
    """The memory refusal of a binary echelon (a SagebrushMemoryError, never
    retried): its shape, need and bound, and the largest square that fits."""
    import _memguard
    n = _ech_fits(want_rows, out_of, bound)
    e = _memguard.memory_guard(what or ("The echelon form of a %d x %d matrix over %r" % (r, c, base)), need, bound, "one matrix")
    e.fits = n
    # (on the line with the need and the allowance, before the remedies)
    lines = e.args[0].split("\n")
    i = next((j for j, t in enumerate(lines) if "needs about" in t), len(lines) - 1)
    lines[i] += " At most about a %d x %d matrix fits here." % (n, n)
    e.args = ("\n".join(lines),) + e.args[1:]
    return e


def _frame_refuse(what, need, n, noun):
    """The refusal of a request past the frame cap (a fixed-limit
    SagebrushMemoryError: more memory won't help), in place of the loop,
    which past the frame always has at least 2^24 multiply-adds to do (a
    product: r k + k c above 2^25 words; an echelon: r c above 2^25) and so
    would run for minutes to hours: what, its request bytes against the
    cap, and the largest n x n noun whose request fits."""
    import _memguard
    e = _memguard.memory_guard(what, need, _ech_frame_cap(), "one engine request", fixed=True)
    e.fits = n
    lines = e.args[0].split("\n")
    i = next((j for j, t in enumerate(lines) if "needs about" in t), len(lines) - 1)
    lines[i] += " At most about a %d x %d %s fits." % (n, n, noun)
    e.args = ("\n".join(lines),) + e.args[1:]
    return e


def _ech_bin_route(base, r, c, want_rows, out, out_of=None):
    """p when the binary nmod_echelon takes an r x c matrix over base whose
    caller builds out bytes of result: a prime field below 2^63, the
    binary entry point present, the request within the frame cap and the
    host's need (_ech_need) within its budget.  None for another field or
    an engine without the entry point (the callers' other paths, under their
    own admission).  A request past the frame cap raises the fixed limit's
    memory error (_frame_refuse), and a proved memory non-fit the memory
    error (never the Python path)."""
    if not _fm._ECH_BIN_ENABLED or not isinstance(base, _ff.IntegerModRing_) or r < 1 or c < 1:
        return None
    p = _ff._engine_prime(base)
    if not p or not _ff._SBW1_LE:
        return None
    if r >= 1 << 32 or c >= 1 << 32 or _ech_request_len(r, c) > _ech_frame_cap():
        n = _isqrt(max(_ech_frame_cap() - _ech_request_len(0, 0), 0) // 8)
        raise _frame_refuse("The echelon form of a %d x %d matrix over %r" % (r, c, base), _ech_request_len(r, c), n, "matrix")
    need = _ech_need(r, c, want_rows, out)
    bound = _ech_bound()
    if need > bound:
        raise _ech_refuse(base, r, c, need, bound, want_rows, out_of or (lambda n: _ech_out_cost(base, n, n) if want_rows else 0))
    return p


def _ech_pack(rowsrc, r, c, p, flags):
    """The request's pieces: the header, then the words in pieces of at most
    _ECH_PIECE bytes, filled one run of a row at a time (at most a piece's
    entries as ints at once: a long row is never made whole), then the
    flags."""
    import array
    import itertools
    e = r * c
    per = _ECH_PIECE // 8
    pieces = [b"".join([b"SBW1", (12).to_bytes(4, "little"), b"nmod_echelon", (3).to_bytes(4, "little"),
                        _ff._sbw1_u641(array.array("Q", (p,))),
                        (24 + 8 * e).to_bytes(4, "little"), b"MAT1", r.to_bytes(4, "little"), c.to_bytes(4, "little"),
                        b"U641", e.to_bytes(8, "little")])]
    fill = array.array("Q")
    rows = 0
    for row in rowsrc:
        it = iter(row)
        got = 0
        while True:
            run = array.array("Q", [int(x) for x in itertools.islice(it, per - len(fill))])
            if not run:
                break
            got += len(run)
            fill.extend(run)
            del run
            if len(fill) == per:
                pieces.append(fill.tobytes())
                fill = array.array("Q")
        if got != c:
            raise RuntimeError("Sagebrush: a matrix row without %d entries" % c)
        rows += 1
    if rows != r:
        raise RuntimeError("Sagebrush: a matrix without %d rows" % r)
    if fill:
        pieces.append(fill.tobytes())
    del fill
    pieces.append(_ff._sbw1_u641(array.array("Q", (flags,))))
    if sum(len(b) for b in pieces) != _ech_request_len(r, c):
        raise RuntimeError("Sagebrush: an nmod_echelon request of the wrong length")
    return pieces


class _EchReply:
    """The reply's pieces, read in order and freed as read: the small
    fields whole, the rows as runs of whole words, each within one piece
    (a word split between two pieces is joined, eight bytes at most)."""

    def __init__(self, pieces):
        self.pieces = pieces  # (consumed from the front)
        self.at = 0

    def take(self, n):
        """The next n bytes (the header and the small payloads)."""
        out = []
        while n:
            if not self.pieces:
                raise RuntimeError("Sagebrush engine: a truncated nmod_echelon reply")
            b = self.pieces[0]
            k = min(n, len(b) - self.at)
            out.append(b[self.at:self.at + k])
            self.at += k
            n -= k
            if self.at == len(b):
                self.pieces.pop(0)
                self.at = 0
        return b"".join(out)

    def runs(self, n):
        """n words, as memoryviews ('Q') of at most a piece each."""
        while n:
            if not self.pieces:
                raise RuntimeError("Sagebrush engine: a truncated nmod_echelon reply")
            b = self.pieces[0]
            avail = (len(b) - self.at) // 8
            if avail == 0:
                # (a word across two pieces)
                yield memoryview(self.take(8)).cast("Q")
                n -= 1
                continue
            k = min(n, avail)
            yield memoryview(b)[self.at:self.at + 8 * k].cast("Q")
            self.at += 8 * k
            n -= k
            if self.at == len(b):
                self.pieces.pop(0)
                self.at = 0

    def u641(self):
        """A U641 result's length and word count, its words to follow."""
        m = int.from_bytes(self.take(4), "little")
        tag = self.take(4)
        n = int.from_bytes(self.take(8), "little")
        if tag != b"U641" or m != 12 + 8 * n:
            raise RuntimeError("Sagebrush engine: a malformed nmod_echelon reply")
        return n

    def words(self, n):
        return [int(x) for v in self.runs(n) for x in v]

    def done(self):
        if self.pieces and (self.at < len(self.pieces[0]) or len(self.pieces) > 1):
            raise RuntimeError("Sagebrush engine: trailing bytes after an nmod_echelon reply")


def _ech_bin_call(rowsrc, base, r, c, p, want_rows):
    """One binary echelon of the r x c matrix whose rows rowsrc yields (each
    an iterable of c elements over base, or ints in [0, p)): a box [pivots,
    the determinant factor as an int, an _EchReply positioned at the rows or
    None], or None when the engine predates the op (the caller's other
    path).  The caller takes the reply out of the box (box.pop()), so no
    frame of its own keeps it.  The engine's refusals map by code: its
    reservation refused (Cap) is the memory error, a protocol or invariant
    failure RuntimeError, a domain failure ValueError; a Stop is
    KeyboardInterrupt, never retried."""
    pieces = _ech_pack(rowsrc, r, c, p, 3 if want_rows else 0)
    from _sagebrush_lib._engine import call_bin
    try:
        reply = call_bin(pieces)
    except TypeError:
        # (an extension that takes only bytes: the caller's other path)
        return None
    del pieces
    if reply is None:
        return None
    if not isinstance(reply, list):
        raise RuntimeError("Sagebrush engine: an nmod_echelon reply that is not in pieces")
    rd = _EchReply(reply)
    del reply
    head = rd.take(6)
    if head[:4] != b"SBW1":
        raise RuntimeError("Sagebrush engine: a malformed nmod_echelon reply")
    if head[4:] == b"er":
        code = int.from_bytes(rd.take(2), "little")
        rd.take(8)
        text = rd.take(int.from_bytes(rd.take(2), "little")).decode("ascii", "replace")
        if code in (2, 3):
            # (an engine without the op: the caller's other path)
            return None
        if code == 7:
            import _memguard
            raise _memguard.memory_guard("The echelon form of a %d x %d matrix over %r" % (r, c, base),
                                         _ech_engine_reservation(r, c, want_rows), 0, "one matrix",
                                         unmeasured="the engine's memory ledger refused its reservation")
        raise (ValueError if code == 6 else RuntimeError)("Sagebrush engine: nmod_echelon: %s" % text)
    if head[4:] != b"ok" or int.from_bytes(rd.take(4), "little") != (3 if want_rows else 2):
        raise RuntimeError("Sagebrush engine: a malformed nmod_echelon reply")
    piv = rd.words(rd.u641())
    if rd.u641() != 1:
        raise RuntimeError("Sagebrush engine: a malformed nmod_echelon reply")
    d = rd.words(1)[0]
    if not want_rows:
        rd.done()
        return [piv, d, None]
    if rd.u641() != r * c:
        raise RuntimeError("Sagebrush engine: a malformed nmod_echelon reply")
    return [piv, d, rd]


def _ech_row_runs(rd, r, c):
    """(row, first column, words) for every run of the reply's rows, each
    run within one row."""
    for i in range(r):
        j = 0
        for v in rd.runs(c):
            yield i, j, v
            j += len(v)
    rd.done()


def _ech_rows(rd, base, r, c, lo=0, hi=None, want=None):
    """Columns lo..hi of the reply's rows (of those i with want(i), if
    given) as rows of elements over base, read run by run."""
    hi = c if hi is None else hi
    elt = _ff._elt
    out = []
    row = None
    for i, j, v in _ech_row_runs(rd, r, c):
        if j == 0:
            row = [] if want is None or want(i) else None
            if row is not None:
                out.append(row)
        if row is None:
            continue
        a, b = max(lo, j), min(hi, j + len(v))
        if a < b:
            row.extend(elt(base, x) for x in v[a - j:b - j])
    return out


def _ech_chunked():
    """A list of arrays('Q') of at most _ECH_REPLY_PIECE bytes each, filled
    by _ech_append: no array grows past a piece (_ech_words_cost)."""
    import array
    return [array.array("Q")]


def _ech_append(chunks, x):
    if len(chunks[-1]) == _ECH_REPLY_PIECE // 8:
        import array
        chunks.append(array.array("Q"))
    chunks[-1].append(x)


def _ech_word(chunks, i):
    per = _ECH_REPLY_PIECE // 8
    return chunks[i // per][i % per]


def _ech_kernel_need2(base, k, c):
    """The kernel basis's second check, at the rank k known: W (k x (c - k)
    words in chunks), the pivot flags and the pivots, the basis being built
    (c - k rows of c elements) and one basis row's list, through the
    basis's lifetime; plus the fixed slack."""
    nf = c - k
    return (_ech_words_cost(k * nf) + c + _ECH_HDR + _ECH_INT_COST * k + _ech_list_cost(k)
            + _ech_out_cost(base, nf, c) + 8 * c + _ECH_HDR + _ECH_SLACK)


def _ech_kernel_out(r, c):
    """The first kernel call's result bytes: the coefficient block W of k x
    (c - k) words at the worst rank k <= min(r, c) (k (c - k) is concave,
    largest at floor(c / 2), and the next integer checked too), in its
    chunks, and the pivot flags (a bytearray of c)."""
    kap = min(r, c)
    k = min(kap, c // 2)
    w = max(k * (c - k), (k + 1) * (c - k - 1) if k + 1 <= kap else 0)
    return _ech_words_cost(w) + c + _ECH_HDR


# ---- the product's binary route (engine/web bin_ops.rs nmod_mat_mul, SBW1):
# A * B over a prime field below 2^63, taken from the product's shape alone:
# at least _sage_ffmat._MUL_BIN_MIN multiply-adds (below it the Python loop
# is faster), and the host's need (_mul_need) within its budget; a request
# past the frame cap or a proved memory non-fit raises the memory error,
# never the loop.  The pieces, the binding's copies and the reply's reading are the
# echelon's (above).

# the engine's fixed allowance for the fast product's extra words, in
# bytes (bin_ops.rs MAT_MUL_FAST_ALLOWANCE, 2^24 words)
_MUL_FAST_ALLOWANCE = 8 << 24


def _mul_request_len(r, k, c):
    """nmod_mat_mul's request bytes (bin_ops.rs mat_mul_request_len)."""
    return 104 + 8 * (r * k + k * c)


def _mul_reply_len(r, c):
    """nmod_mat_mul's reply bytes (bin_ops.rs mat_mul_reply_len)."""
    return 26 + 8 * r * c


def _mul_batch64(p):
    """How many products of residues mod p a u64 sum holds (nmod_mat.rs
    batch64): 0 for p above 2^32."""
    if p > 1 << 32:
        return 0
    q = (p - 1) * (p - 1)
    return (1 << 64) - 1 if q == 0 else ((1 << 64) - 1) // q


def _mul_engine_reservation(r, k, c, p):
    """An upper bound for the engine's reservation (bin_ops.rs
    mat_mul_reservation): the decoded factors, the classical product's peak
    (nmod_mat.rs classical_peak: the result, and a row's sums or the
    transpose of B), the fast route's extra words at most, where the shape
    may take the fast route (its smallest dimension at least the crossover,
    nmod_mat/fast.rs N0_U64 and N0_U128; else none, exactly): 2 (r k + k c +
    r c) + 8 (r + k + c) + 64 words, at most the fixed allowance (the bound
    engine/web's bin_ops tests check against the plan's own extra words over
    a grid of shapes), the reply and the slack."""
    b64 = _mul_batch64(p)
    classical = r * c + (k * c if k > b64 else c)
    n0 = 384 if b64 > 0 else 64
    extra = 8 * (2 * (r * k + k * c + r * c) + 8 * (r + k + c) + 64)
    fast = min(_MUL_FAST_ALLOWANCE, extra) if min(r, k, c) >= n0 else 0
    return 8 * (r * k + k * c) + 8 * classical + fast + _mul_reply_len(r, c) + _ECH_ENGINE_SLACK


def _mul_need(r, k, c, p, out, python_only=False):
    """The host's peak for one binary product of an r x k and a k x c
    matrix whose result takes out bytes, plus the fixed slack: the largest
    of its phases (the echelon's, _ech_need), with both factors packed."""
    iota, hdr = _ECH_INT_COST, _ECH_HDR
    q = _mul_request_len(r, k, c)
    rp = _mul_reply_len(r, c)
    pyjs = _sys.implementation.name == "pyjs"
    engine = 0 if pyjs or python_only else _mul_engine_reservation(r, k, c, p)
    copies = 0 if python_only else _ECH_BINDING_COPIES
    reply_copies = 0 if python_only else _ECH_REPLY_COPIES
    req = _ech_pieces_cost(q, _ECH_PIECE)
    rep = _ech_pieces_cost(rp, _ECH_REPLY_PIECE)
    per = _ECH_PIECE // 8
    # (pack: the ints of the piece being filled, across rows, at most a
    # piece's words or a factor's, their list and the array made of them;
    # build: the ints of one run of the reply's words, as they are read)
    w = min(max(r * k, k * c), per)
    run = (iota + 8) * w + 8 * w + 3 * hdr
    # (each row of A, of B and of the result: an iterator or a list header
    # and its slot, in every phase)
    rows = (2 * r + k) * (hdr + 8)
    # (pyjs reclaims an object only when V8 collects, not when its last
    # reference goes: the packer's array per piece (8 bytes a word of both
    # factors) and its iterator per row may all still be resident in every
    # later phase; CPython frees each when its last reference goes.  The
    # entries' ints are the elements' own (int(x) is x._v), and the reply's
    # words become the result's elements, counted in out)
    late = 8 * (r * k + k * c) + hdr * (r + k) if pyjs and not python_only else 0
    phases = (
        req + _ECH_PIECE + hdr + run + rows + late,          # pack
        req + copies * q + engine + late,                    # call
        req + reply_copies * rp + rep + late,                # return
        rep + run + rows + 4 * hdr + out + late,             # build
    )
    return max(phases) + _ECH_SLACK


def _mul_fits(base, p, bound):
    """The largest n whose n x n binary product fits bound, by bisection
    on the monotone need."""
    def need(n):
        return _mul_need(n, n, n, p, _ech_out_cost(base, n, n))
    lo, hi = 0, 1
    while need(hi) <= bound and hi < 1 << 20:
        hi *= 2
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if need(mid) <= bound:
            lo = mid
        else:
            hi = mid
    return lo


def _mul_bin_route(base, r, k, c):
    """p when the binary nmod_mat_mul takes the product of an r x k and a
    k x c matrix over base: a prime field below 2^63, the binary entry point
    present, at least _sage_ffmat._MUL_BIN_MIN multiply-adds, the request
    within the frame cap and the host's need (_mul_need) within its budget.
    None for another field, an engine without the entry point or a product
    below the threshold (the loop, under its own admission).  A request past
    the frame cap raises the fixed limit's memory error (_frame_refuse), and
    a proved memory non-fit the memory error (never the loop)."""
    if not _fm._MUL_BIN_ENABLED or not isinstance(base, _ff.IntegerModRing_) or min(r, k, c) < 1:
        return None
    if r * k * c < _fm._MUL_BIN_MIN:
        return None
    p = _ff._engine_prime(base)
    if not p or not _ff._SBW1_LE:
        return None
    if max(r, k, c) >= 1 << 32 or _mul_request_len(r, k, c) > _ech_frame_cap():
        n = _isqrt(max(_ech_frame_cap() - _mul_request_len(0, 0, 0), 0) // 16)
        raise _frame_refuse("The product of a %d x %d and a %d x %d matrix over %r" % (r, k, k, c, base), _mul_request_len(r, k, c), n, "product")
    need = _mul_need(r, k, c, p, _ech_out_cost(base, r, c))
    bound = _ech_bound()
    if need > bound:
        import _memguard
        n = _mul_fits(base, p, bound)
        e = _memguard.memory_guard("The product of a %d x %d and a %d x %d matrix over %r" % (r, k, k, c, base), need, bound, "one matrix")
        e.fits = n
        lines = e.args[0].split("\n")
        i = next((j for j, t in enumerate(lines) if "needs about" in t), len(lines) - 1)
        lines[i] += " At most about an %d x %d product fits here." % (n, n)
        e.args = ("\n".join(lines),) + e.args[1:]
        raise e
    return p


def _mul_fill(pieces, buf, rowsrc, r, c):
    """The words of rowsrc's r rows of c entries each into pieces of exactly
    _ECH_PIECE bytes (the last one shorter, returned unfilled): the entries
    as ints in buf, a list of at most a piece's words across rows, made into
    an array once per piece (an array per row costs more than the row in
    pyjs)."""
    import array
    import itertools
    per = _ECH_PIECE // 8
    rows = 0
    for row in rowsrc:
        if type(row) is list and len(row) == c and c <= per - len(buf):
            # (a matrix's own row that fits the piece: no run list, no map
            # object; each is garbage per row, which pyjs reclaims late)
            for x in row:
                buf.append(int(x))
            if len(buf) == per:
                pieces.append(array.array("Q", buf).tobytes())
                del buf[:]
            rows += 1
            continue
        it = iter(row)
        got = 0
        while True:
            room = per - len(buf)
            run = [int(x) for x in itertools.islice(it, room)]
            got += len(run)
            buf.extend(run)
            del run
            if len(buf) == per:
                pieces.append(array.array("Q", buf).tobytes())
                del buf[:]
                continue
            break
        if got != c:
            raise RuntimeError("Sagebrush: a matrix row without %d entries" % c)
        rows += 1
    if rows != r:
        raise RuntimeError("Sagebrush: a matrix without %d rows" % r)
    return buf


def _mul_pack(arows, brows, r, k, c, p):
    """The request's pieces: the header and A's argument header, A's words,
    B's argument header, B's words; no piece longer than _ECH_PIECE."""
    import array

    def mat_head(rows, cols):
        return b"".join([(24 + 8 * rows * cols).to_bytes(4, "little"), b"MAT1", rows.to_bytes(4, "little"),
                         cols.to_bytes(4, "little"), b"U641", (rows * cols).to_bytes(8, "little")])
    pieces = [b"".join([b"SBW1", (12).to_bytes(4, "little"), b"nmod_mat_mul", (3).to_bytes(4, "little"),
                        _ff._sbw1_u641(array.array("Q", (p,))), mat_head(r, k)])]
    buf = _mul_fill(pieces, [], arows, r, k)
    if buf:
        pieces.append(array.array("Q", buf).tobytes())
    pieces.append(mat_head(k, c))
    buf = _mul_fill(pieces, [], brows, k, c)
    if buf:
        pieces.append(array.array("Q", buf).tobytes())
    del buf
    if sum(len(b) for b in pieces) != _mul_request_len(r, k, c):
        raise RuntimeError("Sagebrush: an nmod_mat_mul request of the wrong length")
    return pieces


def _mul_bin_call(arows, brows, base, r, k, c, p):
    """The product's rows (lists of elements over base) by the binary
    nmod_mat_mul, or None when the engine predates the op (the loop).  The
    engine's refusals map by code, as the echelon's: its reservation
    refused (Cap) is the memory error, a domain failure ValueError, a
    protocol or invariant failure RuntimeError; a Stop is
    KeyboardInterrupt, never retried."""
    pieces = _mul_pack(arows, brows, r, k, c, p)
    from _sagebrush_lib._engine import call_bin
    try:
        reply = call_bin(pieces)
    except TypeError:
        return None
    del pieces
    if reply is None:
        return None
    if not isinstance(reply, list):
        raise RuntimeError("Sagebrush engine: an nmod_mat_mul reply that is not in pieces")
    rd = _EchReply(reply)
    del reply
    head = rd.take(6)
    if head[:4] != b"SBW1":
        raise RuntimeError("Sagebrush engine: a malformed nmod_mat_mul reply")
    if head[4:] == b"er":
        code = int.from_bytes(rd.take(2), "little")
        rd.take(8)
        text = rd.take(int.from_bytes(rd.take(2), "little")).decode("ascii", "replace")
        if code in (2, 3):
            return None
        if code == 7:
            import _memguard
            raise _memguard.memory_guard("The product of a %d x %d and a %d x %d matrix over %r" % (r, k, k, c, base),
                                         _mul_engine_reservation(r, k, c, p), 0, "one matrix",
                                         unmeasured="the engine's memory ledger refused its reservation")
        raise (ValueError if code == 6 else RuntimeError)("Sagebrush engine: nmod_mat_mul: %s" % text)
    if head[4:] != b"ok" or int.from_bytes(rd.take(4), "little") != 1:
        raise RuntimeError("Sagebrush engine: a malformed nmod_mat_mul reply")
    if rd.u641() != r * c:
        raise RuntimeError("Sagebrush engine: a malformed nmod_mat_mul reply")
    return _mul_rows(rd, base, r, c)


def _mul_rows(rd, base, r, c):
    """The product's r rows of c elements over base from the reply, read a
    run of words at a time and appended to the row being built: one reader
    for all the rows (a reader per row costs more than a short row in pyjs),
    and no list or slice per run or per row besides the rows themselves."""
    elt = _ff._elt
    out = []
    row = []
    n = 0
    for v in rd.runs(r * c):
        for x in v:
            row.append(elt(base, x))
            n += 1
            if n == c:
                out.append(row)
                row = []
                n = 0
    rd.done()
    if len(out) != r or row:
        raise RuntimeError("Sagebrush engine: a malformed nmod_mat_mul reply")
    return out
