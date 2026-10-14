#!/usr/bin/env python3
"""Generate LMFDB fixtures for the Hilbert modular forms engine (tests only).

Source: the LMFDB (https://www.lmfdb.org/ModularForm/GL2/TotallyReal/),
field 2.2.5.1 = Q(sqrt 5), w^2 = w + 1, through LMFDB's public read-only
PostgreSQL mirror. Its host and read-only credentials are documented by the
LMFDB (Postgres_FAQ.md in github.com/LMFDB/lmfdb); pass them through the
usual libpq variables, e.g.

    PGHOST=... PGUSER=... PGPASSWORD=... PGDATABASE=lmfdb \\
        python3 engine/hmf/tests/fixtures/lmfdb.py

No credentials are stored in this repository. LMFDB data is licensed under
CC BY-SA (see NOTICE.md, "Data"); these files are test fixtures and are not
shipped.

Outputs:

lmfdb-2.2.5.1-newdims.txt, one line per ideal N of norm <= 4999
(the LMFDB's range for this field, complete per Donnelly-Voight 2016):

    norm a b c newdim

where (a, b, c) is the Hermite normal form Z a + Z (b + c w) of N and
newdim = dim S_2^new(N) = the sum of the dimensions of the newform orbits
of level N.

lmfdb-2.2.5.1-orbits.txt, for every level N of norm <= 4999 with newforms:

    a b c | d_1 d_2 ...

the dimensions of its newform orbits, sorted.

lmfdb-2.2.5.1-rational.txt, for every rational newform (orbit of dimension
1) of level norm <= RATIONAL_LEVEL_NORM:

    label | a b c | pa pb pc:a_P ...

its eigenvalues a_P at the primes P of norm <= RATIONAL_PRIME_NORM (at P | N
the LMFDB's value, related to the Atkin-Lehner eigenvalue).

lmfdb-2.2.5.1-hecke.txt, for every level N of norm <= HECKE_LEVEL_NORM and
every prime P of norm <= HECKE_PRIME_NORM not dividing N, and for P = N
when N is prime (then T_P is U_P):

    a b c | pa pb pc | f_0 f_1 ... f_d

with (pa, pb, pc) the HNF of P and f the characteristic polynomial of T_P on
S_2^new(N) over Q (constant term first): the product over the newform orbits
of level N of the characteristic polynomial of a_P, which the LMFDB gives as
a polynomial in a root e of the orbit's Hecke polynomial.
"""

import datetime
import os
import re
import subprocess
import sys

FIELD = "2.2.5.1"
HERE = os.path.dirname(os.path.abspath(__file__))

Q_IDEALS = f"select ideals from hmf_fields where label = '{FIELD}'"
RATIONAL_LEVEL_NORM = 1831  # Bober et al. 2012 tabulated curves up to here
RATIONAL_PRIME_NORM = 50
Q_ORBITS = (
    "select level_ideal, dimension from hmf_forms "
    f"where field_label = '{FIELD}' and weight = '[2, 2]' and level_norm <= 4999"
)
Q_RATIONAL = (
    "select f.label, f.level_ideal, h.hecke_eigenvalues from hmf_forms f "
    "join hmf_hecke h on h.label = f.label "
    f"where f.field_label = '{FIELD}' and f.weight = '[2, 2]' and f.dimension = 1 "
    f"and f.level_norm <= {RATIONAL_LEVEL_NORM}"
)
HECKE_LEVEL_NORM = 1000
HECKE_PRIME_NORM = 30
Q_PRIMES = f"select primes from hmf_fields where label = '{FIELD}'"
Q_HECKE = (
    "select f.level_ideal, h.hecke_polynomial, h.hecke_eigenvalues from hmf_forms f "
    "join hmf_hecke h on h.label = f.label "
    f"where f.field_label = '{FIELD}' and f.weight = '[2, 2]' and f.level_norm <= {HECKE_LEVEL_NORM}"
)
Q_DIMS = (
    "select level_ideal, sum(dimension) from hmf_forms "
    f"where field_label = '{FIELD}' and weight = '[2, 2]' group by level_ideal"
)


def psql(query, tries=4):
    import time

    for attempt in range(tries):
        r = subprocess.run(["psql", "-X", "-A", "-t", "-F", "\t", "-c", query], capture_output=True, text=True)
        if r.returncode == 0:
            break
        if attempt == tries - 1:
            sys.exit(f"psql failed: {r.stderr.strip()}")
        time.sleep(10)  # the mirror's DNS name sometimes fails to resolve
    out = r.stdout
    return [line.split("\t") for line in out.splitlines() if line]


def parse_w(s):
    """'-5*w + 2' -> (2, -5), meaning 2 - 5w."""
    s = s.replace(" ", "")
    a = b = 0
    for sign, coef, w in re.findall(r"([+-]?)(\d*)\*?(w?)", s):
        if not coef and not w:
            continue
        c = int(coef) if coef else 1
        if sign == "-":
            c = -c
        if w:
            b += c
        else:
            a += c
    return a, b


