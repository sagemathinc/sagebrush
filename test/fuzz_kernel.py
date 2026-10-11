"""A CPython interpreter for test/fuzz-reactive.ts, over JSON lines on
stdin/stdout:

  {"op": "reset"}                        a fresh namespace for the notebook
  {"op": "exec", "code": ..., "forget": [...]}
                                         delete the names, run the code in it
  {"op": "forget", "names": [...]}       delete the names
  {"op": "ref", "cells": [...]}          the reference: the cells top to
                                         bottom in a namespace of their own

Each run answers {"out": printed text, "err": "Type: message" or null, "ms"}.
"""
import contextlib
import io
import json
import signal
import sys
import time


def _timeout(*_):
    raise TimeoutError("cell took more than 2 s")


signal.signal(signal.SIGALRM, _timeout)


def fresh():
    return {"__name__": "__main__", "__builtins__": __builtins__}


def run(code, g):
    buf = io.StringIO()
    err = None
    t = time.perf_counter()
    try:
        signal.alarm(2)
        with contextlib.redirect_stdout(buf):
            exec(compile(code, "<cell>", "exec"), g)
    except BaseException as e:  # (SyntaxError and TimeoutError too)
        err = f"{type(e).__name__}: {e}"
    finally:
        signal.alarm(0)
    return {"out": buf.getvalue(), "err": err, "ms": (time.perf_counter() - t) * 1000}


ns = fresh()
for line in sys.stdin:
    m = json.loads(line)
    op = m["op"]
    if op == "reset":
        ns = fresh()
        r = {}
    elif op == "exec":
        for k in m.get("forget", []):
            ns.pop(k, None)
        r = run(m["code"], ns)
    elif op == "forget":
        for k in m["names"]:
            ns.pop(k, None)
        r = {}
    elif op == "ref":
        g = fresh()
        r = {"cells": [run(c, g) for c in m["cells"]]}
    else:
        r = {"error": f"unknown op {op}"}
    sys.stdout.write(json.dumps(r) + "\n")
    sys.stdout.flush()
