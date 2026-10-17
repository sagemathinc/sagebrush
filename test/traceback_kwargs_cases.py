# traceback's keyword arguments (limit=, file=, chain=) and print_exc,
# print_exception and format_exception's arguments, as CPython 3.14's
# (compared with CPython by test/stdlib-string-traceback.test.ts)
import io, sys, traceback


def show(label, f):
    try:
        r = f()
        print(label, "->", r if isinstance(r, str) else "".join(r) if isinstance(r, list) else repr(r), end="" if isinstance(r, (str, list)) else "\n")
    except Exception as e:
        print(label, "raises", type(e).__name__, e)


def a():
    b()


def b():
    c()


def c():
    raise KeyError("deep")


try:
    a()
except KeyError as err:
    exc = err

# format_exception: limit (positive, zero, negative, None), chain, the old
# three-argument form, value without tb
for limit in [None, 0, 1, 2, -1, -2, 10]:
    show("format_exception limit=%r" % (limit,), lambda: traceback.format_exception(exc, limit=limit))
show("format_exception positional limit", lambda: traceback.format_exception(exc, None, None, 1))
show("format_exception old form", lambda: traceback.format_exception(type(exc), exc, exc.__traceback__))
show("format_exception old form limit", lambda: traceback.format_exception(type(exc), exc, exc.__traceback__, limit=1))
show("format_exception value without tb", lambda: traceback.format_exception(exc, value=exc))
show("format_exception exc as keyword", lambda: traceback.format_exception(exc=exc))
show("format_exception unknown keyword", lambda: traceback.format_exception(exc, colour=True))
show("format_exception too many", lambda: traceback.format_exception(exc, None, None, None, True, 6))
show("format_exception twice", lambda: traceback.format_exception(exc, None, None, 1, limit=2))
show("format_exception None", lambda: traceback.format_exception(None))
show("format_exception colorize=False", lambda: traceback.format_exception(exc, limit=1, colorize=False))
show("print_exception other keyword", lambda: traceback.print_exception(exc, file=io.StringIO(), whatever=1))

# chained exceptions: chain=True and False
try:
    try:
        a()
    except KeyError as e:
        raise ValueError("outer") from e
except ValueError as e:
    chained = e
show("chained", lambda: traceback.format_exception(chained))
show("chained chain=False", lambda: traceback.format_exception(chained, chain=False))
show("chained limit=1", lambda: traceback.format_exception(chained, limit=1))
try:
    try:
        1 / 0
    except ZeroDivisionError:
        raise TypeError("while handling")
except TypeError as e:
    context = e
show("context", lambda: traceback.format_exception(context))
show("context chain=0", lambda: traceback.format_exception(context, chain=0))

# print_exception to a file, and to sys.stderr
buf = io.StringIO()
traceback.print_exception(exc, limit=1, file=buf)
print("print_exception file:", buf.getvalue(), end="")
buf = io.StringIO()
traceback.print_exception(chained, file=buf, chain=False)
print("print_exception chain=False:", buf.getvalue(), end="")
old = sys.stderr
sys.stderr = io.StringIO()
traceback.print_exception(exc, limit=-1)
got, sys.stderr = sys.stderr.getvalue(), old
print("print_exception to sys.stderr:", got, end="")
show("print_exception file=None returns", lambda: traceback.print_exception(exc, file=io.StringIO()))


# print_exc and format_exc: the exception being handled, limit, chain, file
def handler():
    try:
        a()
    except KeyError:
        out = io.StringIO()
        traceback.print_exc(file=out)
        print("print_exc:", out.getvalue(), end="")
        out = io.StringIO()
        traceback.print_exc(limit=1, file=out)
        print("print_exc limit=1:", out.getvalue(), end="")
        out = io.StringIO()
        traceback.print_exc(-1, out)
        print("print_exc positional:", out.getvalue(), end="")
        print("format_exc limit=2:", traceback.format_exc(limit=2), end="")
        print("format_exc limit=0:", traceback.format_exc(0), end="")
        print("same:", traceback.format_exc() == "".join(traceback.format_exception(*sys.exc_info())))


handler()
try:
    try:
        a()
    except KeyError as e:
        raise ValueError("outer") from e
except ValueError:
    out = io.StringIO()
    traceback.print_exc(file=out, chain=False)
    print("print_exc chain=False:", out.getvalue(), end="")
out = io.StringIO()
traceback.print_exc(file=out)
print("print_exc outside:", repr(out.getvalue()))
show("print_exc unknown keyword", lambda: traceback.print_exc(colour=1))
show("print_exc too many", lambda: traceback.print_exc(1, None, True, 4))

# sys.tracebacklimit, when limit is None
sys.tracebacklimit = 1
show("tracebacklimit 1", lambda: traceback.format_exception(exc))
show("tracebacklimit, limit=2 given", lambda: traceback.format_exception(exc, limit=2))
sys.tracebacklimit = -5
show("tracebacklimit negative", lambda: traceback.format_exception(exc))
del sys.tracebacklimit
show("tracebacklimit removed", lambda: traceback.format_exception(exc))
