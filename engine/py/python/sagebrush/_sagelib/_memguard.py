"""The one memory-guard message (item D; plan-d-memory-message r3, William's
wording of Oct 24 2026).

A memory guard stops a computation before it allocates more than Sagebrush
allows for it; when it does, it raises memory_guard(...)'s error, which
says what tried to allocate and how much, the allowance it exceeded, and
where Sagebrush could run with more memory:

    raise memory_guard("A 20000 x 20000 matrix over GF(7)", need, allowance, "one matrix")

A guard whose limit is fixed, the same whatever memory there is (a matrix's
2^22 entries, a dense conversion's 2^20 coefficients), says so instead
(fixed=True): it names no route to more memory, since none would help
(astra's PR114-SEM-1).

SagebrushMemoryError is a MemoryError (single inheritance), the one type of
every guard's refusal, whose attributes stay stable: what, need_bytes and
limit_bytes (exact; limit_bytes is the guard's enforced allowance for this
operation, never the process's free memory), allowance_for, and record,
partial and checkpoint (None unless given; the estimates' memory stops set
them, PR 5b / GB-6), fixed (whether the limit is fixed), and unmeasured
(None, or why the memory available could not be measured: then there is no
allowance to compare against, and the guard refuses rather than guess;
plan-matlab-nocliffs r6 section 2.2).  A guard computes its need before anything is
allocated and keeps its own admission predicate: this module only words
the refusal.

The message's sizes are rounded to two significant digits, in kB, MB or GB
(10^3, 10^6, 10^9 bytes), the need up and the allowance down, with more digits
where the two would otherwise read alike while the need is larger.
"""

import sys as _sys


class SagebrushMemoryError(MemoryError):
    """A memory guard's refusal: what tried to allocate, how much
    (need_bytes), the allowance it exceeded (limit_bytes), and where to run
    with more memory (the message).  record, partial and checkpoint are the
    estimates' memory-stop handback (None unless set).

    EXAMPLES::

        sage: from _memguard import SagebrushMemoryError, memory_guard
        sage: try:
        ....:     raise memory_guard("A list of 10^9 elements", 8 * 10**9, 10**9, "one list")
        ....: except MemoryError as e:
        ....:     print(type(e).__name__, e.need_bytes, e.limit_bytes)
        SagebrushMemoryError 8000000000 1000000000
    """

    def __init__(self, text, what, need_bytes, limit_bytes, allowance_for, record=None, partial=None, checkpoint=None,
                 fixed=False, unmeasured=None):
        MemoryError.__init__(self, text)
        self.what = what
        self.need_bytes = need_bytes
        self.limit_bytes = limit_bytes
        self.allowance_for = allowance_for
        self.record = record
        self.partial = partial
        self.checkpoint = checkpoint
        self.fixed = fixed
        self.unmeasured = unmeasured


# The wording (William, Oct 24 2026; plan-d-memory-message r3 section 1c,
# D0 r2 section 1): the routes named are only those that give more memory
# today.  One table, keyed by where Sagebrush runs.
TEXT = {
    "title": "Not enough memory for this computation.",
    "need": "%(what)s needs about %(need)s, but Sagebrush allows about %(limit)s for %(allowance_for)s here.",
    # (an allowance of nothing: D0's reserve can leave a guard none)
    "need_none": "%(what)s needs about %(need)s, but Sagebrush allows almost no memory for %(allowance_for)s here.",
    # (no allowance at all: the memory available could not be measured, so
    # the guard refuses rather than guess; plan-matlab-nocliffs r6 section 2.2)
    "need_unmeasured": "%(what)s needs about %(need)s, but Sagebrush can't measure the memory available here (%(reason)s), so it doesn't start it.",
    # (a fixed limit, the same with any memory: no route to more memory,
    # which wouldn't help; astra's PR114-SEM-1)
    "fixed_title": "This computation is larger than Sagebrush allows.",
    "fixed_need": "%(what)s needs about %(need)s, but Sagebrush has a fixed limit of about %(limit)s for %(allowance_for)s.",
    "fixed": "This limit is the same whatever memory there is: more memory or a larger\nmachine won't help.",
    # (the routes' lines are broken under 80 columns, as Magma prints an
    # error, continuations indented two spaces)
    "browser": (
        "To run it, use Sagebrush outside the browser, where it can use your machine's\n"
        "full memory:\n"
        "- on your own computer, with the Python package (pip install sagebrush);\n"
        "- in a cocalc.ai project, with the same package;\n"
        "- on a dedicated machine with as much memory as it needs, rented through\n"
        "  cocalc.ai."),
    "cli": (
        "To run it with more memory:\n"
        "- give this Sagebrush more memory with NODE_OPTIONS=--max-old-space-size=<MiB>\n"
        "  (the engines keep their 4 GB);\n"
        "- or use the Python package (pip install sagebrush): on your own computer, in\n"
        "  a cocalc.ai project, or on a dedicated machine with as much memory as it\n"
        "  needs, rented through cocalc.ai."),
    "package": (
        "To run it with more memory:\n"
        "- in a cocalc.ai project, with the same package;\n"
        "- on a dedicated machine with as much memory as it needs, rented through\n"
        "  cocalc.ai."),
}


