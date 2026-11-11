"""Sprig's memory discipline (design/sprig-mvp.md §8.4): size first, reserve, then release.

Every allocation Sprig makes on a person's behalf computes its size in
Python integers before anything is allocated, and reserves the operation's
peak live storage against the session's allowance: the parse of a program
(its tokens and tree), the evaluator's continuation stack as it grows,
the printers' text, and the numeric intermediates of exact arithmetic.
A reservation is released when its block ends, however it ends, so a
refusal or Stop gives it back.  The allowance is the memory this host can
observe free now (lib/_capacity.py), less the reservations open in the
session; where no figure can be observed, a fixed cap per operation
applies, and the refusal says so.

A refusal is lib/_memguard.py's SagebrushMemoryError; Sprig shows it as
General::memory (design §5.6).
"""

import _memguard

# while the session's open reservations, this one included, stay below this, an operation is admitted without reading
# the host's memory (reading it costs more than the allocation); past it, every reservation is checked against the
# live figure, so many small reservations held at once (a deep continuation stack's chunks) are checked as their sum
SMALL_BYTES = 1 << 20
# the cap on everything open at once where the host's memory can't be observed (no capacity figure)
UNMEASURED_OPERATION_BYTES = 1 << 28

# The host's bytes per unit, for reservations, measured on the CLI's engine (Node 24.21.0) as the peak resident growth
# over a bare start (203 MB) of 10^6 units (the S1.1 PR's measurement, rounded up):
# a parsed program's tokens and tree, per character of source (396 B nested f[f[...]], 297 B a wide list)
PARSE_BYTES_PER_CHAR = 400
# an expression node (an Expr with its argument tuple and an atom: 336 B)
NODE_BYTES = 352
# one frame of the evaluator's continuation stack (211 B)
KONT_BYTES = 224
# the printers' pieces and text, per unit of the printed expression's size (Expr.size: 281 B)
FORMAT_BYTES_PER_NODE = 288
# a symbol a session makes, and per character of its name (10^6 names of 8 characters: 232 B each; 2 * 10^5 of 1,000:
# 1,675 B each)
SYM_BYTES = 240
SYM_BYTES_PER_CHAR = 2
# the session's names are charged in reservations of this many bytes
NAME_CHUNK = 64 << 10
# what an evaluation, a match or a rewrite retains besides expressions (peak resident growth for 10^6 of each on the
# CLI's engine, rounded up):
# a reference in a list (39.5 B appended)
SLOT_BYTES = 40
# a matcher's goal and its link in the goal list (245 B)
GOAL_BYTES = 256
# a pattern's binding, keyed by its name, in the bindings or a copy of them (390 B)
BIND_BYTES = 400
# a walk's stack entry, a pair and its slot (144 B)
WALK_BYTES = 160
# a holder's charge (Held) is reserved in chunks of at least this many bytes
HELD_CHUNK = 64 << 10
# an exact integer's computation, per bit of its result (3^(10^7), 15.9 Mbit: 41 MB, 2.6 B per bit; 3^(10^8): 1.04)
INT_BYTES_PER_BIT = 3

_open = [0]     # the bytes reserved by operations still running in this session


def _allowance():
    """(bytes, unmeasured reason or None) available to a new reservation now (the memory figure's module is
    imported on the first reservation above SMALL_BYTES, never at Sprig's start)."""
    import _capacity
    rec = _capacity.capacity()
    g = _capacity.effective_guard_bytes(rec)
    if g is None:
        return None, "no memory figure"
    return max(0, int(g) - _open[0]), None


class SprigMemoryError(_memguard.SagebrushMemoryError):
    """A refusal of Sprig's ledger: _memguard's error, with the function the person called (sprig_name)."""


def _refusal(e, name):
    r = SprigMemoryError(str(e), e.what, e.need_bytes, e.limit_bytes, e.allowance_for, fixed=e.fixed,
                         unmeasured=e.unmeasured)
    r.sprig_name = name
    return r


def _admit(need, what, name):
    """Add need bytes to the session's open reservations, or refuse them (what: the subject, or a function giving it,
    made only for a refusal)."""
    if _open[0] + need > SMALL_BYTES:
        avail, unmeasured = _allowance()
        if unmeasured is not None:
            # (with no figure, the fixed cap bounds everything open at once, this reservation included: retained
            # definitions and a deep stack's chunks are each below it, together they aren't)
            if _open[0] + need > UNMEASURED_OPERATION_BYTES:
                left = max(0, UNMEASURED_OPERATION_BYTES - _open[0])
                raise _refusal(_memguard.memory_guard(_subject(what), need, left, "one operation",
                                                      fixed=True, unmeasured=unmeasured), name)
        elif need > avail:
            raise _refusal(_memguard.memory_guard(_subject(what), need, avail, "one operation"), name)
    _open[0] += need


def _subject(what):
    """what, made only for a refusal: a text, a function giving it, or (a function, its arguments)."""
    if type(what) is tuple:
        return what[0](*what[1:])
    return what() if callable(what) else what


class Reservation:
    """`with reserve(nbytes, what, name):` reserves nbytes for the block and gives them back when it ends.
    name is the function the person called, for General::memory."""

    def __init__(self, nbytes, what, name):
        self.nbytes = max(0, int(nbytes))
        self.what = what
        self.name = name
        self.held = False

    def acquire(self):
        _admit(self.nbytes, self.what, self.name)
        self.held = True
        return self

    def release(self):
        if self.held:
            _open[0] -= self.nbytes
            self.held = False

    def __enter__(self):
        return self.acquire()

    def __exit__(self, *exc):
        self.release()
        return False


def reserve(nbytes, what, name):
    return Reservation(nbytes, what, name)


