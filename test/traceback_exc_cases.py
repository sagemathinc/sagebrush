# traceback.format_exc() formats the exception being handled, as
# sys.exc_info() has it (compared with CPython 3.14 by
# test/sortedcontainers-blockers.test.ts)
import sys, traceback

print(repr(traceback.format_exc()))
try:
    assert False
except BaseException:
    print(traceback.format_exc(), end="")
print(repr(traceback.format_exc()))


def inner(x):
    return 1 / x


def outer():
    try:
        inner(0)
    except ZeroDivisionError:
        return traceback.format_exc()


print(outer(), end="")
try:
    try:
        {}["k"]
    except KeyError as e:
        raise ValueError("bad") from e
except ValueError:
    print(traceback.format_exc(), end="")
    print(traceback.format_exc(chain=False), end="")
try:
    try:
        int("x")
    except ValueError:
        [][1]
except IndexError:
    print(traceback.format_exc(), end="")
try:
    raise RuntimeError("outer")
except RuntimeError:
    try:
        raise TypeError("inner")
    except TypeError:
        print(traceback.format_exc().splitlines()[-1])
    print(traceback.format_exc().splitlines()[-1])
    print(sys.exc_info()[0].__name__)
print(repr(traceback.format_exc()))


class MyError(Exception):
    pass


try:
    raise MyError("custom", 2)
except MyError:
    print(traceback.format_exc().splitlines()[-1])
try:
    raise KeyError("k")
except KeyError:
    print(traceback.format_exc(None, True).splitlines()[-1])
for call in [lambda: traceback.format_exc(None, True, 3), lambda: traceback.format_exc(chain=False, limit=None), lambda: traceback.format_exc(None, chain=0)]:
    try:
        raise RuntimeError("gone")
    except RuntimeError:
        try:
            print(repr(call().splitlines()[-1]))
        except TypeError as e:
            print("TypeError", e)


# from a helper called in the handler, and the handler deeper in the stack
def report():
    return traceback.format_exc()


def deep(n):
    if n == 0:
        raise LookupError("deep")
    return deep(n - 1)


def handler():
    try:
        deep(3)
    except LookupError:
        return report()


def caller():
    return handler()


print(caller(), end="")
