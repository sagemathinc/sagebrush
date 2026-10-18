# math.factorial, comb, perm and prod, and Sage-free Python only: compared
# line by line with CPython 3.14 (test/bigint-products.test.ts)
import math
import sys

P = (1 << 61) - 1  # a Mersenne prime


def digest(v):
    return (v.bit_length(), v % P, v % 1000000007)


class I:
    def __init__(self, v):
        self.v = v

    def __index__(self):
        return self.v


class J(int):
    pass


def show(f):
    try:
        r = f()
        return type(r).__name__ + ' ' + (repr(r) if not isinstance(r, int) or r.bit_length() < 128 else repr(digest(r)))
    except Exception as e:
        return type(e).__name__ + ': ' + str(e)


# values: every n to 300 (the 64-bit leaves and the odd-part loop's
# boundaries), then large n by size and residues
for n in range(301):
    print('f', n, digest(math.factorial(n)))
for n in [511, 512, 513, 1000, 1023, 1024, 1025, 4097, 20000, 65537, 100000]:
    print('f', n, digest(math.factorial(n)))

# comb and perm over a grid, both halves of the split, and large n
for n in list(range(0, 41)) + [63, 64, 65, 100, 257]:
    for k in sorted(set([0, 1, 2, 3, 15, 16, 17, 31, 32, 33, n // 2, n // 2 + 1, n - 1, n, n + 1])):
        if k >= 0:
            print('cp', n, k, digest(math.comb(n, k)), digest(math.perm(n, k)))
for n, k in [(1000, 500), (1000, 17), (10**6, 40), (10**5, 50000), (2**70, 3), (2**70, 40), (2**70, 2**70 - 40), (2**100 + 7, 33), (12345678901234567890, 257)]:
    print('cp', n, k, show(lambda: digest(math.comb(n, k))), show(lambda: digest(math.perm(n, k))))
for n in [0, 1, 5, 20, 21, 300]:
    print('perm1', n, digest(math.perm(n)), math.perm(n, None) == math.factorial(n))
print(math.comb(30000, 15000) == math.factorial(30000) // math.factorial(15000) ** 2)
print(math.perm(30000, 12345) == math.factorial(30000) // math.factorial(30000 - 12345))

# errors and conversions, CPython's order and messages
M = 2**63 - 1
cases = [
    ('fact -1', lambda: math.factorial(-1)), ('fact -2**70', lambda: math.factorial(-2**70)), ('fact 2**63', lambda: math.factorial(2**63)),
    ('fact float', lambda: math.factorial(5.0)), ('fact str', lambda: math.factorial('5')), ('fact I', lambda: math.factorial(I(6))),
    ('fact J', lambda: math.factorial(J(6))), ('fact True', lambda: math.factorial(True)), ('fact I big', lambda: math.factorial(I(2**64))),
    ('comb -1 0', lambda: math.comb(-1, 0)), ('comb 0 -1', lambda: math.comb(0, -1)), ('comb -1 -1', lambda: math.comb(-1, -1)),
    ('comb 5 9', lambda: math.comb(5, 9)), ('comb 5 2**70', lambda: math.comb(5, 2**70)), ('comb 2**70 2**70', lambda: math.comb(2**70, 2**70)),
    ('comb 2**70 2**70-1', lambda: math.comb(2**70, 2**70 - 1)), ('comb 2**70 2**69', lambda: math.comb(2**70, 2**69)),
    ('comb 2**70 1', lambda: math.comb(2**70, 1)), ('comb 2**70 0', lambda: math.comb(2**70, 0)), ('comb 2**70 2**71', lambda: math.comb(2**70, 2**71)),
    ('comb float', lambda: math.comb(5.0, 2)), ('comb I', lambda: math.comb(I(10), I(3))), ('comb J', lambda: math.comb(J(10), J(10))),
    ('comb 2**64 2**63', lambda: math.comb(2**64, 2**63)), ('comb M+1 1', lambda: math.comb(M + 1, 1)),
    ('perm -1', lambda: math.perm(-1)), ('perm -1 None', lambda: math.perm(-1, None)), ('perm 2**63', lambda: math.perm(2**63)),
    ('perm -1 2', lambda: math.perm(-1, 2)), ('perm 2 -1', lambda: math.perm(2, -1)), ('perm 5 9', lambda: math.perm(5, 9)),
    ('perm 5 2**70', lambda: math.perm(5, 2**70)), ('perm 2**70 2**70', lambda: math.perm(2**70, 2**70)), ('perm 2**70 2**69', lambda: math.perm(2**70, 2**69)),
    ('perm 2**70 2**70+1', lambda: math.perm(2**70, 2**70 + 1)), ('perm 2**70 1', lambda: math.perm(2**70, 1)), ('perm 2**70 0', lambda: math.perm(2**70, 0)),
    ('perm I', lambda: math.perm(I(10), I(3))), ('perm float', lambda: math.perm(5, 2.0)), ('perm kw', lambda: math.perm(n=5, k=2)),
    ('comb kw', lambda: math.comb(n=5, k=2)), ('perm 2**64 2**63', lambda: math.perm(2**64, 2**63)), ('perm J', lambda: math.perm(J(4))),
]
for label, f in cases:
    print(label, show(f))
print(type(math.comb(J(10), 1)), type(math.perm(J(10), 1)), type(math.factorial(J(1))))


# math.prod: left to right, start keyword-only; the exact-int path's value
class Mul:
    log = []

    def __init__(self, s):
        self.s = s

    def __mul__(self, o):
        Mul.log.append((self.s, repr(o)))
        return Mul('(%s*%r)' % (self.s, o))

    def __rmul__(self, o):
        Mul.log.append((repr(o), self.s))
        return Mul('(%r*%s)' % (o, self.s))

    def __repr__(self):
        return self.s


def gen(xs, log):
    for x in xs:
        log.append(('yield', repr(x)))
        yield x


for label, f in [('start', lambda: math.prod([2, 3], start=5)), ('startpos', lambda: math.prod([2, 3], 5)), ('empty', lambda: math.prod([])),
                 ('bool', lambda: math.prod([True, 3, True])), ('J', lambda: math.prod([J(3), 4])), ('kwit', lambda: math.prod(iterable=[2])),
                 ('badkw', lambda: math.prod([2], begin=3)), ('none', lambda: math.prod()), ('start True', lambda: math.prod([], start=True)),
                 ('start True 3', lambda: math.prod([3], start=True)), ('start J', lambda: type(math.prod([], start=J(3)))),
                 ('start float', lambda: math.prod([2, 3], start=1.5)), ('floats', lambda: math.prod([0.1] * 7)), ('mixed', lambda: math.prod([3, 0.1, 7, 2**80])),
                 ('neg', lambda: math.prod([-3, 2**60, -5, 0])), ('negs', lambda: math.prod([-(2**40)] * 9)), ('str', lambda: math.prod([2, 'ab'])),
                 ('str3', lambda: math.prod(['ab', 3])), ('list', lambda: math.prod([2, [1], 3])), ('frac', lambda: math.prod([2, __import__('fractions').Fraction(1, 3), 3]))]:
    print('prod', label, show(f))
Mul.log = []
print('prod Mul', math.prod([2, 3, Mul('a'), 5, Mul('b'), 7]), Mul.log)
Mul.log = []
log = []
print('prod gen', math.prod(gen([2, 3, Mul('a'), 4], log), start=Mul('s')), Mul.log, log)
log = []
print('prod gen ints', math.prod(gen([2, 3, 4], log)), log)
print('prod range', digest(math.prod(range(1, 20001))), math.prod(range(1, 20001)) == math.factorial(20000))
print('prod big', digest(math.prod([2**64 + i for i in range(3000)])), digest(math.prod((3**i for i in range(2000)), start=-7)))
print('prod zero', math.prod([2**100, 0, 2**100]), math.prod(range(-5, 5)))


def bad():
    yield 2
    yield 3
    raise KeyError('mid')


print('prod raise', show(lambda: math.prod(bad())))