def where():
    """Where Sagebrush runs, for the message: "package" (CPython, the
    Python package), "cli" (the engine under Node: the command line), or
    "browser" (the engine in a page).

    EXAMPLES::

        sage: import _memguard
        sage: _memguard.where() in ("package", "cli", "browser")
        True
    """
    if getattr(getattr(_sys, "implementation", None), "name", "") == "cpython":
        return "package"
    return "cli" if hasattr(_sys, "_sagebrush_heap_used") else "browser"


_UNITS = ((10 ** 9, "GB"), (10 ** 6, "MB"), (10 ** 3, "kB"), (1, "bytes"))


def _render(x, up, sig, floor_unit=None):
    """x bytes as a size of sig significant digits, rounded up (up) or down,
    exactly (integers only): in GB from 10^9 bytes, MB from 10^6, kB from
    10^3, else bytes; a value rounded up to 1000 of a unit is said in the
    next."""
    x = max(0, int(x))
    for i, (unit, name) in enumerate(_UNITS):
        if x >= unit or unit == 1:
            break
    if floor_unit is not None:
        i = min(i, floor_unit)
        unit, name = _UNITS[i]
    if unit == 1:
        return "%d bytes" % x
    ip = x // unit
    # (a carry into this unit is under one of it: the 1 of 1.0)
    d = max(0, sig - len(str(max(ip, 1))))
    scale = 10 ** d
    q, r = divmod(x * scale, unit)
    if up and r:
        q += 1
    if i > 0 and q >= 1000 * scale:
        return _render(x, up, sig, i - 1)
    whole, frac = divmod(q, scale)
    return ("%d.%0*d %s" % (whole, d, frac, name)) if d else ("%d %s" % (whole, name))


def sizes(need_bytes, limit_bytes):
    """The need (rounded up) and the allowance (rounded down) as the message
    shows them: two significant digits, more where they would read alike
    while the need is larger.

    EXAMPLES::

        sage: from _memguard import sizes
        sage: sizes(3_200_000_001, 1_000_000_000), sizes(240 * 10**6, 10**9)
        (('3.3 GB', '1.0 GB'), ('240 MB', '1.0 GB'))
        sage: sizes(999_950_000, 500 * 10**6)  # (999.95 MB, rounded up, is 1.0 GB)
        ('1.0 GB', '500 MB')
        sage: sizes(1_000_000_001, 10**9), sizes(999_999_999, 999_999_998)  # (never alike while the need is larger)
        (('1.1 GB', '1.0 GB'), ('1.0 GB', '999 MB'))
        sage: sizes(1501, 1499), sizes(5, 4)
        (('1.6 kB', '1.4 kB'), ('5 bytes', '4 bytes'))
    """
    for sig in range(2, 13):
        n, m = _render(need_bytes, True, sig), _render(limit_bytes, False, sig)
        if n != m or need_bytes <= limit_bytes:
            return n, m
    return "%d bytes" % need_bytes, "%d bytes" % limit_bytes