# the running evaluation's own holder: a holder made while it runs is a part of it (Held's docstring)
_pool = [None]


class Held:
    """What a holder retains, charged as it grows (§8.4): grow(n) before the holder builds n more bytes it keeps,
    shrink(n) once it has dropped n, release() at its end, however it ends.  take(other) moves another holder's charge
    into this one and move(other, n) part of this one's into another, without changing what is open: a value changes
    hands with its charge, never given back and reserved again.  A holder with a chunk reserves at least that many
    bytes at a time (the ledger is consulted once per chunk, not per node) and gives back what it no longer needs past
    two chunks and a quarter of what it has, keeping an eighth; what is reserved is never less than what is covered.

    A holder made while an evaluation runs is a part of the evaluation's own holder (_pool): it keeps its own count,
    but its bytes are reserved and given back through the evaluation's, so a match's or a substitution's growth is
    admitted only when the evaluation's reservation runs out, not at each new holder's first byte (above SMALL_BYTES,
    every admission reads the host's memory figure)."""
    # (no __slots__: the engine reads and writes a plain instance's attributes far faster than slots, and the
    # evaluator touches its holder at every step)

    def __init__(self, what, name, chunk=0):
        self.used = 0
        self.reserved = 0
        self.chunk = chunk
        self.what = what
        self.name = name
        self.floor = 0              # what prereserve() set aside, never given back before release()
        self.trim = 2 * chunk       # reserved past this (and the floor) is worth a shrink's look
        self.parent = _pool[0]      # the evaluation's holder this is a part of, or None

    def grow(self, n, what=None, name=None):
        if self.parent is not None:
            self.parent._grow(n, what or self.what, name or self.name)
            self.used += n
            self.reserved += n
            return
        self._grow(n, what, name)

    def _grow(self, n, what=None, name=None):
        u = self.used + n
        if u > self.reserved:
            # (a chunked holder grows by an eighth of what it has at least, so a large one consults the ledger a
            # logarithmic number of times)
            more = max(u - self.reserved, self.chunk, self.reserved >> 3 if self.chunk else 0)
            _admit(more, what or self.what, name or self.name)
            self.reserved += more
        self.used = u

    def prereserve(self, n, what=None):
        """Reserve n bytes ahead of what the holder covers (its first chunk, of a size of its own), kept until
        release()."""
        _admit(n, what or self.what, self.name)
        self.reserved += n
        self.floor += n
        self.trim = self.floor + 2 * self.chunk

    def shrink(self, n):
        if self.parent is not None:
            self.used -= n
            self.reserved -= n
            self.parent.shrink(n)
            return
        self.used -= n
        keep = max(self.used + max(self.chunk, self.used >> 3), self.floor)
        spare = self.reserved - keep
        if spare > self.chunk and spare > self.reserved >> 2:
            self.reserved -= spare
            _open[0] -= spare

    def take(self, other):
        n = other.used
        rs, ro = self.parent or self, other.parent or other
        if rs is not ro:
            if other.parent is not None:
                ro._move(rs, n)
            else:
                # (a holder of its own: all it reserved, with its slack, goes to this one's root)
                rs.used += other.used
                rs.reserved += other.reserved
        if self.parent is not None:
            self.used += n
            self.reserved += n
        other.used = other.reserved = 0

    def move(self, other, n):
        rs, ro = self.parent or self, other.parent or other
        if rs is not ro:
            rs._move(ro, n)
        if self.parent is not None:
            self.used -= n
            self.reserved -= n
        if other.parent is not None:
            other.used += n
            other.reserved += n

    def _move(self, other, n):
        # (between two roots: n bytes, covered and reserved, from this one's to the other's)
        self.used -= n
        self.reserved -= n
        other.used += n
        other.reserved += n

    def release(self):
        if self.parent is not None:
            n, self.used, self.reserved = self.used, 0, 0
            self.parent.shrink(n)
            return
        # (one statement: the ledger and the holder change together, so a release is never half done)
        _open[0], self.used, self.reserved = _open[0] - self.reserved, 0, 0


# The hand-offs between a value's maker and its next holder: a builtin's result (or a generator's request) is left in
# `made` by produce() or a generator's take; the evaluator moves it to the frame or the value in flight.  A value the
# evaluator gives a generator is in `received` while the generator runs; the generator keeps it (receive()) or drops
# it (drop_received()), and what it leaves stays with its frame.
made = Held("A result", "Evaluation")
received = Held("A result", "Evaluation")


class produce:
    """`with produce(nbytes, what, name):` reserves nbytes before the block builds a result, and when the block ends
    normally moves the charge to `made`, for the result's next holder; a refusal or Stop gives it back."""

    def __init__(self, nbytes, what, name):
        self.r = Held(what, name)
        self.n = max(0, int(nbytes))

    def __enter__(self):
        self.r.grow(self.n)
        return self.r

    def __exit__(self, t, *exc):
        if t is None:
            made.take(self.r)
        else:
            self.r.release()
        return False


def receive(name):
    """The value just given to a generator, its charge moved to a holder of the generator's own."""
    h = Held("A result", name)
    h.take(received)
    return h


def drop_received():
    """The generator no longer refers to the value it was given (it compared it, or replaced it)."""
    received.release()


def count(n, noun, plural=None):
    """n and its noun, in the singular for one: "1 node", "2 nodes" (a refusal's subject)."""
    return "%d %s" % (n, noun if n == 1 else (plural or noun + "s"))


def int_bytes(bits):
    """The bytes of computing an exact integer of this many bits."""
    return 64 + bits * INT_BYTES_PER_BIT


def open_bytes():
    """The bytes reserved by operations still running (0 between statements; the pins check it)."""
    return _open[0]
