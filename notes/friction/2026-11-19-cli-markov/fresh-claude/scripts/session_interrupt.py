"""Stop/state test via the PyPI wheel's documented sagebrush.session.Session."""
import json, time, queue
from sagebrush.session import Session

out = {}
S = Session()
try:
    r = S.run("P = matrix(QQ, [[1/2,1/4,1/4,0],[1/5,1/2,1/10,1/5],[0,0,1,0],[0,0,0,1]]); keep = P^5; print(keep[0,0])", timeout=60)
    out["setup"] = r
    gen, q, rid = S.submit("import time; T0=time.time(); s=0\nfor i in range(10^9): s += i")  # bounded (~minutes), interrupted below
    time.sleep(2)
    t0 = time.time()
    S.interrupt()
    msgs = []
    deadline = time.time() + 30
    while time.time() < deadline:
        try:
            m = q.get(timeout=1)
        except queue.Empty:
            continue
        msgs.append(m)
        if isinstance(m, dict) and (m.get("done") or "error" in m or m.get("type") in ("done", "result", "error")):
            break
    out["interrupt_latency_s"] = round(time.time() - t0, 2)
    out["interrupt_msgs"] = [repr(m)[:400] for m in msgs[-3:]]
    out["after"] = S.run("print(keep[0,0], P.nrows(), 'i=', i, 'elapsed=', round(time.time()-T0,1))", timeout=30)
    out["newcalc"] = S.run("print((identity_matrix(QQ,2) - P[0:2,0:2]).inverse())", timeout=30)
    out["alive"] = S.alive()
finally:
    S.close()
print(json.dumps(out, indent=1, default=repr))
