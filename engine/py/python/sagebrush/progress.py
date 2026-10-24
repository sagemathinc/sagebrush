"""Live progress (design-estimates-progress r4 §6): what a Python routine
reports while it runs, and what a reader sees.

A routine that holds the interpreter for a long time reports its counts at
its own polls; the engines report theirs themselves.  Every call has its
own slot (32 per session), nested calls name their parent, and calls from
several threads are never combined.  Progress never changes a result or
stops a computation.

    sage: from sagebrush import progress
    sage: with progress.call("example") as p:
    ....:     p.update(stage="steps", done=3, total=10, unit="steps")
    ....:     p.flush()
    ....:     [(r["op"], r["count"]["done"], r["count"]["total"]) for r in progress.snapshot()]
    [('example', 3, 10)]
    sage: progress.snapshot()
    []

snapshot() returns sagebrush.progress/1 records (sagebrush.records); a call
that found every slot taken runs untracked, and is listed with
status "untracked" and no counts until it gets a slot.
"""

import json as _json

try:
    import _progress as _p  # the browser runtime's builtin
except ImportError:  # the CPython package: the same functions, natively
    from . import _native as _n

    class _p:
        begin = staticmethod(_n.progress_begin)
        update = staticmethod(_n.progress_update)
        flush = staticmethod(_n.progress_flush)
        end = staticmethod(_n.progress_end)
        snapshot = staticmethod(_n.progress_snapshot)
        tables = staticmethod(_n.progress_tables)

_FIELDS = ("stage", "stage_index", "stage_count", "done", "total", "unit", "work", "fraction",
           "beyond_forecast", "memory_now_bytes", "memory_peak_bytes")


class Call:
    """One routine's progress, from call(op) until end() (or the end of its
    with-block, on success, an error or an interrupt alike)."""

    def __init__(self, op):
        self.id = _p.begin(str(op))
        self._ended = False

    def update(self, **counts):
        """Sets counts (stage, stage_index, stage_count, done, total, unit,
        work, fraction, beyond_forecast, memory_now_bytes, memory_peak_bytes;
        total=None is unknown); written at most every 250 ms, so it is cheap
        to call at every poll."""
        for k in counts:
            if k not in _FIELDS:
                raise TypeError("update() got an unexpected keyword argument %r" % k)
        if not self._ended:
            _p.update(self.id, _json.dumps(counts))

    def flush(self):
        """Writes the counts now."""
        if not self._ended:
            _p.flush(self.id)

    def end(self):
        if not self._ended:
            self._ended = True
            _p.end(self.id)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.end()
        return False


def call(op):
    """A new Call for op (a short name, such as "groebner (python)")."""
    return Call(op)


def snapshot():
    """Every call in progress now, as sagebrush.progress/1 records."""
    return _json.loads(_p.snapshot())


def tables():
    """The names behind the slots' op, stage and unit indices."""
    return _json.loads(_p.tables())
