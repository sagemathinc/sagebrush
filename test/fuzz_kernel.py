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
import ast
import builtins
import contextlib
import io
import json
import signal
import sys
import time


def _timeout(*_):
    raise TimeoutError("cell took more than 2 s")


signal.signal(signal.SIGALRM, _timeout)


# page-order scoping's renamed definitions get their names back, as the
# notebook's interpreter does (src/rename.ts restoreDefNames, RENAME_HELPER)
def _sb_rename(o, n, old):
    if getattr(o, "__name__", None) != old:
        return
    try:
        o.__name__ = n
    except Exception:
        return

    def fix(v, seen):
        for f in (v, getattr(v, "__func__", None), getattr(v, "fget", None), getattr(v, "fset", None), getattr(v, "fdel", None)):
            q = getattr(f, "__qualname__", None)
            if isinstance(q, str) and (q == old or q.startswith(old + ".")):
                try:
                    f.__qualname__ = n + q[len(old):]
                except Exception:
                    pass
        if isinstance(v, type) and v not in seen:
            seen.add(v)
            for w in list(vars(v).values()):
                fix(w, seen)

    fix(o, set())


builtins.__sb_rename__ = _sb_rename
DEFS = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)


def restore(tree, scoped):
    def fix(stmts):
        out = []
        for st in stmts:
            if not isinstance(st, DEFS):
                for key in ("body", "orelse", "finalbody"):
                    if isinstance(getattr(st, key, None), list):
                        setattr(st, key, fix(getattr(st, key)))
                for h in getattr(st, "handlers", None) or []:
                    h.body = fix(h.body)
                for c in getattr(st, "cases", None) or []:
                    c.body = fix(c.body)
            out.append(st)
            if isinstance(st, DEFS) and st.name in scoped:
                call = ast.Expr(ast.Call(ast.Name("__sb_rename__", ast.Load()), [ast.Name(st.name, ast.Load()), ast.Constant(scoped[st.name]), ast.Constant(st.name)], []))
                for n in ast.walk(call):
                    n.lineno = n.end_lineno = st.end_lineno
                    n.col_offset = n.end_col_offset = st.end_col_offset
                out.append(call)
        return out

    tree.body = fix(tree.body)
    return tree


def fresh():
    return {"__name__": "__main__", "__builtins__": __builtins__}


def run(code, g, scoped=None):
    buf = io.StringIO()
    err = None
    t = time.perf_counter()
    try:
        signal.alarm(2)
        with contextlib.redirect_stdout(buf):
            tree = ast.parse(code, "<cell>")
            if scoped:
                restore(tree, scoped)
            exec(compile(tree, "<cell>", "exec"), g)
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
        r = run(m["code"], ns, m.get("scoped"))
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
