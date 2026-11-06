"""The paper's longer code, beside it: paper.tex's SageTeX blocks import it with `from helper import ...`
(Sagebrush runs a document's code in the document's own folder, as SageTeX does)."""

from math import isqrt


def pell(d, count):
    """The first `count` solutions (x, y) of x^2 - d y^2 = 1 in positive integers, for a d that is not a
    square: the fundamental one from the continued fraction of sqrt(d) (the first convergent p/q with
    p^2 - d q^2 = 1), then the rest from it, (x + y sqrt(d))^k."""
    a0 = isqrt(d)
    m, q, a = 0, 1, a0
    p0, p1, q0, q1 = 1, a0, 0, 1
    while p1 * p1 - d * q1 * q1 != 1:
        m = q * a - m
        q = (d - m * m) // q
        a = (a0 + m) // q
        p0, p1 = p1, a * p1 + p0
        q0, q1 = q1, a * q1 + q0
    x1, y1 = p1, q1
    out = [(x1, y1)]
    while len(out) < count:
        x, y = out[-1]
        out.append((x1 * x + d * y1 * y, x1 * y + y1 * x))
    return out


def collatz_steps(n):
    """How many steps n takes to reach 1 under n -> n/2 (even), 3n + 1 (odd)."""
    steps = 0
    while n != 1:
        n = n // 2 if n % 2 == 0 else 3 * n + 1
        steps += 1
    return steps
