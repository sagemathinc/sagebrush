"""Rill's memory discipline (design/rill.md §8.5): size first, reserve, then release.

Every allocation computes its size in Python integers (which can't overflow)
before anything is allocated, and reserves the operation's peak live storage
against the session's allowance; the reservation is released in `finally`,
so an R error or Stop gives it back.  The allowance is the memory this host
can observe free now (lib/_capacity.py), less the reservations open in the
session.  Where no figure can be observed, a fixed cap per operation applies
instead, and the refusal says so.

A refusal is lib/_memguard.py's SagebrushMemoryError; the session reports it
as R's allocation error ("cannot allocate vector of size 762.9 Mb", in R's
own sizes), with Sagebrush's sentence on the next line.
"""

import _memguard

# below this, an operation is admitted without reading the host's memory (reading it costs
# more than the allocation); larger ones are checked against the live figure
SMALL_BYTES = 1 << 20
# the cap per operation where the host's memory can't be observed (no capacity figure)
UNMEASURED_OPERATION_BYTES = 1 << 28

# the host's bytes per element of each type, for reservations, measured on the CLI's engine (Node 24.21.0): the
# resident growth of a list of 10^6 elements, two runs (doubles 44.8 and 59.4 B, integers 27.8 and 31.1, logicals
# about 2 plus their 8-byte slot, short strings 125.1 and 129.0, None 8.1), rounded up; a complex is two doubles
ELEMENT_BYTES = {"logical": 8, "integer": 32, "double": 64, "complex": 128, "character": 136}
# the parser's tokens and tree per character of source, held while a program runs (an upper bound: at most one
# token per character, each with its tree node)
PARSE_BYTES_PER_CHAR = 256
# R's bytes per element, for R's message
R_ELEMENT_BYTES = {"logical": 4, "integer": 4, "double": 8, "complex": 16, "character": 8}

_open = [0]     # the bytes reserved by operations still running in this session


def _allowance():
    """(bytes, unmeasured reason or None) available to a new reservation now (the memory figure's module is
    imported here, on the first reservation above SMALL_BYTES, never at Rill's start)."""
    import _capacity
    rec = _capacity.capacity()
    g = _capacity.effective_guard_bytes(rec)
    if g is None:
        return None, "no memory figure"
    return max(0, int(g) - _open[0]), None


def r_size(nbytes):
    """R's wording of a size: "762.9 Mb", "2.2 Gb" (R 4.5.3, rill-tests/mem/ and the PR's probes)."""
    if nbytes >= 1 << 30:
        return "%.1f Gb" % (nbytes / float(1 << 30))
    if nbytes >= 1 << 20:
        return "%.1f Mb" % (nbytes / float(1 << 20))
    return "%.1f Kb" % (nbytes / 1024.0)


class Reservation:
    """`with reserve(n, "double"):` reserves n elements' peak storage for the
    operation and gives it back when the block ends, however it ends."""

    def __init__(self, nbytes, r_bytes, what):
        self.nbytes = nbytes
        self.r_bytes = r_bytes
        self.what = what

    def __enter__(self):
        need = self.nbytes
        if need > SMALL_BYTES:
            avail, unmeasured = _allowance()
            if unmeasured is not None:
                if need > UNMEASURED_OPERATION_BYTES:
                    e = _memguard.memory_guard(self.what, need, UNMEASURED_OPERATION_BYTES, "one operation", fixed=True,
                                               unmeasured=unmeasured)
                    e.r_bytes = self.r_bytes
                    raise e
            elif need > avail:
                e = _memguard.memory_guard(self.what, need, avail, "one operation")
                e.r_bytes = self.r_bytes
                raise e
        _open[0] += need
        return self

    def __exit__(self, *exc):
        _open[0] -= self.nbytes
        return False


NOUNS = {"logical": "logical values", "integer": "integers", "double": "numbers", "complex": "complex numbers",
         "character": "strings"}


def reserve(n, type, *temporaries, extra_bytes=0):
    """A reservation for an operation's whole peak: its n-element result of `type`, and each temporary
    (count, type) it holds at the same time (coerced copies of its operands, element strings), plus extra_bytes
    (counts are Python ints).  R's message names the result's size, as R would allocate it."""
    n = max(0, int(n))
    nbytes = n * ELEMENT_BYTES[type] + int(extra_bytes)
    for count, t in temporaries:
        nbytes += max(0, int(count)) * ELEMENT_BYTES[t]
    # (R's message names the result vector; an operation without one, cat or print, names its whole need)
    return Reservation(nbytes, n * R_ELEMENT_BYTES[type] if n else nbytes, "A vector of %d %s" % (n, NOUNS[type]) if n
                       else "Formatting %d bytes of output" % nbytes)


def open_bytes():
    """The bytes reserved by operations still running (0 between statements; the pins check it)."""
    return _open[0]
