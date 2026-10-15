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


def build_index():
    """[{name, module, kind, signature, summary, doc, examples, open_problem}]
    for MATLAB's built-ins, by name"""
    import _matlab
    for modname in MODULES:
        try:
            __import__(modname)
        except Exception:
            pass
    out = []
    for name in sorted(_matlab._B):
        if name.startswith("_"):
            continue
        clean = _clean(getattr(_matlab._B[name].f, "__doc__", None))
        out.append({
            "name": name,
            "module": "matlab",
            "kind": "function",
            "signature": "",
            "summary": clean.split("\n\n")[0].replace("\n", " "),
            "doc": clean,
            "examples": 0,
            "open_problem": False,
        })
    return out


def main(argv):
    if "--index" in argv:
        print(_json.dumps(build_index(), separators=(",", ":")))
        return 0
    print("usage: sagebrush -m _matlab_docsearch --index")
    return 2


if __name__ == "__main__":
    _sys.exit(main(_sys.argv[1:]))
