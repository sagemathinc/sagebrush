"""Sage's methods of the number-theoretic functions: moebius.range and
prime_pi.plot (loaded on first use from sage_all, where they are attached
to the functions moebius and prime_pi).  Their rules are Sage 10.10's,
observed as a black box."""

import math as _math


def _sa():
    import sage_all
    return sage_all


class PariError(RuntimeError):
    """The error Sage's moebius.range raises for a stop below its start
    (step 1), raised by PARI there."""


def _mu_block(a, b):
    # (mu(n) for n in [a, b), 1 <= a: a segmented sieve, blocks of 2^16, on
    # prime_range's primes up to sqrt(b))
    out = []
    ps = _sa().prime_range(_math.isqrt(max(b - 1, 1)) + 1) if b > a else []
    while a < b:
        c = min(b, a + 65536)
        mu = [1] * (c - a)
        rest = list(range(a, c))
        for p in ps:
            if p * p >= c:
                # (an n < c has at most one prime factor this large: the
                # one left in rest)
                break
            m = -a % p
            for i in range(m, c - a, p):
                mu[i] = -mu[i]
                rest[i] //= p
            q = p * p
            for i in range(-a % q, c - a, q):
                mu[i] = 0
        out.extend(-v if r > 1 else v for v, r in zip(mu, rest))
        a = c
    return out


def _mu(n):
    return 0 if n == 0 else int(_sa().moebius(abs(n)))


def moebius_range(start, stop=None, step=None):
    """The Moebius function's values at range(start, stop, step), as a list:
    moebius.range(n) is moebius at 1, 2, ..., n - 1.  The bounds and the step
    go through int(); with step 1, a stop below the start is PARI's error.

    EXAMPLES::

        sage: moebius.range(1, 11)
        [1, -1, -1, 0, -1, 1, -1, 0, 0, 1]
        sage: moebius.range(10)
        [1, -1, -1, 0, -1, 1, -1, 0, 0]
        sage: moebius.range(-5, 5), moebius.range(0, 11, 2)
        ([-1, 0, -1, -1, 1, 0, 1, -1, -1, 0], [0, -1, 0, 1, 0, 1])
    """
    if stop is None:
        start, stop = 1, start
    start, stop = int(start), int(stop)
    step = 1 if step is None else int(step)
    if step != 1:
        return [_mu(n) for n in range(start, stop, step)]
    if stop < start:
        raise PariError("vector: domain error in vector: dimension < 0")
    if _math.isqrt(max(abs(start), abs(stop))) > 4 * (stop - start) + 65536:
        # (a short window far out: factored one by one, not sieved)
        return [_mu(n) for n in range(start, stop)]
    out = []
    if start < 0:
        # (mu(-n) = mu(n): the negative part, from the block of |n|, reversed)
        out = _mu_block(1 - min(stop, 0), 1 - start)[::-1]
    if start <= 0 < stop:
        out.append(0)
    if stop > 1:
        out.extend(_mu_block(max(start, 1), stop))
    return out


def _round_even(v):
    # (prime_range's reading of a bound that is not an integer, observed:
    # rounded, a half to even)
    n = int(_sa().floor(v))
    d = 2 * (v - n)
    return n + 1 if d > 1 or (d == 1 and n % 2) else n


def prime_pi_plot(xmin=0, xmax=100, vertical_lines=True, **kwds):
    """A plot of prime_pi(x) for xmin <= x <= xmax: a step line, with the
    options given passed to line().  With vertical_lines=False, one
    horizontal segment per step.

    As in Sage 10.10, the steps are at the primes of
    prime_range(xmin + 1, xmax + 1) and at xmax, sorted together: from
    (xmin, prime_pi(xmin)) the line goes up by 1 at each of them but the
    last, where it ends.

    EXAMPLES::

        sage: P = prime_pi.plot(0, 20); P
        Graphics object consisting of 1 graphics primitive
        sage: P[0].xdata[:5], P[0].ydata[:5]
        ([0.0, 2.0, 2.0, 3.0, 3.0], [0.0, 0.0, 1.0, 1.0, 2.0])
        sage: len(prime_pi.plot(0, 20, vertical_lines=False))
        9
    """
    sa = _sa()
    from sage_plot import Graphics, line
    if xmax < xmin:
        return Graphics()
    k = int(sa.prime_pi(xmin))
    ps = sa.prime_range(max(_round_even(xmin + 1), 0), max(_round_even(xmax + 1), 0))
    at = sorted([float(p) for p in ps] + [float(xmax)])
    if not vertical_lines:
        bp = [float(xmin)] + at
        g = Graphics()
        for i in range(len(at)):
            g += line([(bp[i], float(k + i)), (bp[i + 1], float(k + i))], **kwds)
        return g
    v = [(float(xmin), float(k))]
    for x in at[:-1]:
        v += [(x, float(k)), (x, float(k + 1))]
        k += 1
    v += [(at[-1], float(k))] * 2
    return line(v, **kwds)