def message(what, need_bytes, limit_bytes, allowance_for, host=None, fixed=False, unmeasured=None):
    """The guard's text (TEXT): the title, what needs how much against the
    allowance, and the routes to more memory where Sagebrush runs; for a
    fixed limit (fixed), that limit, and that more memory won't help; when
    the memory available could not be measured (unmeasured, the reason),
    that, in place of the allowance.

    EXAMPLES::

        sage: from _memguard import message
        sage: print(message("A 20000 x 20000 matrix over GF(7)", 3_200_000_001, 10**9, "one matrix", "package"))
        Not enough memory for this computation.
        A 20000 x 20000 matrix over GF(7) needs about 3.3 GB, but Sagebrush allows about 1.0 GB for one matrix here.
        To run it with more memory:
        - in a cocalc.ai project, with the same package;
        - on a dedicated machine with as much memory as it needs, rented through
          cocalc.ai.
        sage: print(message("A list", 10**6, 0, "one list", "browser").splitlines()[1])
        A list needs about 1.0 MB, but Sagebrush allows almost no memory for one list here.
        sage: print(message("A 100000 x 100000 matrix", 8 * 10**10, 2**25, "one matrix", "cli", fixed=True))
        This computation is larger than Sagebrush allows.
        A 100000 x 100000 matrix needs about 80 GB, but Sagebrush has a fixed limit of about 33 MB for one matrix.
        This limit is the same whatever memory there is: more memory or a larger
        machine won't help.
        sage: print(message("A sparse LU factorization", 10**6, 0, "one solve", "cli", unmeasured="no memory figure").splitlines()[1])
        A sparse LU factorization needs about 1.0 MB, but Sagebrush can't measure the memory available here (no memory figure), so it doesn't start it.
    """
    need, limit = sizes(need_bytes, limit_bytes)
    if unmeasured is not None:
        fill = {"what": what, "need": need, "reason": unmeasured}
        return "\n".join([TEXT["title"], TEXT["need_unmeasured"] % fill, TEXT[host or where()]])
    fill = {"what": what, "need": need, "limit": limit, "allowance_for": allowance_for}
    if fixed:
        return "\n".join([TEXT["fixed_title"], TEXT["fixed_need"] % fill, TEXT["fixed"]])
    line = TEXT["need" if limit_bytes > 0 else "need_none"]
    return "\n".join([TEXT["title"], line % fill, TEXT[host or where()]])


def memory_guard(what, need_bytes, limit_bytes, allowance_for, record=None, partial=None, checkpoint=None, fixed=False,
                 unmeasured=None):
    """The refusal of a memory guard, to raise: a SagebrushMemoryError with
    the message and the exact figures.  what is the operation in the
    user's words (capitalized: "A 20000 x 20000 matrix over GF(7)"),
    allowance_for what the allowance is for ("one matrix"); fixed for a
    limit that is the same whatever memory there is; unmeasured (a reason,
    such as "no memory figure") when the memory available could not be
    measured, so there is no allowance (limit_bytes is then 0).

    EXAMPLES::

        sage: from _memguard import memory_guard, SagebrushMemoryError
        sage: e = memory_guard("A 20000 x 20000 matrix over GF(7)", 3_200_000_001, 10**9, "one matrix")
        sage: print(str(e).splitlines()[1])
        A 20000 x 20000 matrix over GF(7) needs about 3.3 GB, but Sagebrush allows about 1.0 GB for one matrix here.
        sage: type(e) is SagebrushMemoryError, isinstance(e, MemoryError), type(e).__bases__ == (MemoryError,)
        (True, True, True)
        sage: e.what, e.need_bytes, e.limit_bytes, e.allowance_for, e.record, e.partial, e.checkpoint
        ('A 20000 x 20000 matrix over GF(7)', 3200000001, 1000000000, 'one matrix', None, None, None)
        sage: p = [1, 2]; memory_guard("X", 2, 1, "y", record={"k": 1}, partial=p).partial is p
        True
        sage: e.fixed, memory_guard("X", 2, 1, "y", fixed=True).fixed
        (False, True)
        sage: u = memory_guard("X", 2, 0, "y", record={"bytes": None}, unmeasured="no memory figure")
        sage: u.unmeasured, u.limit_bytes, u.record, e.unmeasured
        ('no memory figure', 0, {'bytes': None}, None)
    """
    need_bytes, limit_bytes = int(need_bytes), int(limit_bytes)
    fixed = bool(fixed)
    return SagebrushMemoryError(message(what, need_bytes, limit_bytes, allowance_for, fixed=fixed, unmeasured=unmeasured), what,
                                need_bytes, limit_bytes, allowance_for, record, partial, checkpoint, fixed, unmeasured)
