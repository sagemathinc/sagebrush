# traceback's three-argument form with the exception's own traceback, as
# CPython 3.14's: format_exception(*sys.exc_info()) and
# format_exception(type(e), e, e.__traceback__), and print_exception's. Here
# sys.exc_info()[2] and __traceback__ are None, taken as the exception's own
# traceback (src/runtime/index.ts, target()). Run by
# test/stdlib-string-traceback.test.ts, compared with python3.
import io
import sys
import traceback


def inner(n):
    return 10 // n


def outer():
    return inner(0)


try:
    outer()
except ZeroDivisionError as e:
    print("".join(traceback.format_exception(*sys.exc_info())), end="")
    print("".join(traceback.format_exception(type(e), e, e.__traceback__)), end="")
    f = io.StringIO()
    traceback.print_exception(*sys.exc_info(), file=f)
    print(f.getvalue(), end="")
    traceback.print_exception(type(e), e, e.__traceback__, file=sys.stdout)

# (a chained exception, and limit= with the three-argument form)
try:
    try:
        {}["k"]
    except KeyError:
        outer()
except ZeroDivisionError as e:
    print("".join(traceback.format_exception(type(e), e, e.__traceback__)), end="")
    print("".join(traceback.format_exception(type(e), e, e.__traceback__, limit=1)), end="")
    print("".join(traceback.format_exception(*sys.exc_info(), chain=False)), end="")

# (a saved exception, formatted after its handler ended)
try:
    outer()
except ZeroDivisionError as e:
    saved = e
print("".join(traceback.format_exception(type(saved), saved, saved.__traceback__)), end="")
