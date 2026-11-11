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


class Reservation:
    """`with reserve(nbytes, what, name):` reserves nbytes for the block and gives them back when it ends.
    name is the function the person called, for General::memory."""

    def __init__(self, nbytes, what, name):
        self.nbytes = max(0, int(nbytes))
        self.what = what
        self.name = name
        self.held = False

    def acquire(self):
        need = self.nbytes
        if _open[0] + need > SMALL_BYTES:
            avail, unmeasured = _allowance()
            if unmeasured is not None:
                # (with no figure, the fixed cap bounds everything open at once, this reservation included: retained
                # definitions and a deep stack's chunks are each below it, together they aren't)
                if _open[0] + need > UNMEASURED_OPERATION_BYTES:
                    left = max(0, UNMEASURED_OPERATION_BYTES - _open[0])
                    raise _refusal(_memguard.memory_guard(self.what, need, left, "one operation",
                                                          fixed=True, unmeasured=unmeasured), self.name)
            elif need > avail:
                raise _refusal(_memguard.memory_guard(self.what, need, avail, "one operation"), self.name)
        _open[0] += need
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


def count(n, noun, plural=None):
    """n and its noun, in the singular for one: "1 node", "2 nodes" (a refusal's subject)."""
    return "%d %s" % (n, noun if n == 1 else (plural or noun + "s"))


def int_bytes(bits):
    """The bytes of computing an exact integer of this many bits."""
    return 64 + bits * INT_BYTES_PER_BIT


def open_bytes():
    """The bytes reserved by operations still running (0 between statements; the pins check it)."""
    return _open[0]
