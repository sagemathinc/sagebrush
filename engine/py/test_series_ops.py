"""The series ops (sagebrush.poly.series_mul, series_pow, series_euler,
sigma_table) against Sage, used as an oracle: fixtures/series_ops_sage.json
holds exact polynomial products and powers truncated at q^n over Z and Q,
the Euler product and sigma(m, k), computed by Sage (its version is the
fixture's "source").  Over Q the coefficients come back in
lowest terms, as Sage prints them; raw=True gives the unreduced numerators
and denominator, checked to be the same values.

    python engine/py/test_series_ops.py
"""
import json
import os
from fractions import Fraction

import sagebrush.poly as P

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    with open(os.path.join(HERE, "fixtures", "series_ops_sage.json")) as f:
        fx = json.load(f)
    bad = []
    for i, c in enumerate(fx["cases"]):
        op = c["op"]
        if op == "mul":
            a, b = [int(x) for x in c["a"]], [int(x) for x in c["b"]]
            da, db = int(c["da"]), int(c["db"])
            got = P.series_mul(a, b, c["n"], da=da, db=db)
            num, den = P.series_mul(a, b, c["n"], da=da, db=db, raw=True)
            if [Fraction(x, den) for x in num] != [Fraction(v) for v in c["want"]]:
                bad.append((i, op, "raw"))
        elif op == "pow":
            a, da = [int(x) for x in c["a"]], int(c["da"])
            got = P.series_pow(a, c["k"], c["n"], da=da)
            num, den = P.series_pow(a, c["k"], c["n"], da=da, raw=True)
            if [Fraction(x, den) for x in num] != [Fraction(v) for v in c["want"]]:
                bad.append((i, op, "raw"))
        elif op == "euler":
            got = P.series_euler(c["n"])
        else:
            got = P.sigma_table(c["k"], c["n"])
        if [str(x) for x in got] != c["want"]:
            bad.append((i, op, [str(x) for x in got][:6], c["want"][:6]))
    # refusals name the limit
    for call, needle in [(lambda: P.series_mul([1], [1], 10**6), "131072"),
                         (lambda: P.series_pow([1, 1], -1, 3), "series inverse"),
                         (lambda: P.sigma_table(2 * 10**6, 3), "smaller k")]:
        try:
            call()
            bad.append(("accepted", needle))
        except ValueError as e:
            if needle not in str(e):
                bad.append((needle, str(e)))
    for b in bad:
        print("MISMATCH", b)
    assert not bad, "%d cases differ from Sage" % len(bad)
    print("series ops against Sage (%s): %d cases ok" % (fx["source"], len(fx["cases"])))


if __name__ == "__main__":
    main()
