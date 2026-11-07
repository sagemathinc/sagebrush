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

# the host's bytes per element of each type, for reservations: an engine list slot plus a boxed
# value; strings add their characters (see element_bytes)
ELEMENT_BYTES = {"logical": 8, "integer": 32, "double": 32, "complex": 64, "character": 64}
# R's bytes per element, for R's message
R_ELEMENT_BYTES = {"logical": 4, "integer": 4, "double": 8, "complex": 16, "character": 8}

_open = [0]     # the bytes reserved by operations still running in this session
_capacity = None


def _allowance():
    """(bytes, unmeasured reason or None) available to a new reservation now."""
    global _capacity
    if _capacity is None:
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


def reserve(n, type, extra_bytes=0):
    """A reservation for an n-element vector of `type` (n is a Python int)."""
    n = max(0, int(n))
    nbytes = n * ELEMENT_BYTES[type] + int(extra_bytes)
    noun = {"logical": "logical values", "integer": "integers", "double": "numbers",
            "complex": "complex numbers", "character": "strings"}[type]
    return Reservation(nbytes, n * R_ELEMENT_BYTES[type], "A vector of %d %s" % (n, noun))


def open_bytes():
    """The bytes reserved by operations still running (0 between statements; the pins check it)."""
    return _open[0]
