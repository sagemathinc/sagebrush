"""Matrix and vector shapes, matrix powers, and entries converted into ZZ
and QQ (strings included), in Sage mode, against Sage's own answers recorded
once (Sage run as a black-box oracle; fixtures/matrix_checks_sage.json): the
same result, or the same exception type and message.  Each case was once a
silent wrong answer or a different error (a 2 x 2 plus a 3 x 3 matrix was a
2 x 2 matrix; A^(1/2) was the identity; a string was kept as an entry of a
matrix over QQ).

    python engine/py/test_matrix_checks.py
"""
import json
import os

import sagebrush.sage as S

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = json.load(open(os.path.join(HERE, "fixtures", "matrix_checks_sage.json")))


def main():
    ns = {k: getattr(S, k) for k in S.__all__}
    exec(DATA["setup"], ns)
    bad = []
    for want in DATA["cases"]:
        c = want["case"]
        try:
            r = eval(c, ns)
            got = {"ok": True, "str": str(r)}
        except Exception as e:  # noqa: BLE001 (the exception is the answer)
            got = {"ok": False, "exc": type(e).__name__, "msg": str(e)}
        if want["ok"] != got["ok"] or (want["ok"] and want["str"] != got["str"]) or (
                not want["ok"] and (want["exc"], want["msg"]) != (got["exc"], got["msg"])):
            bad.append((c, want, got))
    for c, want, got in bad:
        print("MISMATCH", c, "\n  Sage:", want, "\n  here:", got)
    assert not bad, "%d of %d cases differ from Sage" % (len(bad), len(DATA["cases"]))
    # a refusal of a long malformed string is short: a preview and the length
    huge = "1" * 4000000 + "x"
    for c in ("QQ(huge)", "ZZ(huge)", "matrix(QQ, [[huge]])", "matrix(ZZ, [[huge]])", "vector(QQ, [huge])", "vector(ZZ, [huge])"):
        try:
            eval(c, dict(ns, huge=huge))
        except TypeError as e:
            assert len(str(e)) < 300 and "4000001 characters" in str(e), (c, str(e)[:300])
        else:
            raise AssertionError(c + " must be refused")
    print("matrix checks against Sage: %d cases ok" % len(DATA["cases"]))


if __name__ == "__main__":
    main()
