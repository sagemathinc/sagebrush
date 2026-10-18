"""Run by Sage's own Python (sage -python sage_driver.py) for sagebrush bench:
Sage as a black box, through its public Python interface only.

One JSON request per line: {"setup": code, "call": expression, "answer":
expression in r, "repeat": n}. setup runs in a namespace with sage.all's
names; call is timed as in _timing.sample (imported from this directory, so
the procedure is the same); answer, with r its last value, gives the answer.
The reply is one JSON line {"times", "calls", "answer"} or {"error"}, then
END."""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _timing  # noqa: E402

from sage.all import *  # noqa: E402,F401,F403

import _bench_common  # noqa: E402

NS = dict(globals())
NS.update(vars(_bench_common))

for line in sys.stdin:
    if not line.strip():
        continue
    try:
        req = json.loads(line)
        ns = dict(NS)
        exec(req.get("setup", ""), ns)
        f = eval("lambda: " + req["call"], ns)
        t = _timing.sample(f, int(req["repeat"]))  # (sage.all has a sample of its own)
        ns["r"] = t.answer
        reply = {"times": t.times, "calls": t.calls, "answer": eval(req["answer"], ns)}
    except Exception as x:  # reported, never fatal
        reply = {"error": f"{type(x).__name__}: {x}"[:500]}
    print(json.dumps(reply))
    print("END", flush=True)
