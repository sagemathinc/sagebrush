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
# (an explicit tb is refused here, None too but for an exception with no
# frames, as Sagebrush has no traceback objects:
# test/stdlib-string-traceback.test.ts checks that, apart from CPython)
fresh = ValueError("never raised")
show("format_exception never raised", lambda: traceback.format_exception(fresh))
show("format_exception never raised, tb=None", lambda: traceback.format_exception(type(fresh), fresh, None))
show("format_exception never raised, value= tb=", lambda: traceback.format_exception(type(fresh), value=fresh, tb=None))
show("format_exception never raised limit 2**100", lambda: traceback.format_exception(fresh, limit=2**100))
buf = io.StringIO()
traceback.print_exception(type(fresh), fresh, None, file=buf)
print("print_exception never raised, tb=None:", buf.getvalue(), end="")
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


# the items: one per frame (its File line and source together), the header,
# the separators and the exception's line; and a write per item
def shape(items):
    return "%d: %r" % (len(items), [(i.splitlines() + [""])[1 if i.startswith("\n") else 0] for i in items])


class Writes:
    def __init__(self):
        self.items = []

    def write(self, s):
        self.items.append(s)


show("items", lambda: shape(traceback.format_exception(exc)) + "\n")
show("items chained", lambda: shape(traceback.format_exception(chained)) + "\n")
show("items limit=-1", lambda: shape(traceback.format_exception(context, limit=-1)) + "\n")
w = Writes()
traceback.print_exception(chained, file=w)
print("print_exception writes", shape(w.items))


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
        w = Writes()
        traceback.print_exc(file=w)
        print("print_exc writes", shape(w.items))
        print("print_exc limit=1:", out.getvalue(), end="")
        out = io.StringIO()
        traceback.print_exc(-1, out)
        print("print_exc positional:", out.getvalue(), end="")
        print("format_exc limit=2:", traceback.format_exc(limit=2), end="")
        print("format_exc limit=0:", traceback.format_exc(0), end="")
        print("same:", traceback.format_exc() == "".join(traceback.format_exception(sys.exception())))


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

# limits CPython refuses, and the edges it accepts (astra's CORR-484-3)
class Idx:
    def __index__(self):
        return 1


class IdxCmp(Idx):
    def __ge__(self, other):
        return True

    def __lt__(self, other):
        return False


for lim in [2**100, -(2**100), 2**63 - 1, 2**63, -(2**63), 2.0, -2.0, True, Idx(), IdxCmp(), "a"]:
    show("limit %s" % (type(lim).__name__ if isinstance(lim, Idx) else repr(lim)), lambda: len(traceback.format_exception(exc, limit=lim)))
show("format_exc limit 2**100 outside", lambda: traceback.format_exc(2**100))

# sys.tracebacklimit, when limit is None
sys.tracebacklimit = 1
show("tracebacklimit 1", lambda: traceback.format_exception(exc))
show("tracebacklimit, limit=2 given", lambda: traceback.format_exception(exc, limit=2))
sys.tracebacklimit = -5
show("tracebacklimit negative", lambda: traceback.format_exception(exc))
for t in [2**100, 2.0, "a"]:
    sys.tracebacklimit = t
    show("tracebacklimit %r" % (t,), lambda: len(traceback.format_exception(exc)))
del sys.tracebacklimit
show("tracebacklimit removed", lambda: traceback.format_exception(exc))
