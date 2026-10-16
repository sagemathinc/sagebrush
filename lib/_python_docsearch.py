"""Python mode's functions for the notebook's search box: what Sagebrush
provides of numpy (with linalg, fft, random and polynomial), scipy.integrate
and scipy.io, math, cmath, fractions, itertools, functools, collections,
random, bisect, heapq and matplotlib (pyplot, Axes, Figure), as JSON entries in the form of
lib/_pyjs_docsearch.py's index.

    sagebrush -m _python_docsearch --index    (web/build.ts: docs-index-python.json)
    sagebrush --search "linear system" --mode python

The significant functions are the catalog's entries (catalog/python/*.json,
lib/_catalog.py): a signature, a summary, examples with their output, what
differs from upstream and a status, written for Sagebrush. Every other public
function and class of those modules is listed too (public_names(); the
catalog's missing.txt), with lib/_python_examples.py's summary or its
docstring's first paragraph.
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
    # (matplotlib's pyplot, and the methods of its Axes and Figure, by matplotlib's names)
    ("matplotlib.pyplot", "matplotlib.pyplot", ""), ("matplotlib.axes.Axes", "matplotlib.pyplot", "Axes"),
    ("matplotlib.figure.Figure", "matplotlib.pyplot", "Figure"),
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


def _index_module(name):
    return next((m for m, _, _ in sorted(MODULES, key=lambda t: -len(t[0])) if name.startswith(m + ".")), name.rsplit(".", 1)[0])


def public_names():
    """Every public function and class of the modules Python mode indexes,
    by their index names (the catalog gate: each has an entry or is in
    catalog/python/missing.txt)"""
    return [e["name"] for e in _rest(set())]


def build_index():
    """[{name, module, kind, signature, summary, doc, examples, open_problem,
    ...}] for Python mode's libraries: the catalog's entries first (all their
    fields, `doc` ending with the examples as a Python prompt shows them),
    then the rest of each module's public names"""
    import _catalog
    out = []
    seen = set()
    for e in _catalog.index("python"):
        seen.add(e["name"])
        e = dict(e, module=_index_module(e["name"]))
        e["doc"] = (e.get("doc") or e["summary"]) + _examples_text([(x["code"], x["expected"]) for x in e["examples"]])
        out.append(e)
    return out + _rest(seen, [e["name"] for e in out])


def _rest(seen, documented=()):
    """The index's entries for the public names not in seen"""
    import _python_examples as E
    out = []
    # (the documented functions' objects, for naming an alias by them)
    known = {}
    for name in list(documented) + list(E.SUMMARIES):
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
                "examples": [],
                "open_problem": False,
                # (a public name with no catalog entry yet: catalog/python/missing.txt)
                "catalog": False,
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
