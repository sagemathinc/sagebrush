"""MATLAB function files on the path: name.m in the program's folder (or a
folder on sys.path) defines the function `name`, as in MATLAB.  The host
(the CLI, a notebook) translates the file to Python (src/matlab.ts)."""

import builtins as _builtins
import os as _os
import sys as _sys


def load(name):
    """the function in name.m, or None"""
    host = getattr(_builtins, "__pyjs_host__", None)
    if host is None:
        return None
    for d in list(_sys.path):
        p = _os.path.join(d, name + ".m")
        try:
            if not _os.path.isfile(p):
                continue
            with open(p) as fh:
                src = fh.read()
        except OSError:
            continue
        py = host("matlab_function_file", src, p)
        if py is None:
            return None
        import _matlab as _m
        ns = {"__name__": "_matlab_file_" + name}
        exec(py, ns)
        # (MATLAB names the function by its file; the file's first function)
        for v in ns.values():
            if type(v) is _m.Function:
                return v
        return None
    return None