def xgcd(a, b):
    r0, r1, s0, s1, t0, t1 = a, b, 1, 0, 0, 1
    while r1:
        q = r0 // r1
        r0, r1 = r1, r0 - q * r1
        s0, s1 = s1, s0 - q * s1
        t0, t1 = t1, t0 - q * t1
    return (-r0, -s0, -t0) if r0 < 0 else (r0, s0, t0)


def hnf(a, b):
    """HNF (A, B, C) of the principal ideal (a + b w), as field::Hnf."""
    x1, y1 = a, b  # g
    x2, y2 = b, a + b  # g w
    c, s, t = xgcd(y1, y2)
    bx = s * x1 + t * x2
    ax = abs((y2 // c) * x1 - (y1 // c) * x2)
    return ax, bx % ax, c


def ideal_hnf(label):
    # LMFDB ideal strings are "[norm, least integer, generator]"
    norm, _, gen = label.strip("[]").split(",", 2)
    h = hnf(*parse_w(gen))
    assert h[0] * h[2] == int(norm), (label, h)
    return int(norm), h


def parse_poly(s, var):
    """'1/2*e^2 - e - 3/2' -> Fraction coefficients, constant term first."""
    from fractions import Fraction

    s = str(s).replace(" ", "").replace("-", "+-")
    coeffs = {}
    for term in filter(None, s.split("+")):
        if var in term:
            c, _, rest = term.partition(var)
            c = c.rstrip("*")
            c = Fraction(1) if c in ("", "+") else Fraction(-1) if c == "-" else Fraction(c)
            k = int(rest[1:]) if rest.startswith("^") else 1
        else:
            c, k = Fraction(term), 0
        coeffs[k] = coeffs.get(k, 0) + c
    n = max(coeffs) if coeffs else 0
    return [coeffs.get(k, Fraction(0)) for k in range(n + 1)]


def charpoly_of_element(a, f):
    """Characteristic polynomial over Q of a(e) in Q[e]/(f(e)), f monic:
    Faddeev-LeVerrier on the matrix of multiplication by a."""
    from fractions import Fraction

    d = len(f) - 1

    def mulmod(u, v):
        w = [Fraction(0)] * (len(u) + len(v) - 1)
        for i, x in enumerate(u):
            for j, y in enumerate(v):
                w[i + j] += x * y
        for k in range(len(w) - 1, d - 1, -1):
            c = w[k]
            if c:
                for t in range(d + 1):
                    w[k - d + t] -= c * f[t]
        return (w + [Fraction(0)] * d)[:d]

    cols = [mulmod(a, [Fraction(0)] * j + [Fraction(1)]) for j in range(d)]
    A = [[cols[j][i] for j in range(d)] for i in range(d)]
    c = [Fraction(0)] * (d + 1)
    c[d] = Fraction(1)
    M = [[Fraction(0)] * d for _ in range(d)]
    for k in range(1, d + 1):
        AM = [[sum(A[i][t] * M[t][j] for t in range(d)) for j in range(d)] for i in range(d)]
        M = [[AM[i][j] + (c[d - k + 1] if i == j else 0) for j in range(d)] for i in range(d)]
        AM = [[sum(A[i][t] * M[t][j] for t in range(d)) for j in range(d)] for i in range(d)]
        c[d - k] = -sum(AM[i][i] for i in range(d)) / k
    assert all(x.denominator == 1 for x in c), "a_P is not integral"
    return [int(x) for x in c]


def polymul(u, v):
    w = [0] * (len(u) + len(v) - 1)
    for i, x in enumerate(u):
        for j, y in enumerate(v):
            w[i + j] += x * y
    return w


def hecke_fixture():
    import json

    primes = json.loads(psql(Q_PRIMES)[0][0])
    allp = [(i, ideal_hnf(s)) for i, s in enumerate(primes)]
    index = {h: i for i, (n, h) in allp}
    pl = [(i, h) for i, (n, h) in allp if n <= HECKE_PRIME_NORM]
    table = {}
    for level, poly, eigs in psql(Q_HECKE):
        _, h = ideal_hnf(level)
        f = parse_poly(poly, "x")
        assert f[-1] == 1
        eigs = json.loads(eigs)
        # at a prime level P = N, also a_P (the eigenvalue of U_P)
        extra = [(index[h], h)] if h in index and all(ph != h for _, ph in pl) else []
        for i, ph in pl + extra:
            # P divides N exactly when N is contained in P; of those, only
            # P = N (prime levels) is kept
            if contains(ph, h) and ph != h:
                continue
            g = charpoly_of_element(parse_poly(eigs[i], "e"), f)
            key = (h, ph)
            table[key] = polymul(table.get(key, [1]), g)
    path = os.path.join(HERE, f"lmfdb-{FIELD}-hecke.txt")
    with open(path, "w") as out:
        out.write(f"# LMFDB (https://www.lmfdb.org), field {FIELD}, weight [2, 2]; CC BY-SA, tests only\n")
        out.write(f"# generated {datetime.date.today().isoformat()} by engine/hmf/tests/fixtures/lmfdb.py\n")
        out.write(f"# query: {Q_PRIMES}\n# query: {Q_HECKE}\n")
        out.write("# level HNF | prime HNF | charpoly of T_P on S_2^new(N), constant term first\n")
        for (h, ph), g in sorted(table.items()):
            out.write(f"{h[0]} {h[1]} {h[2]} | {ph[0]} {ph[1]} {ph[2]} | {' '.join(map(str, g))}\n")
    print(f"wrote {len(table)} (level, prime) pairs to {path}")


def header(out, *queries):
    out.write(f"# LMFDB (https://www.lmfdb.org), field {FIELD}, weight [2, 2]; CC BY-SA, tests only\n")
    out.write(f"# generated {datetime.date.today().isoformat()} by engine/hmf/tests/fixtures/lmfdb.py\n")
    for q in queries:
        out.write(f"# query: {q}\n")


def orbit_fixture():
    orbits = {}
    for level, d in psql(Q_ORBITS):
        orbits.setdefault(ideal_hnf(level)[1], []).append(int(d))
    path = os.path.join(HERE, f"lmfdb-{FIELD}-orbits.txt")
    with open(path, "w") as out:
        header(out, Q_ORBITS)
        out.write("# level HNF | dimensions of the newform orbits\n")
        for h, ds in sorted(orbits.items()):
            out.write(f"{h[0]} {h[1]} {h[2]} | {' '.join(map(str, sorted(ds)))}\n")
    print(f"wrote {len(orbits)} levels to {path}")


def rational_fixture():
    import json

    primes = json.loads(psql(Q_PRIMES)[0][0])
    pl = [(i, ideal_hnf(s)) for i, s in enumerate(primes)]
    pl = [(i, h) for i, (n, h) in pl if n <= RATIONAL_PRIME_NORM]
    rows = []
    for label, level, eigs in psql(Q_RATIONAL):
        eigs = json.loads(eigs)
        h = ideal_hnf(level)[1]
        aps = " ".join(f"{ph[0]} {ph[1]} {ph[2]}:{int(eigs[i])}" for i, ph in pl)
        rows.append((h[0] * h[2], label, h, aps))
    rows.sort()
    path = os.path.join(HERE, f"lmfdb-{FIELD}-rational.txt")
    with open(path, "w") as out:
        header(out, Q_PRIMES, Q_RATIONAL)
        out.write("# label | level HNF | prime HNF:a_P ...\n")
        for _, label, h, aps in rows:
            out.write(f"{label} | {h[0]} {h[1]} {h[2]} | {aps}\n")
    print(f"wrote {len(rows)} rational newforms to {path}")


def contains(big, small):
    """Whether the ideal with HNF small is contained in the one with HNF big."""
    a, b, c = big
    def mem(x, y):
        return y % c == 0 and (x - (y // c) * b) % a == 0
    sa, sb, sc = small
    return mem(sa, 0) and mem(sb, sc)


def main():
    import json

    hecke_fixture()
    orbit_fixture()
    rational_fixture()

    ideals = json.loads(psql(Q_IDEALS)[0][0])
    dims = {}
    for level, d in psql(Q_DIMS):
        dims[ideal_hnf(level)[1]] = dims.get(ideal_hnf(level)[1], 0) + int(d)
    rows = []
    seen = set()
    for label in ideals:
        norm, h = ideal_hnf(label)
        if norm > 4999 or h in seen:
            continue
        seen.add(h)
        rows.append((norm, h, dims.pop(h, 0)))
    if dims:
        sys.exit(f"levels with forms but missing from the ideal list: {sorted(dims)[:5]}")
    rows.sort()
    path = os.path.join(HERE, f"lmfdb-{FIELD}-newdims.txt")
    with open(path, "w") as f:
        f.write(f"# LMFDB (https://www.lmfdb.org), field {FIELD}, weight [2, 2]; CC BY-SA, tests only\n")
        f.write(f"# generated {datetime.date.today().isoformat()} by engine/hmf/tests/fixtures/lmfdb.py\n")
        f.write(f"# query: {Q_IDEALS}\n# query: {Q_DIMS}\n")
        f.write("# norm a b c newdim  (N = Z a + Z (b + c w))\n")
        for norm, (a, b, c), d in rows:
            f.write(f"{norm} {a} {b} {c} {d}\n")
    print(f"wrote {len(rows)} levels to {path}")


if __name__ == "__main__":
    main()
