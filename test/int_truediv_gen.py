"""CPython's int / int, for test/int-truediv.test.ts: `python3 test/int_truediv_gen.py`
writes test/int-truediv-cpython.json, each case [a, b, repr(a / b)] with a and b as
decimal strings, or "!OverflowError".  The cases are big integers whose quotients are
subnormal, next to the subnormal and overflow thresholds, exact ties at every
precision, and ordinary ones."""

import json
import random

random.seed(20261014)
cases = []


def add(a, b):
    try:
        v = repr(a / b)
    except OverflowError:
        v = "!OverflowError"
    cases.append([str(a), str(b), v])


for _ in range(300):
    # (subnormal and tiny quotients: a/b from 2^-1080 to 2^-1000)
    e = random.randint(-1080, -1000)
    a = random.getrandbits(random.randint(1, 120)) + 1
    b = (a << -e) // random.randint(1, 1 << 20) + random.randint(0, 3)
    add(a * random.choice((1, -1)), b)
for k in range(1066, 1080):
    # (ties: (2j+1)/2^k, exactly halfway between subnormals for k >= 1075)
    for j in (0, 1, 2, 3, 10**15):
        add(2 * j + 1, 1 << k)
        add((2 * j + 1) * 3**40, 3**40 << k)
for _ in range(150):
    # (ordinary big quotients, and near overflow)
    a = random.getrandbits(random.randint(54, 1200)) + 1
    b = random.getrandbits(random.randint(54, 400)) + 1
    add(a, b)
for e in (1022, 1023, 1024, 1025):
    for d in (-1, 0, 1):
        add((1 << (e + 60)) + d, 1 << 60)
        add(((1 << 53) - 1) << (e - 52 + 60), 1 << 60)
add(((1 << 54) - 1) << 1023, 1 << 53)  # (rounds up to 2^1024: overflows)
add(1, 10**400)
add(-1, 10**400)
for b in (10**100, 2**1080, 3**700, 10**20):
    # (the sign of a zero quotient: 0 / -b and 1 / -b underflowing are -0.0)
    for sa, sb in ((1, 1), (1, -1), (-1, 1), (-1, -1)):
        add(sa * 0, sb * b)
        add(sa * 1, sb * b * 10**400)
add(10**400, 10**100)
add(-(10**400), 3)
json.dump(cases, open(__file__.replace("int_truediv_gen.py", "int-truediv-cpython.json"), "w"), indent=0)
print(len(cases), "cases")
