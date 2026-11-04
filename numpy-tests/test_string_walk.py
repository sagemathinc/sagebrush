# String arrays, every operation: each ndarray member, and each numpy function, on string
# arrays is either handled, with NumPy's result, or refused (it raises), never a different
# answer. NumPy's outcomes are recorded in string_walk.json (python3 test_string_walk.py --write,
# under NumPy itself); under NumPy this program checks that record is current, under Sagebrush
# that each call matches it or raises. Only differences are printed, so the output is the same.
import json
import os
import re
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
RECORD = os.path.join(HERE, "string_walk.json")
REAL = not hasattr(np, "_np")  # (Sagebrush's numpy has its core module as _np)


def letters():
    return np.array([["b", "a", "ccc"], ["dd", "a", "e"]])


def digits():
    return np.array([["1", "22", "3"], ["4", "5", "66"]])


def line():
    return np.array(["b", "a", "\U0001F600", "ccc", "a", ""])


def one():
    return np.array("abc")


def show(r):
    # a result as text: arrays and scalars by repr, an iterator by its items; addresses dropped
    if isinstance(r, (np.ndarray, np.generic, str, int, float, complex, bool, type(None), np.dtype, bytes)):
        return re.sub(r" at 0x[0-9a-f]+", "", repr(r))
    if isinstance(r, (tuple, list)):
        return "(" + ", ".join(show(x) for x in r) + ")"
    if hasattr(r, "__next__"):
        return "iter" + show(list(r))
    return "<%s>" % type(r).__name__


# the members not walked: object's own protocol, the same for every array (not an operation
# on its elements), and methods that write files
SKIP = {"__class__", "__delattr__", "__dir__", "__doc__", "__getattribute__", "__init__", "__init_subclass__",
        "__new__", "__reduce__", "__reduce_ex__", "__setattr__", "__sizeof__", "__subclasshook__", "__setstate__",
        "__getstate__", "__class_getitem__", "dump", "tofile", "__hash__", "__array_priority__"}
STR = ["a", np.array(["a", "dd", "e"]), ["b", "a", "ccc"], 1, None, np.array([1, 2, 3])]
# each member's calls: argument tuples (default: no arguments); a fixture of digits where given
CALLS = {
    "__getitem__": [(0,), ((0, 1),), (slice(None, None, -1),), ([1, 0],), (np.array([True, False]),), (Ellipsis,),
                    ((0, [2, 0]),), (None,), ("a",), ((slice(None), 1),)],
    "__setitem__": [(0, "zz"), ((0, 1), 5), ((slice(None), 0), ["p", "q"]), (Ellipsis, "x"), ((1, 2), 2.5)],
    "__contains__": [("a",), ("z",), (1,)],
    "reshape": [(3, 2), ((6,),), (-1,), (2, 3, 1)],
    "transpose": [(), (1, 0)],
    "swapaxes": [(0, 1)],
    "sort": [(), (0,)],
    "argsort": [(), (0,), (None,)],
    "fill": [("z",), (7,)],
    "item": [(), (0,), (1, 2)],
    "take": [([0, 2],), ([0, 2], 1)],
    "repeat": [(2,), (2, 0)],
    "searchsorted": [("b",)],
    "put": [([0], ["q"])],
    "clip": [("a", "c")],
    "astype": ["digits", (str,), ("U1",), ("U5",), (int,), (float,), (bool,), (complex,), (np.uint8,), (np.float32,), (np.int8,)],
    "setflags": [(False,)],
    "view": [()],
    "__format__": [("",), ("s",)],
}
for name in ("__eq__", "__ne__", "__lt__", "__le__", "__gt__", "__ge__"):
    CALLS[name] = [(x,) for x in STR]
for name in ("__add__", "__radd__", "__mul__", "__rmul__", "__mod__", "__rmod__", "__sub__", "__truediv__",
             "__iadd__", "__imul__", "__and__", "__matmul__", "__pow__", "__divmod__"):
    CALLS[name] = [("a",), (1,), (np.array([["x"]]),)]

# numpy functions, with these calls (default: the array alone); the rest of the module isn't data
FN_SKIP = {"save", "savez", "savez_compressed", "savetxt", "load", "loadtxt", "genfromtxt", "fromfile", "memmap",
           "info", "show_config", "show_runtime", "set_printoptions", "printoptions", "setbufsize", "seterr",
           "seterrcall", "errstate", "test", "get_include", "lookfor", "source", "who", "disp",
           "set_string_function", "get_printoptions", "getbufsize", "geterr", "geterrcall", "typename",
           "deprecate", "deprecate_with_doc", "add_newdoc", "add_docstring", "add_newdoc_ufunc", "broadcast",
           "nditer", "nested_iters", "ndindex", "ndenumerate", "busdaycalendar", "vectorize", "frompyfunc",
           "piecewise", "apply_along_axis", "apply_over_axes", "fromfunction", "memmap", "recarray", "chararray",
           "matrix", "asmatrix", "bmat", "poly1d", "ufunc", "flatiter", "dtype", "ndarray", "generic"}
