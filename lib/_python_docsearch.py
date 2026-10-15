"""Python mode's functions for the notebook's search box: what Sagebrush
provides of numpy (with linalg, fft, random and polynomial), scipy.integrate
and scipy.io, math, cmath, fractions, itertools, functools, collections,
random, bisect and heapq, as JSON entries in the form of
lib/_pyjs_docsearch.py's index.

    sagebrush -m _python_docsearch --index    (web/build.ts: docs-index-python.json)
    sagebrush --search "linear system" --mode python

The significant functions have a signature, a summary and examples written
for Sagebrush (lib/_python_examples.py, whose outputs are checked by
test/python-doc-examples.test.ts and against CPython with NumPy and SciPy).
Every other public function and class of those modules is listed too, with
its docstring's first paragraph where Sagebrush's has one.
"""

import json as _json
import sys as _sys

# (index name, module to import, the attribute path in it)
MODULES = [
    ("numpy", "numpy", ""), ("numpy.linalg", "numpy", "linalg"), ("numpy.fft", "numpy", "fft"),
    ("numpy.random", "numpy", "random"), ("numpy.polynomial", "numpy", "polynomial"),
    ("scipy.integrate", "scipy.integrate", ""), ("scipy.io", "scipy.io", ""),
    ("math", "math", ""), ("cmath", "cmath", ""), ("fractions", "fractions", ""), ("itertools", "itertools", ""),
    ("functools", "functools", ""), ("collections", "collections", ""), ("random", "random", ""),
    ("bisect", "bisect", ""), ("heapq", "heapq", ""),
]


def _module(modname, attr):
    mod = __import__(modname)
    for part in modname.split(".")[1:]:
        mod = getattr(mod, part)
    if attr:
        mod = getattr(mod, attr)
    return mod


def _summary(obj):
    from _pyjs_help import _cleandoc
    doc = getattr(obj, "__doc__", None)
    if not isinstance(doc, str):
        return ""
    return _cleandoc(doc).split("\n\n")[0].replace("\n", " ")


def _prompted(code):
    """code as typed at a Python prompt: >>> before each statement, ... before
    the lines of a block (and a decorator's def), and a ... line ending it"""
    out, block = [], False
    for line in code.split("\n"):
        indented = line.startswith((" ", "\t"))
        if block and not indented and not out[-1].lstrip(". >").startswith("@"):
            out.append("...")
            block = False
        cont = block and (indented or out[-1].lstrip(". >").startswith("@"))
        out.append(("... " if cont else ">>> ") + line)
        if line.startswith("@") or line.rstrip().endswith(":") or cont:
            block = True
    if block:
        out.append("...")
    return "\n".join(out)


def _examples_text(exs):
    """a function's examples as a Python prompt shows them: the code, then
    what it prints"""
    if not exs:
        return ""
    parts = [_prompted(code) + ("\n" + output.rstrip("\n") if output else "") for code, output in exs]
    return "\n\nExamples:\n\n" + "\n\n".join(parts)


def build_index():
    """[{name, module, kind, signature, summary, doc, examples, open_problem}]
    for Python mode's libraries: the documented functions first, then the
    rest of each module's public names"""
    import _python_examples as E
    ex = E.examples()
    out = []
    seen = set()
    for name, signature, summary, codes in E.ENTRIES:
        seen.add(name)
        module = next((m for m, _, _ in sorted(MODULES, key=lambda t: -len(t[0])) if name.startswith(m + ".")), name.rsplit(".", 1)[0])
        out.append({
            "name": name,
            "module": module,
            "kind": "class" if name.rsplit(".", 1)[-1][:1].isupper() else "function",
            "signature": signature,
            "summary": summary,
            "doc": summary + _examples_text(ex.get(name, [])),
            "examples": len(ex.get(name, [])),
            "open_problem": False,
        })
    # (the documented functions' objects, for naming an alias by them)
    known = {}
    for name in [e[0] for e in E.ENTRIES] + list(E.SUMMARIES):
        index_name = next((m for m, _, _ in sorted(MODULES, key=lambda t: -len(t[0])) if name.startswith(m + ".")), None)
        if index_name is None:
            continue
        try:
            obj = getattr(_module(*next((mn, a) for i, mn, a in MODULES if i == index_name)), name[len(index_name) + 1:])
            known.setdefault(id(obj), name)
        except Exception:
            pass
    for index_name, modname, attr in MODULES:
        try:
            mod = _module(modname, attr)
        except Exception:
            continue
        for n in sorted(dir(mod)):
            full = index_name + "." + n
            if n.startswith("_") or full in seen:
                continue
            obj = getattr(mod, n, None)
            if not callable(obj) or isinstance(obj, type(_sys)):
                continue
            # (a name another module defines, imported here: not this module's)
            where = getattr(obj, "__module__", None)
            if not index_name.startswith("numpy") and isinstance(where, str) and where.split(".")[0] not in (modname.split(".")[0], "_" + modname.split(".")[0]):
                continue
            seen.add(full)
            alias = known.get(id(obj))
            summary = E.SUMMARIES.get(full) or (("Another name for %s." % alias) if alias and alias != full else _summary(obj))
            out.append({
                "name": full,
                "module": index_name,
                "kind": "class" if isinstance(obj, type) else "function",
                "signature": "",
                "summary": summary,
                "doc": summary,
                "examples": 0,
                "open_problem": False,
            })
    return out


def main(argv):
    if "--index" in argv:
        print(_json.dumps(build_index(), separators=(",", ":")))
        return 0
    print("usage: sagebrush -m _python_docsearch --index")
    return 2


if __name__ == "__main__":
    _sys.exit(main(_sys.argv[1:]))
