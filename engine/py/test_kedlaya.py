"""Stop during Kedlaya's Frobenius matrix in the CPython package
(plan-kedlaya-optin r6 section 6): E.padic_lseries(p).frobenius(prec) has no
default work limit, so Stop is its control.  At each of four stages, a
reader thread waits until the progress snapshot shows that stage with done
> 0, then interrupts the main thread (as Ctrl-C does); the main thread must
see KeyboardInterrupt within 1 s, the progress slot must be released, and a
later call must be right.  And the ledger's own table here is CPython's.

    python engine/py/test_kedlaya.py
"""
import _thread
import sys
import threading
import time

from sagebrush import progress
from sagebrush.sage import EllipticCurve

CASES = [("setup: Q^p", 4001, 2, 1), ("series", 5, 400, 3),
         # (the plan's p = 401, prec 3 for stage 4 reduces in 0.2 s here, under
         # progress's 250 ms write interval, and its p = 4001 reaches stage 6
         # only after its series, hours in; at p = 1013, prec 1 stage 6 lasts
         # 0.35 s, and on CI ended once before a write showed done > 0; at
         # p = 2003, prec 1 stage 4 lasts 2.2 s and stage 6 1.4 s, reached at
         # 21 s)
         ("reduce dx/y", 2003, 1, 4), ("check: setup Q^p", 2003, 1, 6)]

failed = 0
for what, p, prec, stage in CASES:
    L = EllipticCurve("27a1").padic_lseries(p)
    sent = []

    def watch():
        deadline = time.time() + 600
        while time.time() < deadline:
            for r in progress.snapshot():
                if r["op"] == "padic_lseries.frobenius" and r.get("stage_index") == stage and r["count"]["done"] > 0:
                    sent.append(time.time())
                    _thread.interrupt_main()
                    return
            time.sleep(0.002)

    t = threading.Thread(target=watch, daemon=True)
    t.start()
    try:
        L.frobenius(prec)
        result = "finished before the Stop"
    except KeyboardInterrupt:
        got = time.time()
        result = "interrupted"
    t.join()
    ok = result == "interrupted" and sent and got - sent[0] < 1.0
    left = progress.snapshot()
    phi = EllipticCurve("14a1").padic_lseries(5).frobenius(5)
    ok = ok and left == [] and str(phi.det()) == "5^-1 + O(5^4)"
    print("%-4s Stop in stage %d (%s), p = %d, prec %d: %s, %s after Stop; slots left %d; later call %s"
          % ("ok" if ok else "FAIL", stage, what, p, prec, result,
             "%.0f ms" % ((got - sent[0]) * 1000) if sent and result == "interrupted" else "-", len(left), phi.det()))
    failed += not ok

import _sage_padic_lseries as K  # noqa: E402  (the package's library path)
eng = K._kd_engine()
print("%-4s the ledger's table: %s" % ("ok" if eng == "cpython" else "FAIL", eng))
failed += eng != "cpython"
sys.exit(1 if failed else 0)
