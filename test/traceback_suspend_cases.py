# Exceptions carried across a generator's suspension (a finally or except that
# yields), a with statement's __exit__, and two functions of one name:
# compared with CPython 3.14 by test/sortedcontainers-blockers.test.ts (astra's
# propagation and finally-resume probes, CORR-6AF-2)
import traceback

def show(label):
    print("==", label)
    try:
        print(traceback.format_exc(), end="")
    except NotImplementedError as e:
        print("REFUSED", e)

def final_generator():
    try:
        1 / 0
    finally:
        yield "paused"

def same_driver():
    g = final_generator()
    print(next(g))
    try:
        next(g)
    except ZeroDivisionError:
        show("finally yielded: same driver")
same_driver()

def prime(g):
    return next(g)
def different_driver():
    g = final_generator()
    print(prime(g))
    try:
        next(g)
    except ZeroDivisionError:
        show("finally yielded: different driver")
different_driver()

class C:
    def __enter__(self):
        return self
    def __exit__(self, typ, val, tb):
        show("with exit")
        return False

def in_with():
    with C():
        1 / 0
try:
    in_with()
except ZeroDivisionError:
    show("with outside")

# Two functions with the same name in the same Python source.
def f():
    1 / 0
leaf = f
def f():
    try:
        leaf()
    except ZeroDivisionError:
        show("same function name")
f()

# A suspended generator carrying an exception through finally, and a bare
# raise in that finally. The first-next line must not survive propagation.
def final_reraise_generator():
    try:
        1 / 0
    finally:
        yield "paused"
        raise

def last_driver():
    g = final_reraise_generator()
    print(next(g))
    try:
        next(g)
    except ZeroDivisionError:
        show("finally yielded then bare raise")
last_driver()


# primed by one function, resumed by another, the finally propagating
def generator():
    try:
        1 / 0
    finally:
        yield "pause"

def prime(g):
    return next(g)

def resume(g):
    try:
        next(g)
    except ZeroDivisionError:
        return traceback.format_exc()

g = generator()
print(prime(g))
print(resume(g), end="")


# an except clause that yields and doesn't re-raise, then a later one
def keeps():
    try:
        {}["k"]
    except KeyError:
        yield "caught"
        yield traceback.format_exc()


def first(g):
    return next(g)


def second(g):
    return next(g)


g = keeps()
first(g)
print(second(g), end="")


# a finally that yields twice, resumed by three functions
def twice():
    try:
        [][0]
    finally:
        yield 1
        yield 2


def a(g):
    return next(g)


def b(g):
    return next(g)


def c(g):
    try:
        next(g)
    except IndexError:
        return traceback.format_exc()


g = twice()
a(g)
b(g)
print(c(g), end="")


# PEP 479: a StopIteration out of a generator, the cause of a RuntimeError;
# a builtin's KeyError as a cause (CORR-581-1)
def g():
    yield 1
    next(iter([]))
try:
    list(g())
except RuntimeError:
    print(traceback.format_exc(), end="")
try:
    try:
        {}[1]
    except KeyError as k:
        raise ValueError("from builtin") from k
except ValueError:
    print(traceback.format_exc(), end="")
def h():
    yield 1
    return 5
def outer():
    x = yield from h()
    yield x
print(list(outer()))
def bad():
    yield 1
    raise StopIteration("explicit")
try:
    list(bad())
except RuntimeError:
    print(traceback.format_exc(), end="")
# the bookkeeping is not among an exception's attributes
try:
    {}[2]
except KeyError as e:
    print([n for n in dir(e) if n.startswith("$")], [n for n in vars(e) if n.startswith("$")])
