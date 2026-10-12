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


# page-order scoping's renamed definitions are made under their written names
# and moved, as the notebook's interpreter does (src/rename.ts
# restoreDefNames, RENAME_HELPER)
def _sb_lowering():
    missing = object()
    saved = []

    def push(g, w):
        saved.append((w, g.get(w, missing)))

    def pop(g, w, n):
        g[n] = g[w]
        while saved:
            sw, v = saved.pop()
            if sw == w:
                break
        else:
            return
        if v is missing:
            g.pop(w, None)
        else:
            g[w] = v

    return push, pop


builtins.__sb_push__, builtins.__sb_pop__ = _sb_lowering()
DEFS = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)


def restore(tree, scoped):
    if not scoped:
        return tree
    import re
    pat = re.compile("(?<![\\w\u02b9])(" + "|".join(re.escape(k) for k in scoped) + ")(?![\\w\u02b9])")

    def written(t):
        return pat.sub(lambda m: scoped[m.group(1)], t)

    for n in ast.walk(tree):
        if isinstance(n, ast.JoinedStr) or type(n).__name__ == "TemplateStr":
            for v in n.values:
                if isinstance(v, ast.Constant) and isinstance(v.value, str):
                    v.value = written(v.value)
        if type(n).__name__ == "Interpolation" and isinstance(getattr(n, "str", None), str):
            n.str = written(n.str)

    def call(fn, args, node, end):
        c = ast.Expr(ast.Call(ast.Name(fn, ast.Load()), [ast.Call(ast.Name("globals", ast.Load()), [], [])] + [ast.Constant(a) for a in args], []))
        for m in ast.walk(c):
            m.lineno = m.end_lineno = node.end_lineno if end else node.lineno
            m.col_offset = m.end_col_offset = node.end_col_offset if end else node.col_offset
        return c

    def fix(stmts, globs):
        out = []
        for st in stmts:
            if not isinstance(st, DEFS):
                for key in ("body", "orelse", "finalbody"):
                    if isinstance(getattr(st, key, None), list):
                        setattr(st, key, fix(getattr(st, key), globs))
                for h in getattr(st, "handlers", None) or []:
                    h.body = fix(h.body, globs)
                for c in getattr(st, "cases", None) or []:
                    c.body = fix(c.body, globs)
            elif not isinstance(st, ast.ClassDef):
                gs = []

                def scan(n):
                    if isinstance(n, ast.Global):
                        gs.append(n)
                    if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
                        return
                    for c in ast.iter_child_nodes(n):
                        scan(c)

                for b in st.body:
                    scan(b)
                st.body = fix(st.body, gs)
            declared = globs is None or any(st.name in g.names for g in globs) if isinstance(st, DEFS) else False
            if isinstance(st, DEFS) and declared and st.name in scoped:
                internal, w = st.name, scoped[st.name]
                st.name = w
                for g in globs or []:
                    if internal in g.names and w not in g.names:
                        g.names.append(w)
                out += [call("__sb_push__", [w], st, False), st, call("__sb_pop__", [w, internal], st, True)]
            else:
                out.append(st)
        return out

    tree.body = fix(tree.body, None)
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
