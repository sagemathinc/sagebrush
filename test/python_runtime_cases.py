# Runtime behaviour found while writing Python mode's search examples
# (test/python-runtime.test.ts compares this program's output under
# Sagebrush with CPython's).
import io
import math
import random
import sys

# print writes to sys.stdout as it is now: a StringIO, an object with write,
# or nothing at all for None
buf = io.StringIO()
sys.stdout = buf
print("captured", 1, sep="-")
sys.stdout = sys.__stdout__
print(repr(buf.getvalue()))


def in_function():
    old, sys.stdout = sys.stdout, io.StringIO()
    try:
        print("inside a function")
        return sys.stdout.getvalue()
    finally:
        sys.stdout = old


print(repr(in_function()))


class Writer:
    def __init__(self):
        self.parts = []

    def write(self, s):
        self.parts.append(s)


w = Writer()
sys.stdout = w
print("a", "b", end="!")
sys.stdout = None
print("nothing")
sys.stdout = sys.__stdout__
print(w.parts)

# sum of floats with Neumaier's compensation (CPython 3.12), and of complex
# numbers (3.14); subclasses and big ints are added as they are
cases = [[0.1] * 10, [1e100, 1.0, -1e100], [1, 0.1, 0.2, 0.3], [0.1, 2 ** 70, 0.1], [float("inf"), 1.0],
         [float("inf"), -float("inf")], [1e308, 1e308], [-0.0, -0.0], [0.1j] * 10, [0.1 + 0.1j] * 10, [0.1, True, 0.2],
         [1e16, 1.0, 1.0], [0.1, 0.1j, 0.1j, 0.2], [1j, 2 ** 70, 0.1]]


class F(float):
    pass


class I(int):
    pass


cases += [[F(0.1)] * 10, [0.1, F(0.2), 0.3], [0.1, I(3), 0.2]]
for c in cases:
    print(repr(sum(c)), repr(sum(c, 0.0)), repr(sum(c, -0.0)), repr(sum(x for x in c)))
print(repr(sum([], -0.0)), repr(sum([0.5, 0.25], 1)), repr(sum([0.1] * 10, 1j)), repr(sum(0.1 for _ in range(10))))

# sum takes the items one at a time, adding each as it comes, as CPython: a
# generator's next() and the additions interleave (also in sum(genexpr),
# which the compiler runs as a loop), through every path (int, float,
# complex, anything) (CORR-97B-2)
state = [1]
log = []


class Item:
    def __init__(self, n):
        self.n = n

    def __radd__(self, other):
        state[0] *= 2
        log.append(("add", self.n))
        return other + self.n


def items(first=()):
    yield from first
    for k in range(3):
        log.append(("yield", k))
        yield Item(state[0])


for first in [(), (1, 2), (0.5, 0.25), (1, 0.5, 1j), (2 ** 70,)]:
    state[0] = 1
    del log[:]
    a = sum(x for x in items(first))
    log1 = log[:]
    state[0] = 1
    del log[:]
    print(repr(a), repr(sum(items(first))), log1 == log, log)


def endless():
    k = 0
    while True:
        log.append(k)
        yield 0.5 if k < 3 else "x"
        k += 1


del log[:]
for f in (lambda: sum(endless()), lambda: sum(v for v in endless())):
    try:
        f()
    except TypeError as e:
        print(type(e).__name__, e, log)
    del log[:]

# round() of int and float subclasses (int.__round__, float.__round__)
for v in [F(2.5), F(2.567), I(15), True, 3.5]:
    for nd in [None, 1, -1]:
        r = round(v) if nd is None else round(v, nd)
        print(repr(v), nd, repr(r), type(r).__name__)
print(float.__round__(2.675, 2), int.__round__(25, -1))

# math.gamma and math.lgamma, CPython's own Lanczos approximation
random.seed(7)
xs = [5.5, 100, 0.5, 1e-21, 170.5, 171.7, 141.5, 139.9, 201, 1e-5, 2.0000001, 3.7, 23, 24, 25.5]
xs += [random.uniform(0, 180) for _ in range(400)] + [math.exp(random.uniform(-40, 6)) for _ in range(300)]
for x in xs:
    out = []
    for f in (math.gamma, math.lgamma):
        try:
            out.append(repr(f(x)))
        except (ValueError, OverflowError) as e:
            out.append(type(e).__name__)
    print(*out)
