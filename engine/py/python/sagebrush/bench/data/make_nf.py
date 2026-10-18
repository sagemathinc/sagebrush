"""Write nf-fields.txt, the fields of the nf suite (python3 make_nf.py, from
this directory): random monic irreducible f = x^n + a_{n-1} x^{n-1} + ...
+ a_0 of degree 3 to 6, for each (degree, exponent e) below the first one
whose polynomial discriminant has |disc f| in [10^e, 10^(e+1)), drawn with a
fixed seed.

Each line is "degree e tier a_0,a_1,...,a_{n-1},1" (coefficients from the
constant term, as sagebrush.nf.bnf takes them). The field discriminant can
be smaller than disc f by a square; both engines report it. The file is
committed, so a run never depends on this script."""

import random

SEED = 20261018

# (degree, e, tier): sizes like those of the old table in
# engine/classgroup/README.md (cubics 10^12 to 10^32, quartics to 10^41,
# quintics and sextics to 10^23 and beyond)
TARGETS = [
    (3, 8, "quick"), (3, 12, "quick"), (3, 16, "standard"), (3, 20, "standard"),
    (3, 24, "standard"), (3, 28, "standard"), (3, 28, "standard"), (3, 32, "standard"),
    (3, 32, "standard"),
    (4, 12, "quick"), (4, 18, "standard"), (4, 22, "standard"), (4, 26, "standard"),
    (4, 30, "standard"), (4, 34, "standard"), (4, 36, "large"), (4, 41, "large"),
    (5, 12, "quick"), (5, 16, "standard"), (5, 20, "standard"), (5, 23, "standard"),
    (5, 27, "large"),
    (6, 12, "quick"), (6, 16, "standard"), (6, 20, "standard"), (6, 23, "standard"),
    (6, 26, "large"), (6, 30, "large"),
    (3, 36, "large"), (4, 24, "standard"),
]


def det(m):
    """The determinant of a square integer matrix (Bareiss)."""
    m = [row[:] for row in m]
    n, sign, prev = len(m), 1, 1
    for k in range(n - 1):
        if m[k][k] == 0:
            for i in range(k + 1, n):
                if m[i][k]:
                    m[k], m[i], sign = m[i], m[k], -sign
                    break
            else:
                return 0
        for i in range(k + 1, n):
            for j in range(k + 1, n):
                m[i][j] = (m[i][j] * m[k][k] - m[i][k] * m[k][j]) // prev
        prev = m[k][k]
    return sign * m[n - 1][n - 1]


def disc(f):
    """The discriminant of the monic f (coefficients from the constant
    term): (-1)^(n(n-1)/2) Res(f, f')."""
    n = len(f) - 1
    g = [i * f[i] for i in range(1, n + 1)]
    a, b = f[::-1], g[::-1]  # leading coefficient first
    size = 2 * n - 1
    rows = [[0] * i + a + [0] * (size - len(a) - i) for i in range(n - 1)]
    rows += [[0] * i + b + [0] * (size - len(b) - i) for i in range(n)]
    return (-1) ** (n * (n - 1) // 2) * det(rows)


def irreducible(f):
    from sagebrush import poly

    _, fs = poly.factor(f)
    return len(fs) == 1 and fs[0][1] == 1


def draw(rng, n, e):
    """The first f (from rng) with |disc f| in [10^e, 10^(e+1)), adjusting
    the coefficient bound B as it goes."""
    b = 2
    while True:
        f = [rng.randint(-b, b) for _ in range(n)] + [1]
        d = abs(disc(f))
        if d == 0 or f[0] == 0:
            continue
        digits = len(str(d)) - 1
        if digits < e:
            b += max(1, b // 8)
        elif digits > e:
            b = max(2, b - max(1, b // 8))
        elif irreducible(f):
            return f


if __name__ == "__main__":
    rng = random.Random(SEED)
    with open("nf-fields.txt", "w") as out:
        out.write(f"# degree e tier f: random monic f with |disc f| in [10^e, 10^(e+1)), seed {SEED} (make_nf.py)\n")
        for n, e, tier in TARGETS:
            f = draw(rng, n, e)
            out.write(f"{n} {e} {tier} {','.join(map(str, f))}\n")
