"""Write imagquad.txt and realquad.txt, the discriminants of the quadratic
class group suites (python3 make_quad.py, from this directory):

    imagquad: D = -p for the first primes p = 3 (mod 4) above 10^k
    realquad: D = p for the first primes p = 1 (mod 4) above 10^k

Each line is "k D tier"; the tier says which runs include it (quick, standard
or large: see sagebrush.bench).  Primality is sagebrush.nf.is_prime's; the
files are committed, so a run never depends on it."""

from sagebrush.nf import is_prime


def first_primes(k, r, count):
    p, out = 10**k + 1, []
    while len(out) < count:
        if p % 4 == r and is_prime(p):
            out.append(p)
        p += 2
    return out


# (k, how many, tier); the first discriminant of a quick k is quick, the rest
# standard
IMAG = [(k, 5, "standard") for k in range(9, 24, 2)]
IMAG += [(k, 3, "standard") for k in range(25, 36, 2)]
IMAG += [(k, 1, "large") for k in range(37, 48, 2)]
IMAG_QUICK = {9, 13, 17, 21, 25, 29}
REAL = [(k, 3, "standard") for k in (9, 13, 17, 21, 25, 29, 31, 33, 35, 37, 39, 41)]
REAL_QUICK = {9, 17, 25, 29}


def write(name, spec, quick, r, sign, header):
    with open(name, "w") as f:
        f.write(header)
        for k, count, tier in spec:
            for i, p in enumerate(first_primes(k, r, count)):
                t = "quick" if i == 0 and k in quick else tier
                f.write(f"{k} {sign * p} {t}\n")


if __name__ == "__main__":
    write("imagquad.txt", IMAG, IMAG_QUICK, 3, -1,
          "# k D tier: D = -p, p the first primes = 3 mod 4 above 10^k (make_quad.py)\n")
    write("realquad.txt", REAL, REAL_QUICK, 1, 1,
          "# k D tier: D = p, p the first primes = 1 mod 4 above 10^k (make_quad.py)\n")
