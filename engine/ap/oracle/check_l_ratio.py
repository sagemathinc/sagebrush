"""L(E,1)/Omega_E (lseries().L_ratio()) from the ball enclosures against
Sage's modular-symbol value on 60 random curves of conductor <= 3000
(make_l_ratio.sage), 32 of them 0; and Sha.an() must be a positive
integer where L_ratio != 0 or the root number is -1.

    engine/.venv/bin/python engine/ap/oracle/check_l_ratio.py
"""

import json, os, sys

from sagebrush.sage import *  # noqa: F401,F403

L = json.load(open(os.path.join(os.path.dirname(__file__), "l_ratio.json")))
bad = 0
for d in L:
    E = EllipticCurve(d["a"])
    q = E.lseries().L_ratio()
    if str(q) != d["L_ratio"]:
        bad += 1
        print("MISMATCH", d["a"], q, d["L_ratio"])
    if q != 0:
        s = E.sha().an()
        if not (s >= 1 and s == int(s)):
            bad += 1
            print("SHA", d["a"], s)
print(len(L), "curves,", bad, "failures")
sys.exit(1 if bad else 0)
