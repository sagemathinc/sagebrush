"""atexit: functions registered to run when the interpreter exits, last registered first, as CPython's atexit (a C
module there, Modules/atexitmodule.c; this is its interface and behavior in Python).  The CLI runs them at the end
of a program, after its last line or its SystemExit; a function's exception is reported as CPython reports it, and
the rest still run."""

__all__ = ["register", "unregister"]

_callbacks = []


def register(func, *args, **kwargs):
    """Register func to be called with args and kwargs at exit; returns func, so it can be a decorator."""
    if not callable(func):
        raise TypeError("the first argument must be callable")
    _callbacks.append((func, args, kwargs))
    return func


def unregister(func):
    """Remove every registration of func (compared with ==); nothing if it isn't registered."""
    _callbacks[:] = [c for c in _callbacks if c[0] != func]


def _run_exitfuncs():
    """Call the registered functions, last first, each once: an exception (SystemExit too) is reported and the next
    one runs."""
    import sys
    while _callbacks:
        func, args, kwargs = _callbacks.pop()
        try:
            func(*args, **kwargs)
        except BaseException:
            # (a SystemExit too, as CPython: reported, and the program's own exit status kept)
            import traceback
            # (CPython's caller is C: no frame of this function in the report)
            lines = traceback.format_exc().splitlines(True)
            if len(lines) > 2 and lines[1].startswith('  File "') and "atexit.py" in lines[1]:
                del lines[1:3]
            sys.stderr.write("Exception ignored in atexit callback %r:\n" % (func,) + "".join(lines))


def _clear():
    """Forget every registered function."""
    del _callbacks[:]


def _ncallbacks():
    """How many functions are registered."""
    return len(_callbacks)
