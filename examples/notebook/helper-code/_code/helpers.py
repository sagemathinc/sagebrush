"""The notebook's longer functions, kept out of its cells. The notebook imports them with
`from _code import helpers`: _code/ is a package (it has __init__.py), in the notebook's own folder."""


def sieve(n):
    """The primes up to n, by the sieve of Eratosthenes."""
    if n < 2:
        return []
    is_prime = [True] * (n + 1)
    is_prime[0] = is_prime[1] = False
    for p in range(2, int(n**0.5) + 1):
        if is_prime[p]:
            for k in range(p * p, n + 1, p):
                is_prime[k] = False
    return [p for p in range(n + 1) if is_prime[p]]


def factor(n):
    """n's prime factors, smallest first, with repeats (trial division)."""
    out, p = [], 2
    while p * p <= n:
        while n % p == 0:
            out.append(p)
            n //= p
        p += 1 if p == 2 else 2
    if n > 1:
        out.append(n)
    return out


def collatz_length(n):
    """How many steps n takes to reach 1 under n -> n/2 (even), 3n + 1 (odd)."""
    steps = 0
    while n != 1:
        n = n // 2 if n % 2 == 0 else 3 * n + 1
        steps += 1
    return steps


def fermat_numbers():
    """F_0 .. F_5 (2^(2^k) + 1), read from the data file beside the notebook: data/fermat.txt."""
    with open("data/fermat.txt") as f:
        return [int(line) for line in f if line.strip() and not line.startswith("#")]
