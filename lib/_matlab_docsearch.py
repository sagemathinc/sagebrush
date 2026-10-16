"""The MATLAB front end's functions for the notebook's search box: every
built-in function MATLAB code can call, with the summary and text of its
docstring, as JSON entries in the form of lib/_pyjs_docsearch.py's index.

    sagebrush -m _matlab_docsearch --index    (web/build.ts: docs-index-matlab.json)

A built-in is found in _matlab._B, the table calls are looked up in; its text
is the docstring of the Python function behind it, where it has one.
"""

import json as _json
import sys as _sys

# (the modules whose functions are MATLAB's built-ins: _matlab imports the others)
MODULES = ["_matlab", "_matlab_numeric", "_matlab_data", "_matlab_sparse", "_matlab_plot", "_matlab_mat", "_matlab_files"]


def _clean(doc):
    from _pyjs_help import _cleandoc
    return _cleandoc(doc or "")


def _builtins():
    import _matlab
    for modname in MODULES:
        try:
            __import__(modname)
        except Exception:
            pass
    return _matlab._B


def public_names():
    """Every built-in function MATLAB code can call (the catalog gate: each has
    an entry or is in catalog/matlab/missing.txt)"""
    return sorted(n for n in _builtins() if not n.startswith("_"))


def build_index():
    """[{name, module, kind, signature, summary, doc, examples, open_problem,
    ...}] for MATLAB's built-ins: the catalog's entries first (all their
    fields, `doc` ending with the examples after the prompt >>), then the
    other built-ins, by name"""
    import _catalog
    out = []
    seen = set()
    for e in _catalog.index("matlab"):
        seen.add(e["name"])
        e = dict(e, module="matlab")
        e["doc"] = (e.get("doc") or e["summary"]) + _examples_text([(x["code"], x["expected"]) for x in e["examples"]])
        out.append(e)
    return out + _rest(seen)


def _rest(seen):
    """The index's entries for the built-ins not in seen: their docstrings, and
    the examples lib/_matlab_examples.py still holds"""
    B = _builtins()
    from _matlab_examples import examples
    ex = examples()
    out = []
    for name in sorted(B):
        if name.startswith("_") or name in seen:
            continue
        clean = _clean(getattr(B[name].f, "__doc__", None))
        doc = clean + _examples_text(ex.get(name, []))
        out.append({
            "name": name,
            "module": "matlab",
            "kind": "function",
            "signature": "",
            "summary": clean.split("\n\n")[0].replace("\n", " "),
            "doc": doc,
            "examples": len(ex.get(name, [])),
            "open_problem": False,
        })
    return out


def _examples_text(exs):
    """a function's examples as its documentation shows them: each line of
    code after MATLAB's prompt >>, then what it prints (lib/_matlab_examples.py)"""
    if not exs:
        return ""
    parts = []
    for code, output in exs:
        parts.append("\n".join(">> " + line for line in code.split("\n")) + "\n" + output.rstrip("\n"))
    return "\n\nExamples:\n\n" + "\n\n".join(parts)


def main(argv):
    if "--index" in argv:
        print(_json.dumps(build_index(), separators=(",", ":")))
        return 0
    print("usage: sagebrush -m _matlab_docsearch --index")
    return 2


if __name__ == "__main__":
    _sys.exit(main(_sys.argv[1:]))
