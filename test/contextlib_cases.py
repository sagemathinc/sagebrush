# contextlib as CPython 3.14's (lib/contextlib.py is CPython's, ported):
# test/contextlib.test.ts compares this program's output with python3's.
import contextlib
import io
import sys


@contextlib.contextmanager
def tag(name, log):
    log.append("enter " + name)
    try:
        yield name.upper()
    except ValueError as e:
        log.append("caught %r" % e)
    finally:
        log.append("exit " + name)


log = []
with tag("a", log) as v:
    log.append("body " + v)
print(log)

log = []
with tag("b", log):
    raise ValueError("swallowed")
print(log)

log = []
try:
    with tag("c", log):
        raise KeyError("passes")
except KeyError as e:
    print("KeyError", e, log)


@tag("d", log)
def decorated():
    log.append("inside")


log.clear()
decorated()
decorated()
print(log)

with contextlib.suppress(KeyError, IndexError):
    [][1]
print("suppressed")
try:
    with contextlib.suppress(KeyError):
        raise TypeError("not suppressed")
except TypeError as e:
    print("TypeError", e)
# (suppress() with exception groups: when Sagebrush has ExceptionGroup)

buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    print("to the buffer")
print(repr(buf.getvalue()))
err = io.StringIO()
with contextlib.redirect_stderr(err):
    print("to stderr", file=sys.stderr)
print(repr(err.getvalue()))

with contextlib.ExitStack() as stack:
    stack.callback(print, "callback 1")
    stack.callback(print, "callback 2")
    log = []
    stack.enter_context(tag("e", log))
    print("in stack", log)
print("after stack", log)

with contextlib.ExitStack() as stack:
    stack.callback(print, "kept")
    moved = stack.pop_all()
print("popped")
moved.close()

try:
    with contextlib.ExitStack() as stack:
        stack.callback(print, "cleanup on error")
        raise RuntimeError("boom")
except RuntimeError as e:
    print("RuntimeError", e)


def suppressing_exit(*exc):
    print("exit sees", exc[0].__name__ if exc[0] else None)
    return True


with contextlib.ExitStack() as stack:
    stack.push(suppressing_exit)
    raise ZeroDivisionError
print("suppressed by push")

with contextlib.nullcontext(42) as x:
    print("nullcontext", x)


class Res:
    def close(self):
        print("closed")


with contextlib.closing(Res()) as r:
    print("using", type(r).__name__)


class CM(contextlib.ContextDecorator):
    def __enter__(self):
        print("CM enter")
        return self

    def __exit__(self, *exc):
        print("CM exit")
        return False


@CM()
def g():
    print("g body")


g()
print(isinstance(contextlib.nullcontext(), contextlib.AbstractContextManager))
print(issubclass(Res, contextlib.AbstractContextManager))


class Both:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return None


print(issubclass(Both, contextlib.AbstractContextManager))
import os, tempfile
d = tempfile.mkdtemp()
with contextlib.chdir(d):
    print(os.path.basename(os.getcwd()) == os.path.basename(d))
print(os.getcwd() != d)
try:
    with contextlib.ExitStack() as stack:
        stack.enter_context(object())
except TypeError as e:
    print("TypeError", e)
print(sorted(n for n in contextlib.__all__))
