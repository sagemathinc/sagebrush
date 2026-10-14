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

Output: lmfdb-2.2.5.1-newdims.txt, one line per ideal N of norm <= 4999
(the LMFDB's range for this field, complete per Donnelly-Voight 2016):

    norm a b c newdim

where (a, b, c) is the Hermite normal form Z a + Z (b + c w) of N and
newdim = dim S_2^new(N) = the sum of the dimensions of the newform orbits
of level N.
"""

import datetime
import os
import re
import subprocess
import sys

FIELD = "2.2.5.1"
HERE = os.path.dirname(os.path.abspath(__file__))

Q_IDEALS = f"select ideals from hmf_fields where label = '{FIELD}'"
Q_DIMS = (
    "select level_ideal, sum(dimension) from hmf_forms "
    f"where field_label = '{FIELD}' and weight = '[2, 2]' group by level_ideal"
)


def psql(query):
    out = subprocess.run(
        ["psql", "-X", "-A", "-t", "-F", "\t", "-c", query],
        check=True, capture_output=True, text=True,
    ).stdout
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


def main():
    import json

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