FN_CALLS = {
    "concatenate": [(0,), (1,)],
    "stack": [(0,)],
    "where": [("where",)],
    "isin": [("isin",)],
    "unique": [("plain",), ("counts",)],
    "full": [("full",)],
    "full_like": [("full_like",)],
    "array": [("plain",), ("U1",), ("U9",)],
    "asarray": [("plain",), ("U1",)],
}


def fn_call(name, spec, a):
    f = getattr(np, name)
    if name in ("concatenate", "stack"):
        return f([a, a], axis=spec[0])
    if name == "where":
        return f(a == "a", a, "zz")
    if name == "isin":
        return f(a, ["a", "e", 1])
    if name == "unique":
        return f(a, return_counts=True, return_index=True, return_inverse=True) if spec[0] == "counts" else f(a)
    if name == "full":
        return f((2, 2), "xy")
    if name == "full_like":
        return f(a, "xyzw")
    if name in ("array", "asarray"):
        return f(a) if spec[0] == "plain" else f(a, dtype=spec[0])
    if spec[0] == "pair":
        return f(a, a)
    if spec[0] == "number":
        return f(a, 2)
    return f(a)


def outcome(run):
    try:
        return "R " + show(run())
    except BaseException as e:  # (a refusal, an error, or numpy's own warning-as-error)
        return "E %s: %s" % (type(e).__name__, str(e)[:200])


def walk():
    out = {}
    names = sorted(n for n in dir(np.ndarray) if n not in SKIP)
    for name in names:
        calls = CALLS.get(name, [()])
        fixes = [digits, line, one] if calls and calls[0] == "digits" else [letters, line, one]
        for fix, args in [(f, c) for f in fixes for c in calls if c != "digits"]:
            def run(name=name, args=args, fix=fix):
                a = fix()
                m = getattr(a, name)
                r = m(*args) if callable(m) else m
                if r is NotImplemented:
                    # (an operator's "not mine": Python then tries the other operand, or raises)
                    raise TypeError("NotImplemented")
                if name == "flat":
                    r = list(r)
                return show(r) + " | " + show(a)
            out["m %s(%s)%s" % (name, fix.__name__, show(args))] = outcome(run)
    for name in sorted(n for n in dir(np) if not n.startswith("_") and n not in FN_SKIP and callable(getattr(np, n))):
        if isinstance(getattr(np, name), type) and not issubclass(getattr(np, name), np.generic):
            continue
        for fix in (letters, digits):
            for spec in FN_CALLS.get(name, [("plain",), ("pair",), ("number",)]):
                out["f %s(%s)%s" % (name, fix.__name__, show(spec))] = outcome(lambda: fn_call(name, spec, fix()))
    return out


# (an internal failure is not a refusal: words of JavaScript in an error)
JS = re.compile(r"of undefined|undefined is|is not a function|Cannot read prop|internal error|RangeError|SyntaxError|ReferenceError")
# Differences that aren't about strings: arguments NumPy checks and Sagebrush doesn't yet (an
# array's order=, nan_to_num's copy=, lexsort's axis=), the same for numeric arrays, with no
# wrong answer; longlong's arrays, int64 here, shown without NumPy's dtype=int64; and a 0-d
# array's format with a spec, the same text, a str where CPython's str.__format__ returns the np.str_
ALLOW = re.compile(r"^f (copy|ravel|nan_to_num|lexsort)\((letters|digits)\)\('(pair|number)'\)$|^f longlong\(digits\)\('plain'\)$"
                   r"|^m __format__\(one\)\('s'\)$")

if REAL and "--write" in sys.argv:
    with open(RECORD, "w") as f:
        json.dump(walk(), f, indent=0, sort_keys=True)
    sys.exit(0)
with open(RECORD) as f:
    want = json.load(f)
got = walk()
handled = 0
for key in sorted(want):
    w, g = want[key], got.get(key)
    if REAL:
        if g != w:
            print("STALE", key, "now", g)
        continue
    if g is None:
        # (a member or function Sagebrush doesn't have: refused)
        continue
    if g.startswith("E "):
        if JS.search(g):
            print("CRASH", key, g)
        continue
    if g != w and not ALLOW.match(key):
        print("DIFFERENT", key, "numpy:", w, "| sagebrush:", g)
    else:
        handled += 1
# (a name NumPy 2 doesn't have, which Sagebrush keeps for NumPy 1's programs, isn't walked)
print("walked %d calls" % len(want))
sys.stderr.write("handled %d\n" % handled)
